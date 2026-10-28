import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorktreeGitPolicy } from "../agents/worktrees/checkout-git-config.js";
import { splitNullBuffer } from "../agents/worktrees/git-path-inventory.js";
import { hasErrnoCode } from "../infra/errno.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createPublicationCommandRunner,
  runPublicationCommand,
  type GitCommandOptions,
  type GitCommandResult,
} from "./forge-publication-command.js";
import { publicationUnsafeConfigArgs } from "./forge-publication-git-config.js";

// Real repository listings exceed the ordinary command output cap.
const TREE_LISTING_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function assertSafeGitPublicationWorkspace(
  cwd: string,
  run: (argv: string[], options?: Omit<GitCommandOptions, "input">) => Promise<GitCommandResult>,
): Promise<void> {
  const isolatedConfig = {
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
  };
  const [localUnsafe, worktreeConfig] = await Promise.all([
    run(publicationUnsafeConfigArgs("--local"), { cwd, env: isolatedConfig }),
    run(
      ["git", "config", "--local", "--includes", "--bool", "--get", "extensions.worktreeConfig"],
      { cwd, env: isolatedConfig },
    ),
  ]);
  const worktreeConfigValue = worktreeConfig.stdout.toString("utf8").trim();
  const worktreeConfigKnown =
    (worktreeConfig.code === 0 &&
      (worktreeConfigValue === "true" || worktreeConfigValue === "false")) ||
    (worktreeConfig.code === 1 && worktreeConfig.stdout.length === 0);
  if (localUnsafe.code !== 1 || localUnsafe.stdout.length > 0 || !worktreeConfigKnown) {
    throw new Error("Publication workspace has unsupported Git transport configuration.");
  }
  const worktreeUnsafe =
    worktreeConfigValue === "true"
      ? await run(publicationUnsafeConfigArgs("--worktree"), {
          cwd,
          env: isolatedConfig,
        })
      : undefined;
  if (worktreeUnsafe && (worktreeUnsafe.code !== 1 || worktreeUnsafe.stdout.length > 0)) {
    throw new Error("Publication workspace has unsupported Git transport configuration.");
  }
  const [replacements, graftPath] = await Promise.all([
    run(["git", "for-each-ref", "--count=1", "--format=%(refname)", "refs/replace"], { cwd }),
    run(["git", "rev-parse", "--git-path", "info/grafts"], { cwd }),
  ]);
  if (replacements.code !== 0 || replacements.stdout.length > 0 || graftPath.code !== 0) {
    throw new Error("Publication workspace has unsupported Git replacement metadata.");
  }
  const grafts = await readOptionalAttributeFile(
    path.resolve(cwd, graftPath.stdout.toString("utf8").trim()),
  );
  if (grafts && grafts.length > 0) {
    throw new Error("Publication workspace has unsupported Git replacement metadata.");
  }
}

function assertNoGitFilterAttributes(contents: Buffer): void {
  for (const line of contents.toString("latin1").split(/\r?\n/u)) {
    const fields = line.trimStart().split(/[\t ]+/u);
    if (!fields[0] || fields[0].startsWith("#")) {
      continue;
    }
    if (fields.slice(1).some((field) => /^(?:-|!)?filter(?:=|$)/u.test(field))) {
      throw new Error("Publication workspace uses an unsupported Git clean filter.");
    }
  }
}

async function readOptionalAttributeFile(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function readPublicationTree(
  cwd: string,
  workspaceTree: string,
  run: (argv: string[], options?: Omit<GitCommandOptions, "input">) => Promise<GitCommandResult>,
): Promise<Buffer> {
  const listing = await run(["git", "ls-tree", "-r", "-z", "--full-tree", workspaceTree], {
    cwd,
    maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES,
  });
  if (listing.code !== 0) {
    throw new Error("Publication workspace tree could not be verified.");
  }
  return listing.stdout;
}

async function assertPublicationTreeHasNoFilters(
  cwd: string,
  workspaceTree: string,
  run: (argv: string[], options?: Omit<GitCommandOptions, "input">) => Promise<GitCommandResult>,
): Promise<void> {
  const listing = await readPublicationTree(cwd, workspaceTree, run);
  const attributeObjects = new Set<string>();
  for (const record of listing.toString("latin1").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const file = record.slice(tab + 1).toLowerCase();
    if (file !== ".gitattributes" && !file.endsWith("/.gitattributes")) {
      continue;
    }
    const objectId = record.slice(0, tab).split(" ")[2];
    if (objectId) {
      attributeObjects.add(objectId);
    }
  }
  if (attributeObjects.size > 1024) {
    throw new Error("Publication workspace has too many Git attribute files.");
  }
  for (const objectId of attributeObjects) {
    const blob = await run(["git", "cat-file", "blob", objectId], { cwd });
    if (blob.code !== 0) {
      throw new Error("Publication workspace attributes could not be verified.");
    }
    assertNoGitFilterAttributes(blob.stdout);
  }

  const infoPath = await run(["git", "rev-parse", "--git-path", "info/attributes"], {
    cwd,
  });
  if (infoPath.code !== 0) {
    throw new Error("Publication workspace attributes could not be verified.");
  }
  const attributeFiles = await Promise.all(
    ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"].map(
      async (name) => await run(["git", "var", name], { cwd }),
    ),
  );
  if (attributeFiles.some((result) => result.code !== 0)) {
    throw new Error("Publication workspace attributes could not be verified.");
  }
  const paths = [
    path.resolve(cwd, infoPath.stdout.toString("utf8").trim()),
    ...attributeFiles.flatMap((result) =>
      result.stdout.length > 0 ? [result.stdout.toString("utf8").trim()] : [],
    ),
  ];
  for (const file of paths) {
    const contents = await readOptionalAttributeFile(file);
    if (contents) {
      assertNoGitFilterAttributes(contents);
    }
  }
}

export async function capturePublicationWorkspaceSnapshot(params: {
  cwd: string;
  assertCurrent?: () => void;
}): Promise<{ sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string }> {
  const pendingMerge = await runPublicationCommand(
    ["git", "rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: params.cwd, beforeRun: params.assertCurrent },
  );
  params.assertCurrent?.();
  if (pendingMerge.code === 0) {
    throw new Error(
      "Workspace base integration is pending. Resolve its conflicts and complete the merge before tests, review, and publication.",
    );
  }
  if (pendingMerge.code !== 1) {
    throw new Error(
      "Workspace base integration state could not be verified; inspect the merge before retrying publication.",
    );
  }
  const context = captureOpenClawStateWorkerContext();
  const { withSettledLocalWorkspacePath } =
    await import("./worker-environments/local-workspace-projection.js");
  return await withSettledLocalWorkspacePath(params, async (custody) => {
    const admittedPaths = await custody?.canonicalPaths?.();
    const bound = {
      ...params,
      assertCurrent: () => {
        context.admission.assertCurrent();
        params.assertCurrent?.();
        custody?.assertCurrent();
      },
    };
    const [{ readLiveRegistryWorktreeByPath }, { withManagedWorktreeGit }, { getRuntimeConfig }] =
      await Promise.all([
        import("../agents/worktrees/registry-read.js"),
        import("../agents/worktrees/checkout-policy.js"),
        import("../config/config.js"),
      ]);
    const record = await readLiveRegistryWorktreeByPath(context, params.cwd);
    bound.assertCurrent();
    return record
      ? await withManagedWorktreeGit(
          {
            record,
            env: process.env,
            getConfig: getRuntimeConfig,
            beforeRun: bound.assertCurrent,
          },
          (git) =>
            captureSettledPublicationWorkspaceSnapshot(
              bound,
              git.sourceOnly ? git : undefined,
              admittedPaths,
            ),
        )
      : await captureSettledPublicationWorkspaceSnapshot(bound, undefined, admittedPaths);
  });
}

export async function captureSettledPublicationWorkspaceSnapshot(
  params: {
    cwd: string;
    assertCurrent?: () => void;
  },
  policy?: WorktreeGitPolicy,
  admittedPaths?: ReadonlySet<string>,
): Promise<{ sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string }> {
  const { step, require: command } = createPublicationCommandRunner(params.assertCurrent);
  const git = (args: string[], env?: NodeJS.ProcessEnv, input?: string | Buffer) =>
    policy
      ? step(() =>
          policy.require(params.cwd, args, { env, input, beforeRun: params.assertCurrent }),
        )
      : command(
          ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args],
          {
            cwd: params.cwd,
            env,
            input,
          },
        );
  await step(() => assertSafeGitPublicationWorkspace(params.cwd, runPublicationCommand));
  const sourceHeadCommit = await command(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: params.cwd,
  });
  const index = path.resolve(params.cwd, await git(["rev-parse", "--git-path", "index"]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-publication-snapshot-"));
  try {
    const env = {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      GIT_INDEX_FILE: path.join(tempDir, "index"),
    };
    // Preserve staged path inventory, and keep write-tree cache updates off the real index.
    const indexStat = await step(() => fs.stat(index, { bigint: true }));
    await step(() => fs.copyFile(index, env.GIT_INDEX_FILE));
    // A newer copy timestamp hides racy-clean edits. Round down so lost precision only adds reads.
    const indexTimestamp = Number(indexStat.mtimeNs / 1_000_000_000n);
    await step(() => fs.utimes(env.GIT_INDEX_FILE, indexTimestamp, indexTimestamp));
    const sourceIndexTree = await git(["write-tree"], env);
    // Ordinary staging preserves unchanged blobs; renormalization would rewrite unrelated CRLF files.
    await git(["-c", `core.attributesFile=${os.devNull}`, "add", "-A"], env);
    let workspaceTree = await git(["write-tree"], env);
    if (admittedPaths) {
      // Staging must not turn guest-edited ignore rules into host admission.
      // Prune only the private publication index; canonical archive and host
      // index custody are unchanged. This also handles directory replacements
      // without recursive pathspecs enrolling unowned descendants.
      const staged = await step(() =>
        readPublicationTree(params.cwd, workspaceTree, runPublicationCommand),
      );
      const admitted = new Set(
        [...admittedPaths].map((entry) => Buffer.from(entry).toString("hex")),
      );
      const excluded = splitNullBuffer(staged)
        .map((record) => record.subarray(record.indexOf(9) + 1))
        .filter((entry) => !admitted.has(entry.toString("hex")));
      if (excluded.length) {
        await git(
          ["update-index", "--force-remove", "-z", "--stdin"],
          env,
          Buffer.concat(excluded.flatMap((entry) => [entry, Buffer.from([0])])),
        );
        workspaceTree = await git(["write-tree"], env);
      }
    }
    await step(() =>
      assertPublicationTreeHasNoFilters(params.cwd, workspaceTree, runPublicationCommand),
    );
    return { sourceHeadCommit, sourceIndexTree, workspaceTree };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
