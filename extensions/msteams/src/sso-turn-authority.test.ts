import { describe, expect, it, vi } from "vitest";
import { createMSTeamsSsoTurnAuthority } from "./sso-turn-authority.js";

const baseIssue = {
  accountId: "jimmy",
  agentId: "ea-jimmy",
  sessionKey: "agent:ea-jimmy:msteams:direct:owner",
  senderId: "owner-oid",
  tenantId: "tenant-id",
  activityId: "activity-id",
  conversationId: "conversation-id",
  connectionName: "graph-shared-calendar",
};

describe("createMSTeamsSsoTurnAuthority", () => {
  it("returns a token exactly once for the exact bound turn", async () => {
    const authority = createMSTeamsSsoTurnAuthority({ createLeaseId: () => "lease-1" });
    const binding = authority.issue({ ...baseIssue, token: "secret-token" });

    expect(binding).toBeDefined();
    await expect(authority.consume(binding!)).resolves.toEqual({
      kind: "token",
      token: "secret-token",
    });
    await expect(authority.consume(binding!)).resolves.toEqual({
      kind: "denied",
      reason: "missing",
    });
  });

  it.each([
    "accountId",
    "agentId",
    "sessionKey",
    "senderId",
    "tenantId",
    "activityId",
    "conversationId",
    "connectionName",
  ] as const)("fails closed when %s does not match", async (field) => {
    const authority = createMSTeamsSsoTurnAuthority({ createLeaseId: () => "lease-1" });
    const binding = authority.issue({ ...baseIssue, token: "secret-token" })!;

    await expect(
      authority.consume({ ...binding, [field]: `${binding[field]}-other` }),
    ).resolves.toEqual({ kind: "denied", reason: "binding_mismatch" });
    await expect(authority.consume(binding)).resolves.toEqual({
      kind: "denied",
      reason: "missing",
    });
  });

  it("fails closed after expiry", async () => {
    let current = 100;
    const authority = createMSTeamsSsoTurnAuthority({
      now: () => current,
      ttlMs: 10,
      createLeaseId: () => "lease-1",
    });
    const binding = authority.issue({ ...baseIssue, token: "secret-token" })!;
    current = 110;

    await expect(authority.consume(binding)).resolves.toEqual({
      kind: "denied",
      reason: "expired",
    });
  });

  it("invokes the bound SDK sign-in once and reports interaction required", async () => {
    const requestSignIn = vi.fn(async () => undefined);
    const authority = createMSTeamsSsoTurnAuthority({ createLeaseId: () => "lease-1" });
    const binding = authority.issue({ ...baseIssue, requestSignIn })!;

    await expect(authority.consume(binding)).resolves.toEqual({ kind: "sign_in_required" });
    expect(requestSignIn).toHaveBeenCalledTimes(1);
    await expect(authority.consume(binding)).resolves.toEqual({
      kind: "denied",
      reason: "missing",
    });
  });

  it("never issues an authority handle without a token or sign-in path", () => {
    const authority = createMSTeamsSsoTurnAuthority();
    expect(authority.issue(baseIssue)).toBeUndefined();
  });

  it("clears all outstanding leases when disposed", async () => {
    const authority = createMSTeamsSsoTurnAuthority({ createLeaseId: () => "lease-1" });
    const binding = authority.issue({ ...baseIssue, token: "secret-token" })!;
    authority.dispose();

    await expect(authority.consume(binding)).resolves.toEqual({
      kind: "denied",
      reason: "missing",
    });
  });
});
