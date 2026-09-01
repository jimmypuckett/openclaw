// Msteams tests cover turn-bound SSO authority handoff behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  createMSTeamsSsoTurnAuthority,
  MSTEAMS_SSO_TOOL_BINDING_KEY,
  type MSTeamsSsoTurnBinding,
} from "../sso-turn-authority.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { createMessageHandlerDeps } from "./message-handler.test-support.js";

type HandlerInput = Parameters<ReturnType<typeof createMSTeamsMessageHandler>>[0];

const runtimeApiMockState = getRuntimeApiMockState();

function createDeps(providerAccountId = "default") {
  const { deps } = createMessageHandlerDeps(
    {
      channels: {
        msteams: {
          dmPolicy: "allowlist",
          allowFrom: ["owner-aad"],
        },
      },
    } as OpenClawConfig,
    {
      resolveAgentRoute: vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
        sessionKey: `msteams:${peer.kind}:${peer.id}`,
        agentId: "default",
        accountId: "default",
      })),
    },
  );
  deps.accountId = providerAccountId;
  deps.ssoConnectionName = "graph-shared-calendar";
  return deps;
}

function createOwnerActivity(): HandlerInput {
  return {
    activity: {
      id: "turn-1",
      type: "message",
      text: "check Drew's shared calendar",
      from: {
        id: "owner-bot-framework",
        aadObjectId: "owner-aad",
        name: "Owner",
      },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: {
        id: "personal-conversation",
        conversationType: "personal",
        tenantId: "tenant-1",
      },
      channelData: {},
      attachments: [],
    },
    connectionName: "graph-shared-calendar",
    sendActivity: vi.fn(async () => undefined),
  } as unknown as HandlerInput;
}

function firstSettledContext(): {
  GatewayRunToolBindings?: Record<string, unknown>;
} {
  const call = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0];
  if (!call) {
    throw new Error("Expected a settled dispatch");
  }
  return (call[0] as { ctx: { GatewayRunToolBindings?: Record<string, unknown> } }).ctx;
}

function readBinding(): MSTeamsSsoTurnBinding {
  const binding = firstSettledContext().GatewayRunToolBindings?.[MSTEAMS_SSO_TOOL_BINDING_KEY];
  if (!binding) {
    throw new Error("Expected an SSO turn binding");
  }
  return binding as MSTeamsSsoTurnBinding;
}

describe("msteams message handler SSO authority", () => {
  it("hands the current Teams SSO token to tools through a turn-bound runtime binding", async () => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
    const deps = createDeps();
    const authority = createMSTeamsSsoTurnAuthority({ createLeaseId: () => "lease-1" });
    deps.ssoTurnAuthority = authority;
    const context = createOwnerActivity();
    context.userToken = "delegated-graph-token";

    await createMSTeamsMessageHandler(deps)(context);

    const binding = readBinding();
    expect(binding).toMatchObject({
      version: 1,
      leaseId: "lease-1",
      accountId: "default",
      agentId: "default",
      sessionKey: "msteams:direct:owner-aad",
      senderId: "owner-aad",
      tenantId: "tenant-1",
      activityId: "turn-1",
      conversationId: "personal-conversation",
      connectionName: "graph-shared-calendar",
    });
    expect(JSON.stringify(firstSettledContext())).not.toContain("delegated-graph-token");
    await expect(authority.consume(binding)).resolves.toEqual({
      kind: "token",
      token: "delegated-graph-token",
    });
  });

  it("binds the SDK sign-in callback without persisting owner credentials", async () => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
    const deps = createDeps();
    const authority = createMSTeamsSsoTurnAuthority({ createLeaseId: () => "lease-1" });
    deps.ssoTurnAuthority = authority;
    const context = createOwnerActivity();
    context.signin = vi.fn(async () => undefined);

    await createMSTeamsMessageHandler(deps)(context);

    await expect(authority.consume(readBinding())).resolves.toEqual({
      kind: "sign_in_required",
    });
    expect(context.signin).toHaveBeenCalledWith({ connectionName: "graph-shared-calendar" });
  });

  it("does not issue SSO authority when the routed account differs from the provider account", async () => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
    const deps = createDeps("different-provider-account");
    deps.ssoTurnAuthority = createMSTeamsSsoTurnAuthority();
    const context = createOwnerActivity();
    context.userToken = "delegated-graph-token";

    await createMSTeamsMessageHandler(deps)(context);

    expect(firstSettledContext().GatewayRunToolBindings).toBeUndefined();
  });

  it("does not issue SSO authority for a different SDK OAuth connection", async () => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
    const deps = createDeps();
    deps.ssoTurnAuthority = createMSTeamsSsoTurnAuthority();
    const context = createOwnerActivity();
    context.connectionName = "different-connection";
    context.userToken = "delegated-graph-token";

    await createMSTeamsMessageHandler(deps)(context);

    expect(firstSettledContext().GatewayRunToolBindings).toBeUndefined();
  });
});
