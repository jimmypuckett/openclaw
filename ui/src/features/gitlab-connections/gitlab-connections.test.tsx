import { createSignal } from "solid-js";
/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { GitLabConnections } from "./gitlab-connections.tsx";

const issuer = "https://gitlab.example.test";
const account = {
  accountId: 47,
  login: "alice",
  name: "Alice",
  commitEmail: "alice@example.test",
  issuer,
};
const connected = {
  configured: true,
  issuer,
  connected: true,
  account,
  scopes: ["api", "write_repository"],
  reconnectRequired: false,
};
const disconnected = {
  configured: true,
  issuer,
  connected: false,
  account: null,
  scopes: [],
  reconnectRequired: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const initial = {
    client,
    phase: "connected",
    hello: gatewayHelloForMethods([], ["operator.read"]),
    selfUser: { id: "person-a" },
  } as ApplicationGatewaySnapshot;
  const { gateway, publish } = createApplicationGateway(initial);
  const context = { gateway } as ApplicationContext;
  const rendered = mountSolid(GitLabConnections, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const button = (label: string) =>
    [...rendered.container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === label,
    );
  return {
    ...rendered,
    button,
    emit(next: Partial<ApplicationGatewaySnapshot>) {
      publish({ ...gateway.snapshot, ...next });
      flush();
    },
    replaceProfile(id: string) {
      publish({ ...gateway.snapshot, selfUser: { id } });
      flush();
    },
  };
}

it("hides an unconfigured GitLab connection", async () => {
  const request = vi.fn(async () => ({ configured: false }));
  const ui = mount(request);
  await waitForSolid(() => expect(request).toHaveBeenCalledWith("users.gitlab.status", {}));
  expect(ui.container.querySelector("[data-gitlab-connections]")).toBeNull();
  ui.unmount();
});

it("opens the existing browser authorization when selected from Add provider", async () => {
  const request = vi.fn(async (method: string) =>
    method === "users.gitlab.status"
      ? disconnected
      : {
          requestId: "request-1",
          authorizationUrl: `${issuer}/oauth/authorize?state=synthetic`,
          expiresAtMs: Date.now() + 60_000,
        },
  );
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway } = createApplicationGateway({
    client,
    phase: "connected",
    hello: gatewayHelloForMethods([], ["operator.read"]),
    selfUser: { id: "person-a" },
  } as ApplicationGatewaySnapshot);
  let connect!: () => void;
  const available = vi.fn();
  const ui = mountSolid(
    () => {
      const [connectRequest, setConnectRequest] = createSignal(0);
      connect = () => setConnectRequest((value) => value + 1);
      return <GitLabConnections connectRequest={connectRequest()} onAvailable={available} />;
    },
    { wrapper: createSolidApplicationContextProvider({ gateway } as ApplicationContext).wrapper },
  );
  await waitForSolid(() => expect(available).toHaveBeenCalledWith(true));
  connect();
  flush();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.gitlab.authorize.start", {}),
  );
  await waitForSolid(() =>
    expect(ui.container.querySelector("a[href*='/oauth/authorize']")).not.toBeNull(),
  );
  ui.unmount();
});

it("shows the verified personal publisher and disconnects without a fallback", async () => {
  const request = vi.fn(async (method: string) =>
    method === "users.gitlab.status" ? connected : { disconnected: true },
  );
  const ui = mount(request);
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain("GitLab publications use @alice"),
  );
  expect(ui.container.textContent).not.toContain("alice@example.test");
  expect(ui.container.textContent).toContain(issuer);
  ui.button("Disconnect")?.click();
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain("No GitLab account connected"),
  );
  expect(request).toHaveBeenCalledWith("users.gitlab.disconnect", {});
  expect(ui.container.textContent).not.toContain("system account");
  ui.unmount();
});

it("starts a browser authorization and clears the concealed final redirect after completion", async () => {
  const pending = {
    requestId: "a624ff9e-4018-4f6a-aab7-88c619d5d03b",
    authorizationUrl: `${issuer}/oauth/authorize?client_id=test&state=opaque`,
    expiresAtMs: Date.now() + 60_000,
  };
  const request = vi.fn(async (method: string) => {
    if (method === "users.gitlab.status") {
      return disconnected;
    }
    if (method === "users.gitlab.authorize.start") {
      return pending;
    }
    return connected;
  });
  const ui = mount(request);
  await waitForSolid(() => expect(ui.button("Connect GitLab")).toBeDefined());
  ui.button("Connect GitLab")?.click();
  await waitForSolid(() =>
    expect(
      ui.container.querySelector<HTMLAnchorElement>("a[href*='/oauth/authorize']"),
    ).not.toBeNull(),
  );
  const link = ui.container.querySelector<HTMLAnchorElement>("a[href*='/oauth/authorize']")!;
  expect(link.href).toBe(pending.authorizationUrl);
  expect(link.rel).toContain("noopener");
  const input = ui.container.querySelector<HTMLInputElement>(
    "input[aria-label='Final GitLab redirect URL']",
  )!;
  expect(input.type).toBe("password");
  const callbackUrl = "https://app.example.test/oauth/callback?code=secret&state=opaque";
  input.value = callbackUrl;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  ui.button("Finish GitLab connection")?.click();
  expect(input.value).toBe("");
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain("GitLab publications use @alice"),
  );
  expect(request).toHaveBeenCalledWith("users.gitlab.authorize.complete", {
    requestId: pending.requestId,
    callbackUrl,
  });
  ui.unmount();
});

it("drops late status and authorization after the profile changes", async () => {
  const lateStatus = deferred<typeof connected>();
  const lateStart = deferred<{
    requestId: string;
    authorizationUrl: string;
    expiresAtMs: number;
  }>();
  let statusCount = 0;
  const request = vi.fn((method: string) => {
    if (method === "users.gitlab.status") {
      statusCount += 1;
      return statusCount === 1 ? Promise.resolve(disconnected) : lateStatus.promise;
    }
    return lateStart.promise;
  });
  const ui = mount(request);
  await waitForSolid(() => expect(ui.button("Connect GitLab")).toBeDefined());
  ui.button("Connect GitLab")?.click();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.gitlab.authorize.start", {}),
  );
  ui.replaceProfile("person-b");
  lateStart.resolve({
    requestId: "a624ff9e-4018-4f6a-aab7-88c619d5d03b",
    authorizationUrl: `${issuer}/oauth/authorize?state=old`,
    expiresAtMs: Date.now() + 60_000,
  });
  lateStatus.resolve(connected);
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain("GitLab publications use @alice"),
  );
  expect(ui.container.querySelector("a[href*='/oauth/authorize']")).toBeNull();
  ui.unmount();
});

it("clears the final redirect and ignores late completion when the client changes", async () => {
  const complete = deferred<typeof connected>();
  const pending = {
    requestId: "a624ff9e-4018-4f6a-aab7-88c619d5d03b",
    authorizationUrl: `${issuer}/oauth/authorize?state=opaque`,
    expiresAtMs: Date.now() + 60_000,
  };
  const request = vi.fn((method: string) => {
    if (method === "users.gitlab.status") {
      return Promise.resolve(disconnected);
    }
    if (method === "users.gitlab.authorize.start") {
      return Promise.resolve(pending);
    }
    return complete.promise;
  });
  const ui = mount(request);
  await waitForSolid(() => expect(ui.button("Connect GitLab")).toBeDefined());
  ui.button("Connect GitLab")?.click();
  await waitForSolid(() =>
    expect(ui.container.querySelector<HTMLInputElement>("input[type='password']")).not.toBeNull(),
  );
  const input = ui.container.querySelector<HTMLInputElement>("input[type='password']")!;
  input.value = "https://app.example.test/oauth/callback?code=secret&state=opaque";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  ui.button("Finish GitLab connection")?.click();
  expect(input.value).toBe("");
  ui.emit({
    client: {
      request: vi.fn(async () => ({ configured: false })),
    } as unknown as GatewayBrowserClient,
  });
  complete.resolve(connected);
  await waitForSolid(() =>
    expect(ui.container.querySelector("[data-gitlab-connections]")).toBeNull(),
  );
  expect(ui.container.textContent).not.toContain("@alice");
  ui.unmount();
});

it("rejects an authorization link outside the configured GitLab issuer", async () => {
  const request = vi.fn(async (method: string) =>
    method === "users.gitlab.status"
      ? disconnected
      : {
          requestId: "a624ff9e-4018-4f6a-aab7-88c619d5d03b",
          authorizationUrl: "https://other.example.test/oauth/authorize?state=opaque",
          expiresAtMs: Date.now() + 60_000,
        },
  );
  const ui = mount(request);
  await waitForSolid(() => expect(ui.button("Connect GitLab")).toBeDefined());
  ui.button("Connect GitLab")?.click();
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain("Could not start GitLab sign-in"),
  );
  expect(ui.container.querySelector("a[href*='/oauth/authorize']")).toBeNull();
  ui.unmount();
});
