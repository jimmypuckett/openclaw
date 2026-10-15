import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMSTeamsAccount, resolveMSTeamsAccountConfig } from "./accounts.js";
import { msteamsConfigAdapter } from "./channel-config.js";

describe("msteams account selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("inspects unresolved account SecretRefs without resolving them", () => {
    const sourceConfig = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: {
                source: "env",
                provider: "default",
                id: "SUPPORT_MSTEAMS_SECRET",
              },
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    resolvedConfig.channels!.msteams!.accounts!.support!.appPassword = "resolved-secret";

    expect(msteamsConfigAdapter.inspectAccount?.(sourceConfig, "support")).toMatchObject({
      accountId: "support",
      configured: true,
      tokenStatus: "configured_unavailable",
      path: "/hooks/3979",
    });
    expect(msteamsConfigAdapter.inspectAccount?.(resolvedConfig, "support")).toMatchObject({
      accountId: "support",
      configured: true,
      tokenStatus: "available",
      path: "/hooks/3979",
    });
  });

  it("does not resolve legacy root credentials for arbitrary named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "app-id",
          appPassword: "secret",
          tenantId: "tenant-id",
        },
      },
    };
    const resolved = resolveMSTeamsAccountConfig(cfg, "typo-account");

    expect(resolved.appId).toBeUndefined();
    expect(resolved.appPassword).toBeUndefined();
    expect(resolved.tenantId).toBe("tenant-id");
    expect(resolveMSTeamsAccount({ cfg, accountId: "typo-account" })).toMatchObject({
      accountId: "typo-account",
      configured: false,
    });
  });

  it("keeps identity when resolving an already account-scoped named account config", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          defaultAccount: "secondary",
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } satisfies OpenClawConfig;

    const secondary = resolveMSTeamsAccountConfig(cfg, "secondary");

    expect(secondary.appId).toBe("secondary-app-id");
    expect(secondary.appPassword).toBe("secondary-secret");
    expect(secondary.tenantId).toBe("tenant-id");
    expect(secondary.webhook).toEqual({ path: "/api/messages" });
    expect(resolveMSTeamsAccount({ cfg, accountId: "secondary" }).configured).toBe(true);
  });

  it("keeps inbound tenant policy account-local", () => {
    const rootTenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const supportTenant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const cfg = {
      channels: {
        msteams: {
          tenantId: "registration-tenant",
          allowedInboundTenantIds: [rootTenant],
          accounts: {
            support: { appId: "support-app", appPassword: "support-secret" },
            restricted: {
              appId: "restricted-app",
              appPassword: "restricted-secret",
              allowedInboundTenantIds: [supportTenant],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveMSTeamsAccountConfig(cfg, "default").allowedInboundTenantIds).toEqual([
      rootTenant,
    ]);
    expect(resolveMSTeamsAccountConfig(cfg, "support").allowedInboundTenantIds).toBeUndefined();
    expect(resolveMSTeamsAccountConfig(cfg, "restricted").allowedInboundTenantIds).toEqual([
      supportTenant,
    ]);
  });
});
