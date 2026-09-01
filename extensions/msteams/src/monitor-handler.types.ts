// Msteams type declarations define plugin contracts.
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsPollStore } from "./polls.js";
import type { MSTeamsApp } from "./sdk.js";
import type { MSTeamsSsoTurnAuthority } from "./sso-turn-authority.js";

export type MSTeamsMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  /** Exact configured channel account. Legacy test callers fall back to appId. */
  accountId?: string;
  appId: string;
  app: MSTeamsApp;
  tokenProvider: {
    getAccessToken: (scope: string) => Promise<string>;
  };
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  ssoTurnAuthority?: MSTeamsSsoTurnAuthority;
  ssoConnectionName?: string;
  log: MSTeamsMonitorLogger;
};
