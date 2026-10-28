import { isDeepStrictEqual } from "node:util";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
  type AgentLifecycleBinding,
} from "../agents/agent-lifecycle-registry.js";
import { resolveMutableAgentEntry } from "../agents/agent-scope.js";
import { applyAgentConfig } from "../commands/agents.config.js";
import { unsetConfigValueAtPath } from "../config/config-paths.js";
import { mutateConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  AgentToolsConfig,
  GitHubToolIdentityConfig,
  GitLabToolIdentityConfig,
} from "../config/types.tools.js";

type ForgeIdentitySelection =
  | {
      provider: "github";
      identity?: GitHubToolIdentityConfig;
      expectedIdentity?: GitHubToolIdentityConfig | null;
    }
  | {
      provider: "gitlab";
      identity?: GitLabToolIdentityConfig;
      expectedIdentity?: GitLabToolIdentityConfig | null;
    };

/** Config retry/CAS and agent lifecycle are shared; credentials stay with each provider. */
export async function updateForgeToolIdentityConfig(
  params: ForgeIdentitySelection & {
    scope: "system" | "agent";
    agentId: string;
    agentLifecycleBinding?: AgentLifecycleBinding;
    assertCurrent?: () => void | Promise<void>;
  },
): Promise<OpenClawConfig> {
  const label = params.provider === "github" ? "GitHub" : "GitLab";
  const assertExpected = (
    identity: GitHubToolIdentityConfig | GitLabToolIdentityConfig | undefined,
  ) => {
    if (
      params.expectedIdentity !== undefined &&
      !isDeepStrictEqual(identity ?? null, params.expectedIdentity)
    ) {
      throw new Error(label + " identity changed while setup was in progress.");
    }
  };
  const install = (
    target: { tools?: Pick<AgentToolsConfig, "github" | "gitlab"> },
    allowInSandbox?: boolean,
  ) => {
    const tools = (target.tools ??= {});
    if (!params.identity) {
      unsetConfigValueAtPath(target, ["tools", params.provider]);
      return;
    }
    if (params.provider === "github") {
      tools.github =
        allowInSandbox === undefined ? params.identity : { ...params.identity, allowInSandbox };
    } else {
      tools.gitlab =
        allowInSandbox === undefined ? params.identity : { ...params.identity, allowInSandbox };
    }
  };
  const mutation = await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: async (draft) => {
      // Retry callbacks must recheck the current owner, not reuse an earlier admission.
      await params.assertCurrent?.();
      if (params.scope === "system") {
        assertExpected(draft.tools?.[params.provider]);
        install(draft);
        return;
      }
      if (
        params.agentLifecycleBinding &&
        (!(await matchesAgentLifecycleBindingAsync(() => draft, params.agentLifecycleBinding)) ||
          !matchesAgentLifecycleBinding(draft, params.agentLifecycleBinding))
      ) {
        throw new Error("Agent changed while " + label + " setup was in progress.");
      }
      let entry = resolveMutableAgentEntry(draft, params.agentId);
      if (params.agentLifecycleBinding && !entry) {
        throw new Error("Agent changed while " + label + " setup was in progress.");
      }
      assertExpected(entry?.tools?.[params.provider]);
      if (!entry && params.identity && !params.agentLifecycleBinding) {
        Object.assign(draft, applyAgentConfig(draft, { agentId: params.agentId }));
        entry = resolveMutableAgentEntry(draft, params.agentId);
      }
      if (!entry) {
        return;
      }
      entry.tools ??= {};
      install(entry, entry.tools[params.provider]?.allowInSandbox);
    },
  });
  return mutation.nextConfig;
}
