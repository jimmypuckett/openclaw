import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import m365Plugin from "./index.js";

const EXPECTED_TOOLS = [
  "m365_mail_search",
  "m365_mail_list_recent",
  "m365_mail_read",
  "m365_calendar_view",
  "m365_calendar_search",
  "m365_calendar_event_read",
  "m365_calendar_list",
  "m365_mail_draft_reply",
  "m365_mail_send",
  "m365_calendar_create",
  "m365_calendar_update",
  "m365_calendar_respond",
];

describe("M365 plugin registration", () => {
  it("registers the complete owner-scoped tool surface", () => {
    const registrations: Array<{
      tool: Parameters<OpenClawPluginApi["registerTool"]>[0];
      options: Parameters<OpenClawPluginApi["registerTool"]>[1];
    }> = [];
    m365Plugin.register?.(
      createTestPluginApi({
        id: "m365",
        name: "Microsoft 365 Graph",
        config: {},
        registerTool: (tool, options) => registrations.push({ tool, options }),
      }),
    );

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.options?.names).toEqual(EXPECTED_TOOLS);
    const factory = registrations[0]?.tool;
    expect(typeof factory).toBe("function");
    const tools = (factory as Exclude<typeof factory, AnyAgentTool>)({
      agentId: "ea-alex-wilber",
      agentAccountId: "ea-alex-wilber",
      messageChannel: "msteams",
      config: {},
      runtimeConfig: {},
      workspaceDir: "/tmp/ea-alex-wilber",
    });
    expect(Array.isArray(tools)).toBe(true);
    expect((tools as AnyAgentTool[]).map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  });

  it("does not expose a model-selectable mailbox parameter", () => {
    const registered: Array<Parameters<OpenClawPluginApi["registerTool"]>[0]> = [];
    m365Plugin.register?.(
      createTestPluginApi({
        id: "m365",
        name: "Microsoft 365 Graph",
        config: {},
        registerTool: (tool) => registered.push(tool),
      }),
    );
    const factory = registered[0] as Exclude<(typeof registered)[number], AnyAgentTool>;
    const tools = factory({
      agentId: "ea-alex-wilber",
      agentAccountId: "ea-alex-wilber",
      messageChannel: "msteams",
      config: {},
      runtimeConfig: {},
      workspaceDir: "/tmp/ea-alex-wilber",
    }) as AnyAgentTool[];

    for (const tool of tools) {
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
      expect(properties).not.toHaveProperty("mailbox");
      expect(properties).not.toHaveProperty("userId");
      expect(properties).not.toHaveProperty("userPrincipalName");
    }
  });
});
