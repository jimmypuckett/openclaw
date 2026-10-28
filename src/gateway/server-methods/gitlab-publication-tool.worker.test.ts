import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../../plugin-sdk/plugin-test-contracts.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../../plugins/tool-factory-runtime.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createPersonalGitLabOAuthLifecycle } from "../gitlab-personal-oauth.js";
import {
  personalGitLabRequestDigest,
  type PersonalGitLabPublicationRow,
} from "../gitlab-personal-publication-store.js";
import { insertPersonalGitLabPublicationInDatabase } from "../gitlab-personal-publication-store.worker.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { resetTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { gitLabPublicationToolHandlers } from "./gitlab-publication-tool.js";
import { preparePersonalForgeAction } from "./personal-forge-authorization.js";

const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
  pluginId: "gitlab",
  artifactBasename: "index.ts",
});

afterEach(() => {
  resetTestPluginRegistry();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("keeps registered publication status private to its signed-in owner after OAuth revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const issuer = "https://gitlab.example.test";
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        gitlab: {
          issuer,
          clientId: "synthetic-client",
          redirectUri: "https://gateway.example.test/oauth/gitlab",
          projects: [91],
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const people = ["alice", "bob"].map((name) => {
      const id = name === "alice" ? 11 : 22;
      const profileId = ensureProfileForEmail(`${name}@example.test`).id;
      return {
        name,
        id,
        profileId,
        sessionKey: `agent:main:dashboard:${name}-publication`,
        sessionId: randomUUID(),
        requestId: "",
        client: createOperatorClient({
          profileId,
          scopes: ["operator.read", "operator.write"],
        }),
      };
    });
    const catalog = await prepareUserProfileCatalog();
    const service = createPersonalGitLabOAuthLifecycle(() => config);
    const handler = expectDefined(
      gitLabPublicationToolHandlers["tools.gitlab.publication.status"],
      "GitLab publication status handler",
    );
    const context = createContext(
      [
        [
          "tools.gitlab.publication.status",
          "operator.sessions.read",
          "gitlab-publication",
          handler,
        ],
      ],
      () => config,
    );
    context.gitlabOAuthService = service;
    context.getClientConnIds = (filter) =>
      new Set(
        people
          .filter(({ client }) => !filter || filter(client))
          .map(({ client }) => client.connId!),
      );
    const registration = createPluginRegistryFixture(config);
    registerTestPlugin({
      ...registration,
      record: createPluginRecord({
        id: "gitlab",
        origin: "bundled",
        contracts: {
          tools: ["gitlab_issues", "gitlab_publish"],
          gatewayMethodDispatch: ["authenticated-request"],
        },
      }),
      register: expectDefined(plugin.register, "GitLab plugin registration"),
    });
    const registry = registration.registry.registry;
    setActivePluginRegistry(registry);
    const entry = expectDefined(
      registry.tools.find(
        (candidate) =>
          candidate.pluginId === "gitlab" && candidate.names.includes("gitlab_publish"),
      ),
      "GitLab publication tool registration",
    );
    expect(entry.gatewayHandoffMethods).toEqual([
      "tools.gitlab.publication.publish",
      "tools.gitlab.publication.confirm",
    ]);
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe(issuer);
      expect(init?.redirect).toBe("error");
      if (url.pathname === "/oauth/token") {
        const code = (init!.body as URLSearchParams).get("code");
        return Response.json({
          access_token: `${code}-access`,
          refresh_token: `${code}-refresh`,
          token_type: "bearer",
          expires_in: 7200,
        });
      }
      const bearer = new Headers(init?.headers).get("Authorization");
      expect(bearer).not.toContain("ambient-bot");
      const person = expectDefined(
        people.find(({ name }) => bearer === `Bearer ${name}-access`),
        "Selected personal OAuth credential",
      );
      if (url.pathname === "/oauth/token/info") {
        return Response.json({ scope: ["api", "write_repository"] });
      }
      if (url.pathname === "/api/v4/user") {
        return Response.json({
          id: person.id,
          username: person.name,
          name: person.name,
          commit_email: `${person.name}@example.test`,
          bot: false,
        });
      }
      throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("GITLAB_TOKEN", "ambient-bot");
    try {
      for (const person of people) {
        const action = await preparePersonalForgeAction(
          { client: person.client, context },
          "operator.read",
          undefined,
          "GitLab",
        );
        const started = await service.start(action);
        await service.complete(
          action,
          started.requestId,
          `${config.gateway!.gitlab!.redirectUri}?code=${person.name}&state=${new URL(started.authorizationUrl).searchParams.get("state")}`,
        );
        const credential = await service.credential(action);
        const session = await upsertSessionEntryCore(
          { agentId: "main", sessionKey: person.sessionKey },
          {
            sessionId: person.sessionId,
            updatedAt: Date.now(),
            createdActor: { type: "human", source: "profile", id: person.profileId },
          },
        );
        const now = Date.now();
        const row: PersonalGitLabPublicationRow = {
          request_id: randomUUID(),
          owner_profile_id: person.profileId,
          issuer,
          connection_generation: credential.generation,
          idempotency_key: randomUUID(),
          request_digest: "",
          session_id: person.sessionId,
          session_key: person.sessionKey,
          agent_id: "main",
          session_lifecycle_revision: session?.lifecycleRevision ?? null,
          worktree_id: `worktree-${person.name}`,
          repository_fingerprint: `fingerprint-${person.name}`,
          identity_account_id: person.id,
          identity_login: person.name,
          branch: `topic-${person.name}`,
          receipt_json: "",
          status: "failed",
          gateway_instance_id: null,
          execution_id: null,
          head_commit: null,
          pull_request_url: null,
          error_code: "unavailable",
          next_action: "Inspect the original request before retrying.",
          last_effect: null,
          effect_state: null,
          push_observation: null,
          result_json: "",
          created_at_ms: now,
          updated_at_ms: now,
          reported_at_ms: null,
        };
        row.receipt_json = JSON.stringify({
          target: {
            issuer,
            projectId: 91,
            projectPath: "team/app",
            gitUrl: `${issuer}/team/app.git`,
            webUrl: `${issuer}/team/app`,
            baseBranch: "master",
          },
          sessionIdentity: {
            sessionId: person.sessionId,
            sessionKey: person.sessionKey,
            agentId: "main",
            lifecycleRevision: row.session_lifecycle_revision,
          },
          sourceId: row.worktree_id,
          worktreeId: row.worktree_id,
          repositoryRoot: state.workspaceDir,
          repositoryFingerprint: row.repository_fingerprint,
          actor: { accountId: person.id, login: person.name },
          title: "Draft: Synthetic publication",
          description: "Synthetic",
          draft: true,
          sourceHead: "a".repeat(40),
          baseTree: "b".repeat(40),
          workspaceHead: "c".repeat(40),
          sourceIndexTree: "b".repeat(40),
          branch: row.branch,
          createdAtMs: now,
          previousHeadCommit: null,
        });
        row.request_digest = personalGitLabRequestDigest(row);
        row.result_json = JSON.stringify({
          status: "failed",
          requestId: row.request_id,
          code: "unavailable",
          message: "Synthetic response uncertain.",
          nextAction: row.next_action,
        });
        runOpenClawStateWriteTransaction((database) =>
          insertPersonalGitLabPublicationInDatabase(database, row, () => {}),
        );
        person.requestId = row.request_id;
      }
      const invoke = async (
        person: (typeof people)[number],
        operation:
          | { action: "status"; requestId: string }
          | { action: "publish"; title: string; draft: true; bootstrapDraft: true },
      ) => {
        const captured = expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: person.client,
            context,
            hasCurrentClientAuthority: () => !person.client.invalidated,
          }),
          "Admitted requester authority",
        );
        let current = true;
        const factoryContext = createPluginToolFactoryContext({
          entry,
          registry,
          context: { agentId: "main", sessionKey: person.sessionKey },
          assertInvocationCurrent: () => {
            if (!current) {
              throw new Error("tool retired");
            }
          },
        });
        const raw = entry.factory(factoryContext);
        if (!raw || Array.isArray(raw)) {
          throw new Error("GitLab publication tool missing");
        }
        const tool = bindPluginToolCallbacks(
          entry,
          registry,
          raw,
          factoryContext.assertInvocationCurrent,
        );
        try {
          return await withPluginRuntimeGatewayRequestScope(
            { client: person.client, context, isWebchatConnect: () => false },
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: person.sessionKey,
                  operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
                  operatorAuthority: captured.authority,
                  receiptAuthority: () => current,
                  assertToolAllowed: (name) => {
                    if (name !== "gitlab_publish") {
                      throw new Error("tool denied");
                    }
                  },
                  gatewayContextResolver: () => context,
                },
                () => tool.execute(randomUUID(), operation),
              ),
          );
        } finally {
          current = false;
          captured.release();
        }
      };
      const alice = people[0]!;
      const bob = people[1]!;
      const aliceRequestId = alice.requestId;
      const bobRequestId = bob.requestId;
      const fetchCount = fetcher.mock.calls.length;
      await expect(
        invoke(alice, {
          action: "publish",
          title: "Draft: Synthetic publication",
          draft: true,
          bootstrapDraft: true,
        }),
      ).rejects.toThrow("native conversation handoff support");
      expect(fetcher).toHaveBeenCalledTimes(fetchCount);
      await expect(
        invoke(alice, { action: "status", requestId: aliceRequestId }),
      ).resolves.toMatchObject({
        details: { result: { requestId: aliceRequestId, status: "failed", code: "unavailable" } },
      });
      await expect(invoke(bob, { action: "status", requestId: aliceRequestId })).rejects.toThrow();
      await expect(
        invoke(bob, { action: "status", requestId: bobRequestId }),
      ).resolves.toMatchObject({
        details: { result: { requestId: bobRequestId, status: "failed", code: "unavailable" } },
      });
      // A terminal accepted receipt remains visible after the selected grant is gone.
      await service.disconnect(
        await preparePersonalForgeAction(
          { client: alice.client, context },
          "operator.read",
          undefined,
          "GitLab",
        ),
      );
      alice.client.connect.scopes = ["operator.sessions.read"];
      await expect(
        invoke(alice, { action: "status", requestId: aliceRequestId }),
      ).resolves.toMatchObject({
        details: { result: { requestId: aliceRequestId, status: "failed", code: "unavailable" } },
      });
      expect(
        fetcher.mock.calls.every(
          ([, init]) => new Headers(init?.headers).get("Authorization") !== "Bearer ambient-bot",
        ),
      ).toBe(true);
    } finally {
      await service.stop();
      catalog.release();
    }
  });
});
