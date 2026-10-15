import { afterEach, describe, expect, it } from "vitest";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import {
  createConfig,
  createRuntime,
  createStores,
  updateMSTeamsConfig,
} from "./monitor-lifecycle.test-helpers.js";
import {
  createMSTeamsActivityHandler,
  isSigninInvokeAuthorized,
  loadMSTeamsSdkWithAuth,
  nativeSdkState,
  processSdkActivity,
  resetMSTeamsMonitorMocks,
  routeState,
  ssoTokenStore,
} from "./monitor-lifecycle.test-support.js";
import {
  createMessageEvent,
  createNativeSsoProcessor,
  createSigninEvent,
  FIXTURE_TENANT_ID,
  FOREIGN_TENANT_ID,
} from "./monitor-sso.test-helpers.js";
import { monitorMSTeamsProvider } from "./monitor.js";

function runProvider(abort: AbortController, cfg = createConfig()) {
  return monitorMSTeamsProvider({
    cfg,
    runtime: createRuntime(),
    abortSignal: abort.signal,
    ...createStores(),
  });
}

async function resolveSdkApp() {
  const result = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
  if (!result) {
    throw new Error("expected loadMSTeamsSdkWithAuth result");
  }
  return (await result).app;
}

describe("Microsoft Teams inbound tenant policy", () => {
  afterEach(resetMSTeamsMonitorMocks);

  it("rejects invalid tenant metadata before ordinary SDK processing and durable admission", async () => {
    const { app: nativeApp, requests } = await createNativeSsoProcessor();
    nativeSdkState.app = nativeApp;
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, { allowedInboundTenantIds: [FIXTURE_TENANT_ID] });
    const task = runProvider(abort, cfg);

    try {
      await routeState.ready.promise;
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
      const app = await resolveSdkApp();
      const missing = createMessageEvent();
      delete (missing.body as { channelData?: unknown }).channelData;
      delete (missing.body.conversation as { tenantId?: string }).tenantId;
      const malformed = createMessageEvent();
      malformed.body.conversation.tenantId = "not-a-tenant-uuid";
      const invalidVersion = createMessageEvent("aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa");
      const invalidVariant = createMessageEvent("aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa");
      const conflicting = createMessageEvent();
      conflicting.body.conversation.tenantId = FOREIGN_TENANT_ID;
      const foreign = createMessageEvent(FOREIGN_TENANT_ID);

      for (const event of [
        missing,
        malformed,
        invalidVersion,
        invalidVariant,
        conflicting,
        foreign,
      ]) {
        await expect(app.process(event)).resolves.toEqual({ status: 200, body: {} });
      }

      const ingress = getMSTeamsIngressMockState().instances[0];
      expect(processSdkActivity).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      expect(ingress?.accept).not.toHaveBeenCalled();
      expect(createMSTeamsActivityHandler.mock.results[0]?.value).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await task;
    }
  });

  it("rechecks durable activities against the current tenant policy", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, { allowedInboundTenantIds: [FIXTURE_TENANT_ID] });
    const task = runProvider(abort, cfg);

    try {
      await routeState.ready.promise;
      const ingress = getMSTeamsIngressMockState().instances[0];
      const handler = createMSTeamsActivityHandler.mock.results[0]?.value;
      if (!ingress || !handler) {
        throw new Error("expected Teams ingress and activity handler");
      }
      const foreign = createMessageEvent(FOREIGN_TENANT_ID).body;
      const foreignContext = { activity: foreign };

      await ingress.options.dispatch(foreign, {}, foreignContext);
      expect(handler).not.toHaveBeenCalled();

      const allowed = createMessageEvent(FIXTURE_TENANT_ID).body;
      await ingress.options.dispatch(allowed, {}, { activity: allowed });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await task;
    }
  });

  it("rejects a foreign token exchange before SDK token lookup", async () => {
    const { app: nativeApp, requests } = await createNativeSsoProcessor();
    nativeSdkState.app = nativeApp;
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      allowedInboundTenantIds: [FIXTURE_TENANT_ID],
      sso: { enabled: true, connectionName: "graph" },
    });
    const task = runProvider(abort, cfg);

    try {
      await routeState.ready.promise;
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
      const app = await resolveSdkApp();

      await expect(
        app.process(createSigninEvent("signin/tokenExchange", "29:foreign", FOREIGN_TENANT_ID)),
      ).resolves.toEqual({ status: 200, body: {} });
      expect(processSdkActivity).not.toHaveBeenCalled();
      expect(isSigninInvokeAuthorized).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      expect(ssoTokenStore.save).not.toHaveBeenCalled();
      expect(getMSTeamsIngressMockState().instances[0]?.accept).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await task;
    }
  });

  it("preserves ordinary SDK processing when tenant policy is unconfigured", async () => {
    const { app: nativeApp } = await createNativeSsoProcessor();
    nativeSdkState.app = nativeApp;
    const abort = new AbortController();
    const task = runProvider(abort);

    try {
      await routeState.ready.promise;
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
      const app = await resolveSdkApp();
      const event = createMessageEvent(FOREIGN_TENANT_ID);

      await expect(app.process(event)).resolves.toEqual({ status: 200 });
      expect(processSdkActivity).toHaveBeenCalledExactlyOnceWith(event);
      expect(getMSTeamsIngressMockState().instances[0]?.accept).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await task;
    }
  });
});
