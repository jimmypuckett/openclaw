import os from "node:os";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { githubRepositoryUrl } from "../agents/github-host.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import type {
  createPublicationCommandRunner,
  runPublicationCommand,
} from "./forge-publication-command.js";
import { publicationPushArgs } from "./forge-publication-git.js";
import { parseGitHubPublicationBaseRef } from "./github-publication-base.js";
import {
  hasUnapprovedGitHubPublicationWorkflowChanges,
  isGitHubPublicationWorkflowPath,
} from "./github-publication-workflows.js";

export function githubPublicationApiArgs(
  endpoint: string,
  method = "GET",
  host = "github.com",
): string[] {
  return [
    "gh",
    "api",
    "--hostname",
    host,
    "--method",
    method,
    endpoint,
    ...(method === "GET" ? [] : ["--input", "-"]),
  ];
}

export async function readGitHubPublicationBaseSha(
  run: ReturnType<typeof createPublicationCommandRunner>["run"],
  repository: string,
  branch: string,
  host: string,
  env: NodeJS.ProcessEnv,
) {
  const result = await run(
    [
      "gh",
      "api",
      "--hostname",
      host,
      `repos/${repository}/git/ref/heads/${branch}`,
      "--jq",
      "{ref: .ref, sha: .object.sha}",
    ],
    { env },
  );
  if (result.code !== 0) {
    throw new Error("GitHub publication workspace base branch could not be verified.");
  }
  return parseGitHubPublicationBaseRef(result.stdout.toString("utf8"), branch);
}

export async function requireGitHubPublicationCommit(
  run: ReturnType<typeof createPublicationCommandRunner>["run"],
  repository: string,
  sha: string,
  host: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  failure: string,
  options: { contents?: boolean; commitPresent?: boolean } = {},
) {
  const fetch = async (missing?: string[]) => {
    const result = await run(
      [
        ...GITHUB_CREDENTIAL_ARGS,
        "-c",
        `core.hooksPath=${os.devNull}`,
        "-c",
        "core.fsmonitor=false",
        "fetch",
        "--no-auto-maintenance",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        ...(missing ? ["--refetch", "--stdin"] : []),
        "--",
        githubRepositoryUrl(repository, host),
        ...(missing ? [] : [sha]),
      ],
      { cwd, env, ...(missing ? { input: `${missing.join("\n")}\n` } : {}) },
    );
    if (result.code !== 0) {
      // This diagnostic reaches both receipt readers and recovery warnings. Remove
      // whole remote URLs before truncation, including unrecognized query credentials.
      const detail = truncateUtf8Prefix(
        redactToolPayloadText(
          sanitizeForLog(result.stderr.toString("utf8").replace(/[\r\n\t]+/gu, " ")).replace(
            /\b[a-z][a-z\d+.-]*:\/\/\S+/giu,
            "[redacted URL]",
          ),
        ).trim(),
        1_024,
      );
      throw new Error(detail ? `${failure} Git fetch: ${detail}` : failure);
    }
  };
  if (!options.commitPresent) {
    // Fetching a present non-promisor commit still makes Git enumerate every
    // promisor object for connectivity. Probe the physical commit without lazy
    // fetching or trusting commit-graph metadata; content hydration stays below.
    const present = await run(
      [
        "git",
        "-c",
        "core.commitGraph=false",
        "rev-list",
        "--missing=allow-any",
        "--no-walk",
        `${sha}^{commit}`,
      ],
      { cwd, env },
    );
    if (present.code !== 0 || !present.stdout.toString("utf8").trim()) {
      await fetch();
    }
  }
  if (!options.contents) {
    return;
  }
  const missingObjects = async () => {
    const result = await run(
      [
        "git",
        "rev-list",
        "--objects",
        "--missing=print",
        "--no-object-names",
        "--max-count=1",
        sha,
      ],
      {
        cwd,
        env: { ...env, GIT_NO_LAZY_FETCH: "1" },
        maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES,
      },
    );
    if (result.code !== 0) {
      throw new Error(failure);
    }
    return result.stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
  };
  const missing = await missingObjects();
  if (missing.length) {
    // A known partial-clone commit can still lack its tree contents after fetch.
    // Hydrate through the selected authenticated URL before any offline snapshots.
    await fetch(missing);
    if ((await missingObjects()).length) {
      throw new Error(failure);
    }
  }
}

// A recursive tree listing scales with repository size (openclaw itself is
// ~3.3MB), far past the default per-command cap above. Without this explicit
// bound the attribute scan dies as an output-limit "verification" failure on
// any real repository.
const TREE_LISTING_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function hasGitHubPublicationWorkflowChanges(params: {
  cwd: string;
  comparisonCommit: string;
  ancestryCommit: string;
  targetCommit: string;
  workspaceTree: string;
  run: typeof runPublicationCommand;
}): Promise<boolean> {
  const trees = new Map<string, Promise<Map<string, string>>>();
  const workflows = (tree: string) =>
    getOrCreatePromise(trees, tree, async () => {
      const listing = await params.run(
        ["git", "ls-tree", "-r", "-z", "--full-tree", tree, "--", ".github/workflows"],
        { cwd: params.cwd, maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES },
      );
      if (listing.code !== 0) {
        throw new Error("GitHub publication workspace workflows could not be verified.");
      }
      const entries = new Map<string, string>();
      for (const record of listing.stdout.toString("latin1").split("\0").filter(Boolean)) {
        const tab = record.indexOf("\t");
        const [mode, , sha] = record.slice(0, tab).split(" ");
        if (tab < 0 || !mode || !sha) {
          throw new Error("GitHub publication workspace workflows could not be verified.");
        }
        const file = record.slice(tab + 1);
        if (isGitHubPublicationWorkflowPath(file)) {
          entries.set(file, mode + ":" + sha);
        }
      }
      return entries;
    });
  const [before, accepted] = await Promise.all([
    workflows(params.comparisonCommit),
    workflows(params.workspaceTree),
  ]);
  return await hasUnapprovedGitHubPublicationWorkflowChanges({
    before,
    accepted,
    readUpstream: async () => {
      const result = await params.run(
        ["git", "merge-base", "--all", params.ancestryCommit, params.targetCommit],
        { cwd: params.cwd },
      );
      if (result.code !== 0) {
        throw new Error("GitHub publication workflow ancestry could not be verified.");
      }
      const bases = result.stdout.toString("utf8").trim().split(/\s+/u);
      if (bases.length !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(bases[0]!)) {
        return undefined;
      }
      const [ancestor, target] = await Promise.all([
        workflows(bases[0]!),
        workflows(params.targetCommit),
      ]);
      return { ancestor, target };
    },
  });
}

const GITHUB_CREDENTIAL_ARGS = [
  "git",
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
] as const;

export function githubPublicationPushArgs(
  remote: string,
  headCommit: string,
  branch: string,
  expectedRemoteHead: string,
): string[] {
  return [
    ...GITHUB_CREDENTIAL_ARGS,
    "-c",
    `core.hooksPath=${os.devNull}`,
    ...publicationPushArgs(remote, headCommit, branch, expectedRemoteHead),
  ];
}

export function githubPublicationRemoteHeadArgs(remote: string, branch: string): string[] {
  return [...GITHUB_CREDENTIAL_ARGS, "ls-remote", "--refs", remote, `refs/heads/${branch}`];
}
