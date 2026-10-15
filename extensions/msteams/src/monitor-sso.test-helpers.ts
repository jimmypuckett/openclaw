import type { App } from "@microsoft/teams.apps";
import { vi } from "vitest";

export const FIXTURE_TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FOREIGN_TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createActivityEvent<TBody extends Record<string, unknown>>(body: TBody) {
  const serviceUrl = "https://smba.trafficmanager.net/teams";
  return {
    body: { channelId: "msteams", serviceUrl, ...body },
    token: {
      appId: "fixture-bot",
      from: "bot",
      fromId: "fixture-bot",
      serviceUrl,
      isExpired: () => false,
      toString: () => "fixture-inbound-token",
    },
  } satisfies Parameters<App["process"]>[0];
}

export function createSigninEvent(
  name: "signin/tokenExchange" | "signin/verifyState" = "signin/tokenExchange",
  senderId = "29:user",
  tenantId = FIXTURE_TENANT_ID,
) {
  const body = {
    type: "invoke",
    name,
    id: `invoke-${name}`,
    from: { id: senderId, aadObjectId: "aad-user" },
    recipient: { id: "fixture-bot" },
    conversation: {
      id: "fixture-conversation",
      conversationType: "personal",
      tenantId,
    },
    channelData: { tenant: { id: tenantId } },
    value:
      name === "signin/tokenExchange"
        ? { id: "exchange-id", connectionName: "graph", token: "fixture-user-token" }
        : { state: "fixture-state" },
  };
  return createActivityEvent(body);
}

export function createMessageEvent(tenantId = FIXTURE_TENANT_ID) {
  return createActivityEvent({
    type: "message",
    id: "fixture-message",
    text: "hello",
    from: { id: "29:user", aadObjectId: "aad-user" },
    recipient: { id: "fixture-bot" },
    conversation: {
      id: "fixture-conversation",
      conversationType: "personal",
      tenantId,
    },
    channelData: { tenant: { id: tenantId } },
  });
}

export async function createNativeSsoProcessor() {
  const { App: NativeApp } =
    await vi.importActual<typeof import("@microsoft/teams.apps")>("@microsoft/teams.apps");
  const requests: Array<{
    method?: string;
    path: string;
    query: Record<string, string>;
    data: unknown;
  }> = [];
  const botToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ appid: "fixture-bot", tid: FIXTURE_TENANT_ID })).toString(
      "base64url",
    ),
    "fixture",
  ].join(".");
  const app = new NativeApp({
    clientId: "fixture-bot",
    clientSecret: "",
    tenantId: FIXTURE_TENANT_ID,
    token: async () => botToken,
    oauth: { defaultConnectionName: "graph" },
    apiClientSettings: { oauthUrl: "https://token.botframework.com" },
    client: {
      interceptors: [
        {
          request: ({ config }) => {
            config.adapter = async (request) => {
              const url = new URL(request.url!);
              if (
                url.origin !== "https://token.botframework.com" ||
                (url.pathname !== "/api/usertoken/GetToken" &&
                  url.pathname !== "/api/usertoken/exchange")
              ) {
                throw new Error(`Unexpected Teams SDK request: ${url}`);
              }
              requests.push({
                method: request.method,
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
                data: typeof request.data === "string" ? JSON.parse(request.data) : request.data,
              });
              return {
                data:
                  url.pathname.endsWith("/exchange") || url.searchParams.has("code")
                    ? {
                        channelId: "msteams",
                        connectionName: "graph",
                        token: "delegated-graph-token",
                        expiration: "2030-01-01T00:00:00Z",
                      }
                    : {},
                status: 200,
                statusText: "OK",
                headers: {},
                config: request,
              };
            };
            return config;
          },
        },
      ],
    },
  });
  return { app, requests };
}
