import os from "node:os";
import { gitReadOnlyEnvironment } from "../infra/git-exec.js";
import { appendGitConfig, gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";
import { retryableGitNetworkOperation, withGitNetworkRetry } from "../infra/git-network-retry.js";
import { runCommandBuffered } from "../process/exec.js";
import { withGitProcessOperation, type GitProcessOperation } from "../process/spawn-diagnostics.js";

export type GitCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer | (() => string | Buffer);
  maxOutputBytes?: number;
  beforeRun?: () => void;
  operation?: GitProcessOperation;
};
export type GitCommandResult = { code: number | null; stdout: Buffer };

export async function runPublicationCommand(argv: string[], options: GitCommandOptions = {}) {
  return await withGitProcessOperation(options.operation ?? "publication", () =>
    withGitNetworkRetry(
      argv[0] === "git" ? retryableGitNetworkOperation(argv.slice(1)) : undefined,
      { timeoutMs: 60_000, beforeRun: options.beforeRun },
      (timeoutMs) =>
        runCommandBuffered(argv, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: {
            ...(argv[0] === "git"
              ? gitReadOnlyEnvironment(argv.slice(1), options.env ?? {})
              : (options.env ?? {})),
            GIT_NO_REPLACE_OBJECTS: "1",
            // Pin every command against repository hooks; explicit hook-disabling -c flags stay stronger.
            ...appendGitConfig(gitMaintenanceEnvironment(), [["core.hooksPath", os.devNull]]),
          },
          // Resolve optional disclosure after beforeRun, directly at the transport boundary.
          ...(options.input !== undefined
            ? { input: typeof options.input === "function" ? options.input() : options.input }
            : {}),
          timeoutMs,
          maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
        }),
    ),
  );
}

export async function requirePublicationCommand(
  argv: string[],
  options: GitCommandOptions = {},
): Promise<string> {
  const result = await runPublicationCommand(argv, options);
  if (result.code !== 0) {
    throw new Error(`${argv[0]} command failed`);
  }
  return result.stdout.toString("utf8").trim();
}

// Guard ordinary steps on both sides of the await. Effects whose observations
// must survive revocation use the raw transport and record before rechecking.
export function createPublicationCommandRunner(
  assertCurrent?: () => void,
  gitOperation: GitProcessOperation = "publication",
) {
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent?.();
    const result = await operation();
    assertCurrent?.();
    return result;
  };
  const guarded =
    <T>(command: (argv: string[], options: GitCommandOptions) => Promise<T>) =>
    async (argv: string[], options: GitCommandOptions = {}): Promise<T> => {
      const result = await command(argv, {
        ...options,
        operation: gitOperation,
        beforeRun: assertCurrent,
      });
      assertCurrent?.();
      return result;
    };
  return {
    step,
    run: guarded(runPublicationCommand),
    require: guarded(requirePublicationCommand),
  };
}
