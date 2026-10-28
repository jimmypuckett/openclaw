import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({ mutateConfigFileWithRetry: vi.fn() }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));
import { updateForgeToolIdentityConfig } from "./forge-tool-identity-config.js";

beforeEach(() => {
  mocks.mutateConfigFileWithRetry.mockReset();
});

describe.each(["github", "gitlab"] as const)("%s identity config mutation", (provider) => {
  const selection = () =>
    provider === "github"
      ? { provider, identity: { profileId: "ghp_" + "2".repeat(32), kind: "oauth" as const } }
      : {
          provider,
          identity: { profileId: "glp_" + "2".repeat(32), issuer: "https://gitlab.example.test" },
        };

  it.each([undefined, false, true])(
    "preserves sandbox opt-in %s across replacement and removes it on inherit",
    async (allowInSandbox) => {
      const sandboxPolicy = allowInSandbox === undefined ? {} : { allowInSandbox };
      const previousIdentity = {
        ...selection().identity,
        profileId: (provider === "github" ? "ghp_" : "glp_") + "1".repeat(32),
        ...sandboxPolicy,
      };
      const draft: OpenClawConfig = { agents: { entries: { main: { tools: {} } } } };
      const tools = draft.agents!.entries!.main!.tools!;
      // Install through the production writer, then replace an existing sandbox override.
      mocks.mutateConfigFileWithRetry.mockImplementation(async ({ mutate }) => {
        await mutate(draft);
        return { nextConfig: draft };
      });
      await updateForgeToolIdentityConfig({ ...selection(), scope: "agent", agentId: "main" });
      Object.assign(tools[provider]!, previousIdentity);
      await updateForgeToolIdentityConfig({ ...selection(), scope: "agent", agentId: "main" });
      expect(tools[provider]).toStrictEqual({ ...selection().identity, ...sandboxPolicy });
      await updateForgeToolIdentityConfig({ provider, scope: "agent", agentId: "main" });
      expect(tools[provider]).toBeUndefined();
      expect(draft.agents?.entries?.main?.tools).toBeUndefined();
    },
  );

  it("distinguishes expect-absent CAS from an unconditional system replacement", async () => {
    const draft: OpenClawConfig = {};
    mocks.mutateConfigFileWithRetry.mockImplementation(async ({ mutate }) => {
      await mutate(draft);
      return { nextConfig: draft };
    });
    await updateForgeToolIdentityConfig({
      ...selection(),
      scope: "system",
      agentId: "main",
      expectedIdentity: null,
    });
    const installed = structuredClone(draft);
    await expect(
      updateForgeToolIdentityConfig({
        ...selection(),
        scope: "system",
        agentId: "main",
        expectedIdentity: null,
      }),
    ).rejects.toThrow("identity changed");
    expect(draft).toEqual(installed);
    await updateForgeToolIdentityConfig({ provider, scope: "system", agentId: "main" });
    expect(draft.tools).toBeUndefined();
  });

  it("revalidates live owner authority inside every config retry", async () => {
    let current = true;
    const draft: OpenClawConfig = {};
    mocks.mutateConfigFileWithRetry.mockImplementation(async ({ mutate }) => {
      await mutate(structuredClone(draft));
      current = false;
      await mutate(draft);
      return { nextConfig: draft };
    });
    await expect(
      updateForgeToolIdentityConfig({
        ...selection(),
        scope: "system",
        agentId: "main",
        assertCurrent: () => {
          if (!current) {
            throw new Error("owner revoked");
          }
        },
      }),
    ).rejects.toThrow("owner revoked");
    expect(draft).toEqual({});
  });
});
