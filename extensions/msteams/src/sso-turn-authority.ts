// Msteams plugin module owns short-lived, turn-bound SSO authority handoff.
import { randomUUID } from "node:crypto";

export const MSTEAMS_SSO_TURN_AUTHORITY_CAPABILITY = "msteams.sso.turn-authority.v1";
export const MSTEAMS_SSO_TOOL_BINDING_KEY = "msteamsSso";

export type MSTeamsSsoTurnBinding = {
  version: 1;
  leaseId: string;
  accountId: string;
  agentId: string;
  sessionKey: string;
  senderId: string;
  tenantId: string;
  activityId: string;
  conversationId: string;
  connectionName: string;
};

type MSTeamsSsoTurnIssue = Omit<MSTeamsSsoTurnBinding, "version" | "leaseId"> & {
  token?: string;
  requestSignIn?: () => Promise<string | undefined>;
};

export type MSTeamsSsoTurnConsumeResult =
  | { kind: "token"; token: string }
  | { kind: "sign_in_required" }
  | { kind: "denied"; reason: "missing" | "expired" | "binding_mismatch" };

export type MSTeamsSsoTurnAuthority = {
  issue: (params: MSTeamsSsoTurnIssue) => MSTeamsSsoTurnBinding | undefined;
  consume: (binding: MSTeamsSsoTurnBinding) => Promise<MSTeamsSsoTurnConsumeResult>;
  dispose: () => void;
};

type StoredTurnAuthority = {
  binding: MSTeamsSsoTurnBinding;
  expiresAt: number;
  token?: string;
  requestSignIn?: () => Promise<string | undefined>;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1024;

function hasExactBinding(expected: MSTeamsSsoTurnBinding, actual: MSTeamsSsoTurnBinding): boolean {
  return (
    actual.version === 1 &&
    expected.version === actual.version &&
    expected.leaseId === actual.leaseId &&
    expected.accountId === actual.accountId &&
    expected.agentId === actual.agentId &&
    expected.sessionKey === actual.sessionKey &&
    expected.senderId === actual.senderId &&
    expected.tenantId === actual.tenantId &&
    expected.activityId === actual.activityId &&
    expected.conversationId === actual.conversationId &&
    expected.connectionName === actual.connectionName
  );
}

export function createMSTeamsSsoTurnAuthority(params?: {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  createLeaseId?: () => string;
}): MSTeamsSsoTurnAuthority {
  const now = params?.now ?? Date.now;
  const ttlMs = Math.max(1, params?.ttlMs ?? DEFAULT_TTL_MS);
  const maxEntries = Math.max(1, params?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const createLeaseId = params?.createLeaseId ?? randomUUID;
  const entries = new Map<string, StoredTurnAuthority>();

  const prune = () => {
    const current = now();
    for (const [leaseId, entry] of entries) {
      if (entry.expiresAt <= current) {
        entries.delete(leaseId);
      }
    }
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      entries.delete(oldest);
    }
  };

  return {
    issue: (issue) => {
      if (!issue.token && !issue.requestSignIn) {
        return undefined;
      }
      prune();
      const binding: MSTeamsSsoTurnBinding = {
        version: 1,
        leaseId: createLeaseId(),
        accountId: issue.accountId,
        agentId: issue.agentId,
        sessionKey: issue.sessionKey,
        senderId: issue.senderId,
        tenantId: issue.tenantId,
        activityId: issue.activityId,
        conversationId: issue.conversationId,
        connectionName: issue.connectionName,
      };
      entries.set(binding.leaseId, {
        binding,
        expiresAt: now() + ttlMs,
        ...(issue.token ? { token: issue.token } : {}),
        ...(issue.requestSignIn ? { requestSignIn: issue.requestSignIn } : {}),
      });
      return binding;
    },
    consume: async (binding) => {
      const entry = entries.get(binding.leaseId);
      if (!entry) {
        return { kind: "denied", reason: "missing" };
      }
      // A turn lease is single-use. Delete it before any asynchronous work so
      // retries, concurrent calls, and sign-in callback failures cannot replay it.
      entries.delete(binding.leaseId);
      if (entry.expiresAt <= now()) {
        return { kind: "denied", reason: "expired" };
      }
      if (!hasExactBinding(entry.binding, binding)) {
        return { kind: "denied", reason: "binding_mismatch" };
      }
      if (entry.token) {
        return { kind: "token", token: entry.token };
      }
      try {
        const token = await entry.requestSignIn?.();
        return token ? { kind: "token", token } : { kind: "sign_in_required" };
      } catch {
        return { kind: "sign_in_required" };
      }
    },
    dispose: () => {
      entries.clear();
    },
  };
}
