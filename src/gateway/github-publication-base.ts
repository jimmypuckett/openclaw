import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";

export function parseGitHubPublicationBaseBranch(baseRef: string, defaultBranch: string): string {
  const trimmed = baseRef.trim();
  if (!trimmed || trimmed === "HEAD" || /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(trimmed)) {
    return defaultBranch;
  }
  for (const prefix of ["refs/remotes/origin/", "origin/", "refs/heads/"]) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

/** Returns the authenticated target-base SHA or fails the publication boundary closed. */
export function parseGitHubPublicationBaseRef(raw: string, baseBranch: string): string {
  const parsed = safeParseJson(raw);
  const ref = isRecord(parsed) ? readNonBlankString(parsed.ref) : undefined;
  const sha = isRecord(parsed) ? readNonBlankString(parsed.sha) : undefined;
  if (
    ref !== `refs/heads/${baseBranch}` ||
    !sha ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(sha)
  ) {
    throw new Error("GitHub publication workspace base branch could not be verified.");
  }
  return sha;
}
