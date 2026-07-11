import {
  resolveConfiguredSecretInputString,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const LOGIN_ROOT = "https://login.microsoftonline.com";
const TOOL_NAMES = [
  "m365_mail_list_recent",
  "m365_mail_read",
  "m365_calendar_list",
  "m365_mail_draft_reply",
  "m365_mail_send",
  "m365_calendar_create",
  "m365_calendar_update",
  "m365_calendar_respond",
] as const;

type M365AccountConfig = {
  tenantId?: string;
  clientId?: string;
  clientSecret?: unknown;
  mailbox?: string;
  allowedAgentIds?: string[];
  allowedChannels?: string[];
  allowWrites?: boolean;
};

type M365PluginConfig = {
  accounts?: Record<string, M365AccountConfig>;
};

type GraphPaged<T> = {
  value?: T[];
  "@odata.nextLink"?: string;
};

type GraphMessage = {
  id?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  webLink?: string;
  conversationId?: string;
};

type GraphEvent = {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{
    type?: string;
    status?: { response?: string; time?: string };
    emailAddress?: { name?: string; address?: string };
  }>;
  location?: { displayName?: string };
  bodyPreview?: string;
  webLink?: string;
};

type JsonSchema = Record<string, unknown>;

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

function stringSchema(extra: Record<string, unknown> = {}): JsonSchema {
  return { type: "string", ...extra };
}

function numberSchema(extra: Record<string, unknown> = {}): JsonSchema {
  return { type: "number", ...extra };
}

function booleanSchema(extra: Record<string, unknown> = {}): JsonSchema {
  return { type: "boolean", ...extra };
}

function arraySchema(items: JsonSchema, extra: Record<string, unknown> = {}): JsonSchema {
  return { type: "array", items, ...extra };
}

function normalizeId(value: string | null | undefined): string {
  return value?.trim() || "default";
}

function pluginConfigFromContext(ctx: OpenClawPluginToolContext): M365PluginConfig {
  const runtimeConfig = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  const entries = (runtimeConfig as OpenClawConfig | undefined)?.plugins?.entries as
    | Record<string, { config?: unknown }>
    | undefined;
  return (entries?.m365?.config ?? {}) as M365PluginConfig;
}

function resolveAccountConfig(ctx: OpenClawPluginToolContext): {
  accountId: string;
  account: M365AccountConfig;
  runtimeConfig?: OpenClawConfig;
} {
  const accountId = normalizeId(ctx.agentAccountId);
  const runtimeConfig = (ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config) as
    | OpenClawConfig
    | undefined;
  const accounts = pluginConfigFromContext(ctx).accounts ?? {};
  const account = accounts[accountId] ?? (accountId === "default" ? accounts.default : undefined);
  if (!account) {
    throw new Error(`m365 account "${accountId}" is not configured`);
  }

  const allowedAgentIds = account.allowedAgentIds?.map((id) => id.trim()).filter(Boolean);
  if (allowedAgentIds?.length && !allowedAgentIds.includes(normalizeId(ctx.agentId))) {
    throw new Error(`m365 account "${accountId}" is not allowed for agent "${ctx.agentId}"`);
  }

  const allowedChannels = account.allowedChannels?.map((id) => id.trim()).filter(Boolean);
  if (
    allowedChannels?.length &&
    (!ctx.messageChannel || !allowedChannels.includes(ctx.messageChannel))
  ) {
    throw new Error(
      `m365 account "${accountId}" is not allowed on channel "${ctx.messageChannel ?? "unknown"}"`,
    );
  }

  return { accountId, account, runtimeConfig };
}

async function resolveClientSecret(params: {
  runtimeConfig?: OpenClawConfig;
  value: unknown;
  path: string;
}): Promise<string> {
  if (!params.runtimeConfig) {
    if (typeof params.value === "string" && params.value.trim()) {
      return params.value.trim();
    }
    throw new Error(`${params.path} is not resolvable without runtime config`);
  }
  const resolved = await resolveConfiguredSecretInputString({
    config: params.runtimeConfig,
    env: process.env,
    value: params.value,
    path: params.path,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.unresolvedRefReason) {
    throw new Error(`${params.path}: ${resolved.unresolvedRefReason}`);
  }
  if (!resolved.value) {
    throw new Error(`${params.path} is required`);
  }
  return resolved.value;
}

async function requestGraphClientCredentialToken(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: "client_credentials",
  });
  const { response, release } = await fetchWithSsrFGuard({
    url: `${LOGIN_ROOT}/${encodeURIComponent(params.tenantId)}/oauth2/v2.0/token`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "OpenClaw m365 plugin",
      },
      body,
    },
    auditContext: "m365.token",
  });
  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `m365 account "${params.accountId}" token request failed: ${response.status} ${errorBody.slice(
          0,
          500,
        )}`,
      );
    }
    const payload = (await response.json()) as { access_token?: string };
    if (!payload.access_token) {
      throw new Error(
        `m365 account "${params.accountId}" token response did not include access_token`,
      );
    }
    return payload.access_token;
  } finally {
    await release();
  }
}

async function graphToken(ctx: OpenClawPluginToolContext): Promise<{
  token: string;
  mailbox: string;
  allowWrites: boolean;
}> {
  const { accountId, account, runtimeConfig } = resolveAccountConfig(ctx);
  const tenantId = account.tenantId?.trim();
  const clientId = account.clientId?.trim();
  const mailbox = account.mailbox?.trim();
  if (!tenantId || !clientId || !mailbox) {
    throw new Error(`m365 account "${accountId}" must define tenantId, clientId, and mailbox`);
  }
  const clientSecret = await resolveClientSecret({
    runtimeConfig,
    value: account.clientSecret,
    path: `plugins.entries.m365.config.accounts.${accountId}.clientSecret`,
  });
  const token = await requestGraphClientCredentialToken({
    tenantId,
    clientId,
    clientSecret,
    accountId,
  });
  return { token, mailbox, allowWrites: account.allowWrites === true };
}

async function graphJson<T>(params: {
  token: string;
  path: string;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
}): Promise<T> {
  const url = params.path.startsWith("https://") ? params.path : `${GRAPH_ROOT}${params.path}`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: params.method ?? "GET",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
        "User-Agent": "OpenClaw m365 plugin",
      },
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
    },
    auditContext: "m365.graph",
  });
  try {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Graph ${params.method ?? "GET"} ${params.path} failed: ${response.status} ${body.slice(0, 500)}`,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const body = await response.text();
    if (!body.trim()) {
      return undefined as T;
    }
    return JSON.parse(body) as T;
  } finally {
    await release();
  }
}

function readRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(50, Math.trunc(value)));
}

function readBoolean(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function readStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function graphAttendees(addresses: string[]): Array<{
  emailAddress: { address: string };
  type: "required";
}> {
  return addresses.map((address) => ({
    emailAddress: { address },
    type: "required",
  }));
}

function createTools(ctx: OpenClawPluginToolContext): AnyAgentTool[] {
  return [
    {
      name: "m365_mail_list_recent",
      label: "List recent mail",
      description:
        "List recent messages from the configured scoped Microsoft 365 mailbox. Use this before summarizing recent email.",
      parameters: objectSchema({
        top: numberSchema({ minimum: 1, maximum: 25, default: 5 }),
      }),
      async execute(_toolCallId, params) {
        const args = readRecord(params);
        const top = readNumber(args, "top", 5);
        const { token, mailbox } = await graphToken(ctx);
        const select = "id,subject,from,receivedDateTime,bodyPreview,webLink,conversationId";
        const path = `/users/${encodeURIComponent(
          mailbox,
        )}/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${encodeURIComponent(select)}`;
        const data = await graphJson<GraphPaged<GraphMessage>>({ token, path });
        return jsonResult({
          mailbox,
          messages: (data.value ?? []).map((message) => ({
            id: message.id,
            subject: message.subject,
            from: message.from?.emailAddress,
            receivedDateTime: message.receivedDateTime,
            preview: message.bodyPreview,
            webLink: message.webLink,
            conversationId: message.conversationId,
          })),
        });
      },
    },
    {
      name: "m365_mail_read",
      label: "Read mail",
      description:
        "Read one message body from the configured scoped Microsoft 365 mailbox by Graph message id.",
      parameters: objectSchema(
        {
          messageId: stringSchema({ minLength: 1 }),
        },
        ["messageId"],
      ),
      async execute(_toolCallId, params) {
        const args = readRecord(params);
        const messageId = readString(args, "messageId");
        if (!messageId) {
          throw new Error("messageId required");
        }
        const { token, mailbox } = await graphToken(ctx);
        const select = "id,subject,from,receivedDateTime,body,webLink,conversationId";
        const path = `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(
          messageId,
        )}?$select=${encodeURIComponent(select)}`;
        const message = await graphJson<GraphMessage>({ token, path });
        return jsonResult({ mailbox, message });
      },
    },
    {
      name: "m365_calendar_list",
      label: "List calendar",
      description:
        "List upcoming calendar events from the configured scoped Microsoft 365 mailbox calendar.",
      parameters: objectSchema({
        top: numberSchema({ minimum: 1, maximum: 25, default: 10 }),
      }),
      async execute(_toolCallId, params) {
        const args = readRecord(params);
        const top = readNumber(args, "top", 10);
        const { token, mailbox } = await graphToken(ctx);
        const select = "id,subject,start,end,organizer,attendees,location,bodyPreview,webLink";
        const now = new Date().toISOString();
        const path = `/users/${encodeURIComponent(
          mailbox,
        )}/events?$top=${top}&$orderby=start/dateTime&$filter=${encodeURIComponent(
          `start/dateTime ge '${now}'`,
        )}&$select=${encodeURIComponent(select)}`;
        const data = await graphJson<GraphPaged<GraphEvent>>({ token, path });
        return jsonResult({ mailbox, events: data.value ?? [] });
      },
    },
    {
      name: "m365_mail_draft_reply",
      label: "Draft mail reply",
      description: "Prepare a reply draft locally. This does not send email.",
      parameters: objectSchema(
        {
          messageId: stringSchema({ minLength: 1 }),
          body: stringSchema({ minLength: 1 }),
        },
        ["messageId", "body"],
      ),
      async execute(_toolCallId, params) {
        const args = readRecord(params);
        return jsonResult({
          action: "draft_only",
          messageId: readString(args, "messageId"),
          body: readString(args, "body") ?? "",
        });
      },
    },
    {
      name: "m365_mail_send",
      label: "Send mail",
      description:
        "Send email from the configured scoped mailbox. Requires plugin allowWrites=true and confirm='SEND'.",
      parameters: objectSchema(
        {
          to: arraySchema(stringSchema({ minLength: 1 }), { minItems: 1 }),
          subject: stringSchema({ minLength: 1 }),
          body: stringSchema({ minLength: 1 }),
          confirm: stringSchema(),
        },
        ["to", "subject", "body"],
      ),
      async execute(_toolCallId, params) {
        const args = readRecord(params);
        const { token, mailbox, allowWrites } = await graphToken(ctx);
        if (!allowWrites || readString(args, "confirm") !== "SEND") {
          throw new Error("m365_mail_send requires allowWrites=true and confirm='SEND'");
        }
        const to = Array.isArray(args.to)
          ? args.to.filter(
              (value): value is string => typeof value === "string" && value.trim().length > 0,
            )
          : [];
        await graphJson({
          token,
          path: `/users/${encodeURIComponent(mailbox)}/sendMail`,
          method: "POST",
          body: {
            message: {
              subject: readString(args, "subject"),
              body: { contentType: "Text", content: readString(args, "body") },
              toRecipients: to.map((address) => ({ emailAddress: { address } })),
            },
            saveToSentItems: true,
          },
        });
        return jsonResult({ sent: true, mailbox, to });
      },
    },
    {
      name: "m365_calendar_create",
      label: "Create calendar event",
      description:
        "Create a calendar event or meeting invitation in the configured scoped mailbox. Include attendees when scheduling with other people. Requires plugin allowWrites=true and confirm='CREATE'.",
      parameters: objectSchema(
        {
          subject: stringSchema({ minLength: 1 }),
          startDateTime: stringSchema({ minLength: 1 }),
          endDateTime: stringSchema({ minLength: 1 }),
          timeZone: stringSchema(),
          attendees: arraySchema(stringSchema({ minLength: 1 })),
          location: stringSchema(),
          body: stringSchema(),
          confirm: stringSchema(),
        },
        ["subject", "startDateTime", "endDateTime"],
      ),
      async execute(_toolCallId, params) {
        const args = readRecord(params);
        const { token, mailbox, allowWrites } = await graphToken(ctx);
        if (!allowWrites || readString(args, "confirm") !== "CREATE") {
          throw new Error("m365_calendar_create requires allowWrites=true and confirm='CREATE'");
        }
        const timeZone = readString(args, "timeZone") ?? "UTC";
        const attendees = readStringArray(args, "attendees");
        const location = readString(args, "location");
        const body = readString(args, "body");
        const event = await graphJson<GraphEvent>({
          token,
          path: `/users/${encodeURIComponent(mailbox)}/events`,
          method: "POST",
          body: {
            subject: readString(args, "subject"),
            start: { dateTime: readString(args, "startDateTime"), timeZone },
            end: { dateTime: readString(args, "endDateTime"), timeZone },
            ...(attendees.length ? { attendees: graphAttendees(attendees) } : {}),
            ...(location ? { location: { displayName: location } } : {}),
            ...(body ? { body: { contentType: "Text", content: body } } : {}),
          },
        });
        return jsonResult({ mailbox, event, attendees });
      },
    },
    {
      name: "m365_calendar_update",
      label: "Update calendar event",
      description:
        "Update a calendar event in the configured scoped mailbox. If attendees is provided, it replaces the event attendee list. Requires plugin allowWrites=true and confirm='UPDATE'.",
      parameters: objectSchema(
        {
          eventId: stringSchema({ minLength: 1 }),
          subject: stringSchema(),
          startDateTime: stringSchema(),
          endDateTime: stringSchema(),
          timeZone: stringSchema(),
          attendees: arraySchema(stringSchema({ minLength: 1 })),
          location: stringSchema(),
          body: stringSchema(),
          confirm: stringSchema(),
        },
        ["eventId"],
      ),
      async execute(_toolCallId, params) {
        const args = readRecord(params);
        const eventId = readString(args, "eventId");
        const { token, mailbox, allowWrites } = await graphToken(ctx);
        if (!eventId) {
          throw new Error("eventId required");
        }
        if (!allowWrites || readString(args, "confirm") !== "UPDATE") {
          throw new Error("m365_calendar_update requires allowWrites=true and confirm='UPDATE'");
        }
        const timeZone = readString(args, "timeZone") ?? "UTC";
        const body: Record<string, unknown> = {};
        const subject = readString(args, "subject");
        if (subject) {
          body.subject = subject;
        }
        const startDateTime = readString(args, "startDateTime");
        if (startDateTime) {
          body.start = { dateTime: startDateTime, timeZone };
        }
        const endDateTime = readString(args, "endDateTime");
        if (endDateTime) {
          body.end = { dateTime: endDateTime, timeZone };
        }
        const attendees = readStringArray(args, "attendees");
        if (attendees.length) {
          body.attendees = graphAttendees(attendees);
        }
        const location = readString(args, "location");
        if (location) {
          body.location = { displayName: location };
        }
        const eventBody = readString(args, "body");
        if (eventBody) {
          body.body = { contentType: "Text", content: eventBody };
        }
        const event = await graphJson<GraphEvent>({
          token,
          path: `/users/${encodeURIComponent(mailbox)}/events/${encodeURIComponent(eventId)}`,
          method: "PATCH",
          body,
        });
        return jsonResult({ mailbox, event, attendees });
      },
    },
    {
      name: "m365_calendar_respond",
      label: "Respond to calendar invite",
      description:
        "Accept, decline, or tentatively accept a calendar invitation in the configured scoped mailbox. Use this when the user asks to RSVP to an invite. Requires plugin allowWrites=true and confirm='RESPOND'.",
      parameters: objectSchema(
        {
          eventId: stringSchema({ minLength: 1 }),
          response: stringSchema({ enum: ["accept", "decline", "tentative"] }),
          comment: stringSchema(),
          sendResponse: booleanSchema({ default: true }),
          confirm: stringSchema(),
        },
        ["eventId", "response"],
      ),
      async execute(_toolCallId, params) {
        const args = readRecord(params);
        const eventId = readString(args, "eventId");
        const response = readString(args, "response");
        const { token, mailbox, allowWrites } = await graphToken(ctx);
        if (!eventId) {
          throw new Error("eventId required");
        }
        if (!allowWrites || readString(args, "confirm") !== "RESPOND") {
          throw new Error("m365_calendar_respond requires allowWrites=true and confirm='RESPOND'");
        }
        const action =
          response === "accept"
            ? "accept"
            : response === "decline"
              ? "decline"
              : response === "tentative"
                ? "tentativelyAccept"
                : undefined;
        if (!action) {
          throw new Error("response must be one of: accept, decline, tentative");
        }
        await graphJson({
          token,
          path: `/users/${encodeURIComponent(mailbox)}/events/${encodeURIComponent(eventId)}/${action}`,
          method: "POST",
          body: {
            comment: readString(args, "comment") ?? "",
            sendResponse: readBoolean(args, "sendResponse", true),
          },
        });
        return jsonResult({
          mailbox,
          eventId,
          response,
          sendResponse: readBoolean(args, "sendResponse", true),
          responded: true,
        });
      },
    },
  ];
}

export default definePluginEntry({
  id: "m365",
  name: "Microsoft 365 Graph",
  description: "Scoped Microsoft Graph mail and calendar tools for OpenClaw agents.",
  register(api) {
    api.registerTool((ctx) => createTools(ctx), { names: [...TOOL_NAMES] });
  },
});
