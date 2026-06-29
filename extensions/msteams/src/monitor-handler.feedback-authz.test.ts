// Msteams tests cover monitor handler.feedback authz plugin behavior.
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { runMSTeamsFeedbackInvokeHandler } from "./feedback-invoke.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const feedbackReflectionMockState = vi.hoisted(() => ({
  runFeedbackReflection: vi.fn(),
}));

vi.mock("./monitor-handler/message-handler.js", () => ({
  createMSTeamsMessageHandler: () => async () => {},
}));

vi.mock("./monitor-handler/reaction-handler.js", () => ({
  createMSTeamsReactionHandler: () => async () => {},
}));

vi.mock("./feedback-reflection.js", async () => {
  const actual = await vi.importActual<typeof import("./feedback-reflection.js")>(
    "./feedback-reflection.js",
  );
  return {
    ...actual,
    runFeedbackReflection: feedbackReflectionMockState.runFeedbackReflection,
  };
});

function createRuntimeStub(readAllowFromStore: ReturnType<typeof vi.fn>): PluginRuntime {
  return {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
          flushKey: async () => {},
          cancelKey: () => false,
        }),
      },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => null),
      },
      routing: {
        resolveAgentRoute: ({
          accountId,
          peer,
        }: {
          accountId?: string;
          peer: { kind: string; id: string };
        }) => ({
          sessionKey:
            accountId && accountId !== "default"
              ? `msteams:${accountId}:${peer.kind}:${peer.id}`
              : `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
          accountId: accountId ?? "default",
        }),
      },
      session: {
        resolveStorePath: (storePath?: string) => storePath ?? tmpdir(),
      },
    },
  } as unknown as PluginRuntime;
}

function createDeps(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
}): MSTeamsMessageHandlerDeps {
  const readAllowFromStore = params.readAllowFromStore ?? vi.fn(async () => []);
  setMSTeamsRuntime(createRuntimeStub(readAllowFromStore));
  return {
    ...createMSTeamsMessageHandlerDeps({
      cfg: params.cfg,
      runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    }),
    accountId: params.accountId ?? "default",
  };
}

function createFeedbackInvokeContext(params: {
  reaction: "like" | "dislike";
  conversationId: string;
  conversationType: string;
  senderId: string;
  senderName?: string;
  teamId?: string;
  channelName?: string;
  comment?: string;
  feedback?: string;
  replyToId?: string;
  valueReplyToId?: string | false;
  activityType?: string;
  invokeName?: string;
}): MSTeamsTurnContext {
  const value: {
    actionName: string;
    actionValue: {
      reaction: "like" | "dislike";
      feedback: string;
    };
    replyToId?: string;
  } = {
    actionName: "feedback",
    actionValue: {
      reaction: params.reaction,
      feedback:
        params.feedback ?? JSON.stringify({ feedbackText: params.comment ?? "feedback text" }),
    },
  };
  if (params.valueReplyToId !== false) {
    value.replyToId = params.valueReplyToId ?? "bot-msg-1";
  }

  return {
    activity: {
      id: `invoke-${params.reaction}`,
      type: params.activityType ?? "invoke",
      name: params.invokeName ?? "message/submitAction",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: `${params.senderId}-botframework`,
        aadObjectId: params.senderId,
        name: params.senderName ?? "Sender",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: params.conversationId,
        conversationType: params.conversationType,
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      channelData: params.teamId
        ? {
            team: { id: params.teamId, name: "Team 1" },
            channel: params.channelName ? { name: params.channelName } : undefined,
          }
        : {},
      replyToId: params.replyToId,
      value,
    },
    sendActivity: vi.fn(async () => ({ id: "ignored" })),
    sendActivities: async () => [],
  } as unknown as MSTeamsTurnContext;
}

async function runFeedbackHandlerInTempStore(params: {
  cfg: OpenClawConfig;
  context: MSTeamsTurnContext;
  accountId?: string;
  assertResult: (args: { tmpDir: string; consumed: boolean }) => Promise<void>;
}) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-msteams-feedback-"));
  try {
    const deps = createDeps({
      cfg: {
        ...params.cfg,
        session: { store: tmpDir },
      } as OpenClawConfig,
      accountId: params.accountId,
    });
    const consumed = await runMSTeamsFeedbackInvokeHandler(params.context, deps);
    await params.assertResult({ tmpDir, consumed });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function expectFileMissing(filePath: string) {
  let error: unknown;
  try {
    await access(filePath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

async function withFeedbackHandler(params: {
  cfg: OpenClawConfig;
  context: Parameters<typeof createFeedbackInvokeContext>[0];
  accountId?: string;
  assertResult: (args: { tmpDir: string }) => Promise<void>;
}) {
  await runFeedbackHandlerInTempStore({
    cfg: params.cfg,
    accountId: params.accountId,
    context: createFeedbackInvokeContext(params.context),
    assertResult: async ({ tmpDir }) => params.assertResult({ tmpDir }),
  });
}

describe("msteams feedback invoke authz", () => {
  beforeEach(() => {
    feedbackReflectionMockState.runFeedbackReflection.mockReset();
    feedbackReflectionMockState.runFeedbackReflection.mockResolvedValue(undefined);
  });

  it("falls through activities that are not Teams feedback submit invokes", async () => {
    await runFeedbackHandlerInTempStore({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: createFeedbackInvokeContext({
        activityType: "message",
        reaction: "like",
        conversationId: "a:personal-chat",
        conversationType: "personal",
        senderId: "owner-aad",
      }),
      assertResult: async ({ tmpDir, consumed }) => {
        expect(consumed).toBe(false);
        await expectFileMissing(path.join(tmpDir, "msteams_direct_owner-aad.jsonl"));
      },
    });
  });

  it("records captured no-comment thumbs-up feedback without a comment field", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        feedback: "{}",
        replyToId: "1782644926041",
        valueReplyToId: false,
      },
      assertResult: async ({ tmpDir }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_direct_owner-aad.jsonl"),
          "utf-8",
        );
        const event = JSON.parse(transcript.trim()) as Record<string, unknown>;
        expect(event).not.toHaveProperty("comment");
        expect({ ...event, ts: 0 }).toEqual({
          type: "custom",
          event: "feedback",
          ts: 0,
          messageId: "1782644926041",
          value: "positive",
          sessionKey: "msteams:direct:owner-aad",
          agentId: "default",
          conversationId: "a:personal-chat",
        });
      },
    });
  });

  it("records captured comment-bearing feedback from the JSON string body", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "open",
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "19:group-chat@unq.gbl.spaces",
        conversationType: "groupChat",
        senderId: "owner-aad",
        senderName: "Owner",
        feedback: JSON.stringify({
          feedbackText: "Helpful payload-study reply. Please capture this feedback comment.",
        }),
        replyToId: "1782646068908",
        valueReplyToId: false,
      },
      assertResult: async ({ tmpDir }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_group_19_group-chat_unq_gbl_spaces.jsonl"),
          "utf-8",
        );
        const event = JSON.parse(transcript.trim()) as Record<string, unknown>;
        expect({ ...event, ts: 0 }).toEqual({
          type: "custom",
          event: "feedback",
          ts: 0,
          messageId: "1782646068908",
          value: "positive",
          comment: "Helpful payload-study reply. Please capture this feedback comment.",
          sessionKey: "msteams:group:19:group-chat@unq.gbl.spaces",
          agentId: "default",
          conversationId: "19:group-chat@unq.gbl.spaces",
        });
      },
    });
  });

  it("honors account-scoped feedbackEnabled=false over the global default", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
            feedbackEnabled: true,
            accounts: {
              legal: {
                dmPolicy: "allowlist",
                allowFrom: ["owner-aad"],
                feedbackEnabled: false,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "legal",
      context: {
        reaction: "like",
        conversationId: "a:legal-personal-chat",
        conversationType: "personal",
        senderId: "owner-aad",
        feedback: "{}",
      },
      assertResult: async ({ tmpDir }) => {
        await expectFileMissing(path.join(tmpDir, "msteams_legal_direct_owner-aad.jsonl"));
      },
    });
  });

  it("honors account-scoped feedbackReflection=false for negative feedback", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
            feedbackReflection: true,
            accounts: {
              legal: {
                dmPolicy: "allowlist",
                allowFrom: ["owner-aad"],
                feedbackReflection: false,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "legal",
      context: {
        reaction: "dislike",
        conversationId: "a:legal-personal-chat",
        conversationType: "personal",
        senderId: "owner-aad",
        comment: "negative feedback from legal account",
      },
      assertResult: async ({ tmpDir }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_legal_direct_owner-aad.jsonl"),
          "utf-8",
        );
        const event = JSON.parse(transcript.trim()) as Record<string, unknown>;
        expect(event.value).toBe("negative");
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      },
    });
  });

  it("records feedback for an allowlisted DM sender", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed feedback",
      },
      assertResult: async ({ tmpDir }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_direct_owner-aad.jsonl"),
          "utf-8",
        );
        const event = JSON.parse(transcript.trim()) as Record<string, unknown>;
        expect(Object.keys(event).toSorted()).toEqual([
          "agentId",
          "comment",
          "conversationId",
          "event",
          "messageId",
          "sessionKey",
          "ts",
          "type",
          "value",
        ]);
        expect(typeof event.ts).toBe("number");
        expect({ ...event, ts: 0 }).toEqual({
          type: "custom",
          event: "feedback",
          ts: 0,
          messageId: "bot-msg-1",
          value: "positive",
          comment: "allowed feedback",
          sessionKey: "msteams:direct:owner-aad",
          agentId: "default",
          conversationId: "a:personal-chat",
        });
      },
    });
  });

  it("keeps DM feedback allowed when team route allowlists exist", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
            teams: {
              team123: {
                channels: {
                  "19:group@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed dm feedback",
      },
      assertResult: async ({ tmpDir }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_direct_owner-aad.jsonl"),
          "utf-8",
        );
        const event = JSON.parse(transcript.trim()) as Record<string, unknown>;
        expect(Object.keys(event).toSorted()).toEqual([
          "agentId",
          "comment",
          "conversationId",
          "event",
          "messageId",
          "sessionKey",
          "ts",
          "type",
          "value",
        ]);
        expect(typeof event.ts).toBe("number");
        expect({ ...event, ts: 0 }).toEqual({
          type: "custom",
          event: "feedback",
          ts: 0,
          messageId: "bot-msg-1",
          value: "positive",
          comment: "allowed dm feedback",
          sessionKey: "msteams:direct:owner-aad",
          agentId: "default",
          conversationId: "a:personal-chat",
        });
      },
    });
  });

  it("does not record feedback for a DM sender outside allowFrom", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "attacker-aad",
        senderName: "Attacker",
        comment: "blocked feedback",
      },
      assertResult: async ({ tmpDir }) => {
        await expectFileMissing(path.join(tmpDir, "msteams_direct_attacker-aad.jsonl"));
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      },
    });
  });

  it("does not trigger reflection for a group sender outside groupAllowFrom", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-msteams-feedback-"));
    try {
      const deps = createDeps({
        cfg: {
          session: { store: tmpDir },
          channels: {
            msteams: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["owner-aad"],
              feedbackReflection: true,
            },
          },
        } as OpenClawConfig,
      });

      await runMSTeamsFeedbackInvokeHandler(
        createFeedbackInvokeContext({
          reaction: "dislike",
          conversationId: "19:group@thread.tacv2;messageid=bot-msg-1",
          conversationType: "groupChat",
          senderId: "attacker-aad",
          senderName: "Attacker",
          teamId: "team-1",
          channelName: "General",
          comment: "blocked reflection",
        }),
        deps,
      );

      await expectFileMissing(path.join(tmpDir, "msteams_group_19_group_thread_tacv2.jsonl"));
      expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
