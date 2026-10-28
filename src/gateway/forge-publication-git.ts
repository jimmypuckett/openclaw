import os from "node:os";
import type { requirePublicationCommand } from "./forge-publication-command.js";

export async function readPublicationCoauthorTrailers(params: {
  cwd: string;
  headCommit: string;
  command: typeof requirePublicationCommand;
}): Promise<string[]> {
  const output = await params.command(
    [
      "git",
      "-c",
      "trailer.separators=:",
      "-c",
      "trailer.co-authored-by.key=Co-authored-by",
      "show",
      "-s",
      "--format=%(trailers:key=Co-authored-by,only,unfold)",
      params.headCommit,
    ],
    { cwd: params.cwd },
  );
  return output.split(/\r?\n/u);
}

export function appendPublicationMessage(base: string, lines: readonly string[]): string {
  const footer = [...new Set(lines)].join("\n");
  return footer ? `${base.trimEnd()}\n\n${footer}` : base.trimEnd();
}

/** Prepared commits use our terminal credit footer, never matching prose elsewhere in the message. */
export function hasPublicationMessageFooter(
  message: string,
  coauthorTrailers: readonly string[],
  publicationMarker: string,
): boolean {
  const lines = message.replace(/[\r\n]+$/u, "").split(/\r?\n/u);
  const separator = lines.lastIndexOf("");
  if (separator < 1 || lines.at(-1) !== publicationMarker) {
    return false;
  }
  const actual = lines.slice(separator + 1, -1);
  const expected = new Set(coauthorTrailers);
  return actual.length === expected.size && [...expected].every((line) => actual.includes(line));
}

export async function assertPublicationBranchRef(
  branch: string,
  run: (argv: string[]) => Promise<number>,
): Promise<void> {
  const code = await run(["git", "symbolic-ref", "--quiet", `refs/heads/${branch}`]);
  if (code === 0) {
    throw new Error("Publication workspace branch ref became symbolic.");
  }
  if (code !== 1) {
    throw new Error("Publication workspace branch ref could not be verified.");
  }
}

export function publicationUpdateRefArgs(
  branch: string,
  commit: string,
  previousHead: string,
): string[] {
  return [
    "git",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "update-ref",
    `refs/heads/${branch}`,
    commit,
    previousHead,
  ];
}
export function publicationPushArgs(
  remote: string,
  headCommit: string,
  branch: string,
  expectedRemoteHead: string,
): string[] {
  return [
    "push",
    "--porcelain",
    // The executor proves ancestry first. Pin that proof to this exact remote
    // value (or absence); the lease never substitutes for the fast-forward check.
    `--force-with-lease=refs/heads/${branch}:${expectedRemoteHead}`,
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    remote,
    `${headCommit}:refs/heads/${branch}`,
  ];
}
