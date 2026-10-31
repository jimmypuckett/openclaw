import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import {
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
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
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGitHubPublicationSession } from "../github-publication-availability.js";
import { readPersonalGitLabPublicationAsync } from "../github-publication-store-async.js";
import { createPersonalGitLabOAuthLifecycle } from "../gitlab-personal-oauth.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  withAcceptedPluginGatewayHandoffClaim,
  type AcceptedPluginGatewayHandoffClaim,
} from "../plugin-tool-handoff-claim.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { resetTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { gitLabPublicationToolHandlers } from "./gitlab-publication-tool.js";
import { preparePersonalForgeAction } from "./personal-forge-authorization.js";

const publicationTransport = vi.hoisted(() => ({ remoteHead: null as string | null, pushes: 0 }));
const checkoutTransport = vi.hoisted(() => ({
  fixturePath: "",
  calls: 0,
  actor: "alice" as "alice" | "bob",
  afterTransfer: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../process/exec.js", async (original) => {
  const actual = await original<typeof import("../../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: (async (argv, options) => {
      const url = "https://gitlab.example.test/group/repo.git";
      if (!checkoutTransport.fixturePath || !argv.includes(url)) {
        return actual.runCommandWithTimeout(argv, options);
      }
      const env = typeof options === "object" ? options.env : undefined;
      expect(typeof options === "object" && options.baseEnv).toEqual({});
      expect(env?.GIT_CONFIG_KEY_0?.toLowerCase()).toBe(`http.${url}.extraheader`);
      expect(env?.GIT_CONFIG_VALUE_0).toBe(
        `Authorization: Basic ${Buffer.from(`oauth2:${checkoutTransport.actor}-access`).toString("base64")}`,
      );
      expect(env?.GIT_CONFIG_KEY_1).toBe("http.followRedirects");
      expect(env?.GIT_CONFIG_VALUE_1).toBe("false");
      expect(env?.GIT_CONFIG_KEY_2).toBe("credential.helper");
      expect(env?.GIT_CONFIG_VALUE_2).toBe("");
      expect(env?.GITLAB_TOKEN).toBeUndefined();
      expect(env?.GIT_ASKPASS).toBeUndefined();
      expect(argv.join(" ")).not.toMatch(/alice-access|bob-access|ambient-bot/u);
      checkoutTransport.calls++;
      // Replace only the external transport. Git still clones/fetches real objects,
      // and the canonical URL remains the saved origin rather than the fixture path.
      const result = await actual.runCommandWithTimeout(
        [
          argv[0]!,
          "-c",
          `url.file://${checkoutTransport.fixturePath}.insteadOf=${url}`,
          ...argv.slice(1),
        ],
        options,
      );
      const afterTransfer = checkoutTransport.afterTransfer;
      checkoutTransport.afterTransfer = undefined;
      await afterTransfer?.();
      return result;
    }) satisfies typeof actual.runCommandWithTimeout,
  };
});
vi.mock("../gitlab-publication-git.js", async (original) => ({
  ...(await original<typeof import("../gitlab-publication-git.js")>()),
  observeGitLabPublicationHead: async () => publicationTransport.remoteHead,
  pushGitLabPublicationCommit: async ({ git }: { git: { headCommit: string } }) => {
    publicationTransport.pushes++;
    publicationTransport.remoteHead = git.headCommit;
  },
}));

const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
  pluginId: "gitlab",
  artifactBasename: "index.ts",
});

afterEach(() => {
  resetTestPluginRegistry();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  checkoutTransport.fixturePath = "";
  checkoutTransport.calls = 0;
  checkoutTransport.actor = "alice";
  checkoutTransport.afterTransfer = undefined;
});

it.each([
  "normal",
  "lost-mr-response",
  "canonical-mismatch",
  "policy-revoked",
  "revoked",
  "checkout",
  "checkout-policy-revoked",
  "checkout-connection-revoked",
  "checkout-requester-revoked",
  "checkout-workspace-revoked",
  "checkout-project-replaced",
] as const)("keeps requester publication authority through native RPC (%s)", async (scenario) => {
  const lostMrResponse = scenario === "lost-mr-response";
  const checkout =
    scenario === "checkout" ||
    scenario === "checkout-policy-revoked" ||
    scenario === "checkout-connection-revoked" ||
    scenario === "checkout-requester-revoked" ||
    scenario === "checkout-workspace-revoked" ||
    scenario === "checkout-project-replaced";
  const unbound = checkout || scenario === "canonical-mismatch" || scenario === "policy-revoked";
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-rpc-publication-"));
    let cwd = path.join(repoRoot, "topic");
    let branch = "topic";
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_SYSTEM: os.devNull,
          GIT_TERMINAL_PROMPT: "0",
        },
      }).trim();
    const worktreeGit = (...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_SYSTEM: os.devNull,
          GIT_TERMINAL_PROMPT: "0",
        },
      }).trim();
    const issuer = "https://gitlab.example.test";
    const project = {
      id: 17,
      path_with_namespace: "group/repo",
      http_url_to_repo: `${issuer}/group/repo.git`,
      web_url: `${issuer}/group/repo`,
      default_branch: "master",
    };
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        gitlab: {
          issuer,
          clientId: "synthetic-client",
          redirectUri: "https://gateway.example.test/oauth/gitlab",
          projects: [17],
        },
      },
    };
    let projectMetadataFetched = false;
    let projectPolicyReadsAfterMetadata = 0;
    if (scenario === "policy-revoked") {
      Object.defineProperty(config.gateway!.gitlab!, "projects", {
        enumerable: true,
        get() {
          if (!projectMetadataFetched) {
            return [17];
          }
          projectPolicyReadsAfterMetadata++;
          return projectPolicyReadsAfterMetadata <= 2 ? [17] : [99];
        },
      });
    }
    setRuntimeConfigSnapshot(config);
    const catalog = await prepareUserProfileCatalog();
    const service = createPersonalGitLabOAuthLifecycle(() => config);
    try {
      git("init", "--initial-branch=master");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.test");
      await fs.writeFile(path.join(repoRoot, "artifact.txt"), "base\n");
      git("add", "artifact.txt");
      git("commit", "-m", "Synthetic source");
      const source = git("rev-parse", "HEAD");
      git("worktree", "add", "-b", "topic", cwd);
      git("remote", "add", "origin", project.http_url_to_repo);
      publicationTransport.remoteHead = null;
      publicationTransport.pushes = 0;
      const aliceProfile = ensureProfileForEmail("rpc-alice@example.test").id;
      const bobProfile = ensureProfileForEmail("rpc-bob@example.test").id;
      const alice = createOperatorClient({
        profileId: aliceProfile,
        scopes: ["operator.read", "operator.write", ...(unbound ? ["operator.admin"] : [])],
      });
      alice.internal = { ...alice.internal, operatorAccessAuthority: null };
      const bob = createOperatorClient({
        profileId: bobProfile,
        scopes: ["operator.read", "operator.write"],
      });
      bob.internal = { ...bob.internal, operatorAccessAuthority: null };
      const sessionId = randomUUID();
      const sessionKey = `agent:main:dashboard:${randomUUID()}`;
      const worktreeId = randomUUID();
      if (!unbound) {
        await insertRegistryWorktree(process.env, {
          id: worktreeId,
          path: cwd,
          repoRoot,
          repoFingerprint: `rpc-${sessionId}`,
          branch: "topic",
          name: "topic",
          baseRef: "origin/master",
          ownerKind: "session",
          ownerId: sessionKey,
          createdAt: 1_000,
          lastActiveAt: 1_000,
        });
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: aliceProfile },
          ...(unbound ? {} : { worktree: { id: worktreeId, repoRoot, branch: "topic" } }),
        },
      );
      const handler = expectDefined(
        gitLabPublicationToolHandlers["tools.gitlab.publication.publish"],
        "registered publish handler",
      );
      const statusHandler = expectDefined(
        gitLabPublicationToolHandlers["tools.gitlab.publication.status"],
        "registered status handler",
      );
      const confirmHandler = expectDefined(
        gitLabPublicationToolHandlers["tools.gitlab.publication.confirm"],
        "registered confirm handler",
      );
      const checkoutHandlers: NonNullable<Parameters<typeof createContext>[0]> = checkout
        ? ["prepare", "refresh"].map((action) => [
            `tools.gitlab.publication.${action}`,
            "operator.sessions.write",
            "gitlab-publication",
            expectDefined(
              gitLabPublicationToolHandlers[`tools.gitlab.publication.${action}`],
              `registered ${action} handler`,
            ),
          ])
        : [];
      const context = createContext(
        [
          ...checkoutHandlers,
          [
            "tools.gitlab.publication.publish",
            "operator.sessions.write",
            "gitlab-publication",
            handler,
          ],
          [
            "tools.gitlab.publication.status",
            "operator.sessions.read",
            "gitlab-publication",
            statusHandler,
          ],
          [
            "tools.gitlab.publication.confirm",
            "operator.sessions.write",
            "gitlab-publication",
            confirmHandler,
          ],
        ],
        () => config,
      );
      context.gitlabOAuthService = service;
      context.getSessionEventSubscriberConnIds = () => new Set();
      context.getClientConnIds = (filter) =>
        new Set(
          [alice, bob]
            .filter((client) => !filter || filter(client))
            .map((client) => client.connId!),
        );
      context.workerSessionPlacementService = {
        workspaceResultInstanceId: () => "rpc-fixture-instance",
        withLocalWorkspaceReservation: async (_target, run) => run(() => {}),
      } as typeof context.workerSessionPlacementService;
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
      setActivePluginRegistry(registration.registry.registry);
      const entry = expectDefined(
        registration.registry.registry.tools.find(
          (candidate) =>
            candidate.pluginId === "gitlab" && candidate.names.includes("gitlab_publish"),
        ),
        "GitLab publication tool registration",
      );
      const mrs: Array<Record<string, unknown>> = [];
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
        const actor =
          bearer === "Bearer alice-access" ? 11 : bearer === "Bearer bob-access" ? 22 : 0;
        expect(actor).not.toBe(0);
        if (url.pathname === "/oauth/token/info") {
          return Response.json({ scope: ["api", "write_repository"] });
        }
        if (url.pathname === "/api/v4/user") {
          return Response.json({
            id: actor,
            username: actor === 11 ? "alice" : "bob",
            name: actor === 11 ? "Alice Human" : "Bob Human",
            commit_email: actor === 11 ? "alice@example.test" : "bob@example.test",
            bot: false,
          });
        }
        expect(actor).toBe(checkoutTransport.actor === "alice" ? 11 : 22);
        const endpoint = url.pathname.replace("/api/v4/", "");
        if (endpoint === "projects/group%2Frepo" || endpoint === "projects/17") {
          if (endpoint === "projects/group%2Frepo") {
            projectMetadataFetched = true;
          }
          return Response.json(
            scenario === "canonical-mismatch" && endpoint === "projects/group%2Frepo"
              ? { ...project, web_url: "https://different.example.test/group/repo" }
              : project,
          );
        }
        if (endpoint === "projects/17/repository/branches/master") {
          return Response.json({ name: "master", commit: { id: source } });
        }
        if (endpoint === `projects/17/repository/branches/${encodeURIComponent(branch)}`) {
          return publicationTransport.remoteHead
            ? Response.json({ name: branch, commit: { id: publicationTransport.remoteHead } })
            : Response.json({}, { status: 404 });
        }
        if (endpoint === `projects/17/repository/commits/${source}`) {
          return Response.json({ id: source });
        }
        if (endpoint === "projects/17/merge_requests" && init?.method === "GET") {
          return Response.json(mrs);
        }
        if (endpoint === "projects/17/merge_requests" && init?.method === "POST") {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "") as {
            description: string;
            title: string;
          };
          mrs.push({
            iid: 9,
            web_url: `${project.web_url}/-/merge_requests/9`,
            state: "opened",
            source_project_id: 17,
            target_project_id: 17,
            source_branch: branch,
            target_branch: "master",
            sha: publicationTransport.remoteHead,
            author: { id: actor },
            description: body.description,
            title: body.title,
          });
          if (lostMrResponse) {
            throw new Error("Synthetic MR response lost after creation");
          }
          return Response.json(mrs[0]);
        }
        if (endpoint === "projects/17/merge_requests/9") {
          return Response.json(mrs[0]);
        }
        throw new Error(`Unexpected synthetic endpoint ${init?.method} ${endpoint}`);
      });
      vi.stubGlobal("fetch", fetcher);
      vi.stubEnv("GITLAB_TOKEN", "ambient-bot");
      for (const [client, name] of [
        [alice, "alice"],
        [bob, "bob"],
      ] as const) {
        const action = await preparePersonalForgeAction(
          { client, context },
          "operator.read",
          undefined,
          "GitLab",
        );
        const started = await service.start(action);
        await service.complete(
          action,
          started.requestId,
          `${config.gateway!.gitlab!.redirectUri}?code=${name}&state=${new URL(started.authorizationUrl).searchParams.get("state")}`,
        );
      }
      const requesterLifetime = new AbortController();
      const captured = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: alice,
          context,
          hasCurrentClientAuthority: () => !alice.invalidated,
          invocationAuthority: {
            signal: requesterLifetime.signal,
            assertCurrent: () => requesterLifetime.signal.throwIfAborted(),
          },
        }),
        "Alice run authority",
      );
      let current = true;
      const operation = {
        action: "publish" as const,
        title: "Draft: Initial work",
        draft: true,
        bootstrapDraft: !checkout,
        ...(unbound && !checkout ? { workspacePath: cwd } : {}),
      };
      const params = { sessionKey, agentId: "main", idempotencyKey: randomUUID(), operation };
      const claim = {
        pluginId: "gitlab",
        toolName: "gitlab_publish",
        method: "tools.gitlab.publication.publish",
        params,
        agentId: "main",
        sessionKey,
        sessionId,
        operatorAuthority: captured.authority,
        signal: new AbortController().signal,
        assertCurrent() {
          if (!current) {
            throw new Error("accepted handoff retired");
          }
          captured.authority.assertCurrent();
        },
      };
      const dispatch = (
        selectedClaim: AcceptedPluginGatewayHandoffClaim = claim,
        requester = alice,
      ) =>
        withPluginRuntimeGatewayRequestScope(
          {
            client: requester,
            context,
            isWebchatConnect: () => false,
            pluginId: "gitlab",
            pluginRegistry: registration.registry.registry,
          },
          () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: selectedClaim.sessionKey,
                operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
                operatorAuthority: selectedClaim.operatorAuthority,
                receiptAuthority: () => current,
                assertToolAllowed: (name) => {
                  if (name !== "gitlab_publish") {
                    throw new Error("tool denied");
                  }
                },
                gatewayContextResolver: () => context,
              },
              () =>
                callAgentToolGatewayRequest({
                  method: selectedClaim.method,
                  params: selectedClaim.params,
                  scopes: ["operator.sessions.write"],
                  signal: selectedClaim.signal,
                  timeoutMs: null,
                  sessionMutationCommitGuard: () => selectedClaim.assertCurrent(),
                }),
            ),
        );
      try {
        if (checkout) {
          checkoutTransport.fixturePath = repoRoot;
          const priorFile = path.join(state.workspaceDir, "prior-work.txt");
          await fs.writeFile(priorFile, "preserve earlier session files\n");
          let revokedAfterTransfer = false;
          if (scenario !== "checkout") {
            checkoutTransport.afterTransfer = async () => {
              if (scenario === "checkout-policy-revoked") {
                config.gateway!.gitlab!.projects = [99];
              } else if (scenario === "checkout-connection-revoked") {
                // A separate Profile action revokes the grant while the tool awaits Git.
                await withoutGatewayToolCallerIdentity(async () => {
                  await service.disconnect(
                    await preparePersonalForgeAction(
                      { client: alice, context },
                      "operator.read",
                      undefined,
                      "GitLab",
                    ),
                  );
                });
              } else if (scenario === "checkout-workspace-revoked") {
                await upsertSessionEntryCore(
                  { agentId: "main", sessionKey },
                  { projectId: "another-project" },
                );
              } else if (scenario === "checkout-project-replaced") {
                config.gateway!.gitlab!.projects = [17, 99];
                project.id = 99;
              } else {
                requesterLifetime.abort(new Error("requester authority is no longer active"));
              }
              revokedAfterTransfer = true;
            };
          }
          const prepareClaim = {
            ...claim,
            method: "tools.gitlab.publication.prepare",
            params: {
              ...params,
              operation: { action: "prepare", projectUrl: project.web_url },
            },
          };
          const prepare = () =>
            withAcceptedPluginGatewayHandoffClaim(prepareClaim, () => dispatch(prepareClaim));
          if (scenario !== "checkout") {
            await expect(prepare()).rejects.toThrow(
              scenario === "checkout-policy-revoked"
                ? "project is not allowed"
                : scenario === "checkout-connection-revoked"
                  ? "My GitLab connection changed"
                  : scenario === "checkout-workspace-revoked"
                    ? "GitLab checkout workspace changed"
                    : scenario === "checkout-project-replaced"
                      ? "GitLab checkout project identity changed"
                      : "authority is no longer active",
            );
            expect(revokedAfterTransfer).toBe(true);
            expect(checkoutTransport.calls).toBe(scenario === "checkout-project-replaced" ? 2 : 1);
            using selected = await prepareGitHubPublicationSession(sessionKey, { agentId: "main" });
            expect(selected.readCurrent().entry?.worktree).toBeUndefined();
            expect(await fs.readFile(priorFile, "utf8")).toBe("preserve earlier session files\n");
            expect(publicationTransport.pushes).toBe(0);
            expect(mrs).toHaveLength(0);
            if (scenario === "checkout-policy-revoked") {
              config.gateway!.gitlab!.projects = [17];
              const retried = await prepare();
              expect(retried).toMatchObject({ status: "prepared", baseCommit: source });
              expect(await fs.readFile(priorFile, "utf8")).toBe("preserve earlier session files\n");
            }
            return;
          }
          const prepared = await prepare();
          expect(prepared).toMatchObject({
            status: "prepared",
            baseBranch: "master",
            baseCommit: source,
            publisher: { source: "personal", accountId: 11, login: "alice" },
          });
          cwd = (prepared as { workspacePath: string }).workspacePath;
          branch = worktreeGit("branch", "--show-current");
          expect(cwd).not.toBe(repoRoot);
          expect(worktreeGit("remote", "get-url", "origin")).toBe(project.http_url_to_repo);
          expect(worktreeGit("rev-parse", "HEAD")).toBe(source);
          expect(await fs.readFile(priorFile, "utf8")).toBe("preserve earlier session files\n");
          await fs.writeFile(path.join(cwd, "local.txt"), "local commit\n");
          worktreeGit("add", "local.txt");
          worktreeGit(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-m",
            "Local task commit",
          );
          await fs.writeFile(path.join(cwd, "artifact.txt"), "dirty local edit\n");
          await fs.writeFile(path.join(cwd, "untracked.txt"), "untracked local work\n");
          const localHead = worktreeGit("rev-parse", "HEAD");
          const localStatus = worktreeGit("status", "--porcelain");
          const localIndex = worktreeGit("write-tree");
          git("branch", "new-upstream", source);
          const refreshClaim = {
            ...claim,
            method: "tools.gitlab.publication.refresh",
            params: { ...params, operation: { action: "refresh" } },
          };
          const refreshed = await withAcceptedPluginGatewayHandoffClaim(refreshClaim, () =>
            dispatch(refreshClaim),
          );
          expect(refreshed).toMatchObject({
            status: "refreshed",
            workspacePath: cwd,
            baseCommit: source,
          });
          expect(worktreeGit("rev-parse", "refs/remotes/origin/new-upstream")).toBe(source);
          expect(worktreeGit("rev-parse", "HEAD")).toBe(localHead);
          expect(worktreeGit("write-tree")).toBe(localIndex);
          expect(worktreeGit("status", "--porcelain")).toBe(localStatus);
          expect(await fs.readFile(path.join(cwd, "artifact.txt"), "utf8")).toBe(
            "dirty local edit\n",
          );
          expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe(
            "untracked local work\n",
          );
          const localConfig = worktreeGit("config", "--local", "--list");
          expect(localConfig).not.toMatch(
            /alice-access|bob-access|ambient-bot|authorization|extraheader/u,
          );
          const transfers = checkoutTransport.calls;
          const bobCaptured = expectDefined(
            await captureGatewayOperatorRunAuthority({ client: bob, context }),
            "Bob checkout authority",
          );
          try {
            const bobClaim = {
              ...refreshClaim,
              operatorAuthority: bobCaptured.authority,
              assertCurrent: bobCaptured.authority.assertCurrent,
            };
            await expect(
              withAcceptedPluginGatewayHandoffClaim(bobClaim, () => dispatch(bobClaim, bob)),
            ).rejects.toThrow();
            expect(checkoutTransport.calls).toBe(transfers);
            const bobSessionKey = `agent:main:dashboard:${randomUUID()}`;
            const bobSessionId = randomUUID();
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: bobSessionKey },
              {
                sessionId: bobSessionId,
                updatedAt: Date.now(),
                createdActor: { type: "human", source: "profile", id: bobProfile },
              },
            );
            const bobPrepareClaim = {
              ...prepareClaim,
              sessionKey: bobSessionKey,
              sessionId: bobSessionId,
              operatorAuthority: bobCaptured.authority,
              assertCurrent: bobCaptured.authority.assertCurrent,
              params: {
                ...prepareClaim.params,
                sessionKey: bobSessionKey,
                idempotencyKey: randomUUID(),
              },
            };
            checkoutTransport.actor = "bob";
            const bobPrepared = await withAcceptedPluginGatewayHandoffClaim(bobPrepareClaim, () =>
              dispatch(bobPrepareClaim, bob),
            );
            expect(bobPrepared).toMatchObject({
              status: "prepared",
              baseCommit: source,
              publisher: { source: "personal", accountId: 22, login: "bob" },
            });
            const bobWorkspace = (bobPrepared as { workspacePath: string }).workspacePath;
            expect(bobWorkspace).not.toBe(cwd);
            expect(
              execFileSync("git", ["-C", bobWorkspace, "rev-parse", "HEAD"], {
                encoding: "utf8",
              }).trim(),
            ).toBe(source);
            await expect(fs.stat(path.join(bobWorkspace, "local.txt"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            await expect(fs.stat(path.join(bobWorkspace, "untracked.txt"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            expect(JSON.stringify(bobPrepared)).not.toMatch(/alice-access|bob-access|ambient-bot/u);
          } finally {
            checkoutTransport.actor = "alice";
            bobCaptured.release();
          }
          expect(worktreeGit("rev-parse", "HEAD")).toBe(localHead);
          expect(worktreeGit("write-tree")).toBe(localIndex);
          expect(worktreeGit("status", "--porcelain")).toBe(localStatus);
          expect(await fs.readFile(path.join(cwd, "artifact.txt"), "utf8")).toBe(
            "dirty local edit\n",
          );
          expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe(
            "untracked local work\n",
          );
          expect(JSON.stringify({ prepared, refreshed })).not.toMatch(
            /alice-access|bob-access|ambient-bot/u,
          );
        }
        if (scenario === "revoked") {
          await service.disconnect(
            await preparePersonalForgeAction(
              { client: alice, context },
              "operator.read",
              undefined,
              "GitLab",
            ),
          );
          await expect(withAcceptedPluginGatewayHandoffClaim(claim, dispatch)).rejects.toThrow();
          expect(publicationTransport.pushes).toBe(0);
          expect(mrs).toHaveLength(0);
          expect(
            await readPersonalGitLabPublicationAsync(aliceProfile, issuer, {
              sessionKey,
              agentId: "main",
            }),
          ).toBeUndefined();
          return;
        }
        if (unbound && !checkout) {
          await expect(withAcceptedPluginGatewayHandoffClaim(claim, dispatch)).rejects.toThrow(
            scenario === "canonical-mismatch"
              ? "GitLab publication project identity changed"
              : "GitLab publication project is not allowed",
          );
          using selected = await prepareGitHubPublicationSession(sessionKey, { agentId: "main" });
          expect(selected.readCurrent().entry?.worktree).toBeUndefined();
          if (scenario === "policy-revoked") {
            expect(projectPolicyReadsAfterMetadata).toBeGreaterThanOrEqual(3);
          }
          expect(publicationTransport.pushes).toBe(0);
          expect(mrs).toHaveLength(0);
          expect(
            await readPersonalGitLabPublicationAsync(aliceProfile, issuer, {
              sessionKey,
              agentId: "main",
            }),
          ).toBeUndefined();
          return;
        }
        let result = await withAcceptedPluginGatewayHandoffClaim(claim, dispatch);
        if (lostMrResponse) {
          expect(result).toMatchObject({ status: "needs_confirmation" });
          const factoryContext = createPluginToolFactoryContext({
            entry,
            registry: registration.registry.registry,
            context: { agentId: "main", sessionKey },
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
            registration.registry.registry,
            raw,
            factoryContext.assertInvocationCurrent,
          );
          const statusToolResult = await withPluginRuntimeGatewayRequestScope(
            {
              client: alice,
              context,
              isWebchatConnect: () => false,
              pluginId: "gitlab",
              pluginRegistry: registration.registry.registry,
            },
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey,
                  operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
                  operatorAuthority: captured.authority,
                  receiptAuthority: () => current,
                  assertToolAllowed: () => {},
                  gatewayContextResolver: () => context,
                },
                () =>
                  tool.execute(randomUUID(), {
                    action: "status",
                    requestId: (result as { requestId: string }).requestId,
                  }),
              ),
          );
          const status = statusToolResult.details as {
            result: { requestId: string; status: string };
            confirmation: {
              requestDigest: string;
              generation: string;
              account: { accountId: number; login: string };
            };
          };
          expect(status.result.status).toBe("needs_confirmation");
          const confirmClaim = {
            ...claim,
            method: "tools.gitlab.publication.confirm",
            params: {
              sessionKey,
              agentId: "main",
              idempotencyKey: randomUUID(),
              operation: {
                action: "confirm" as const,
                requestId: status.result.requestId,
                requestDigest: status.confirmation.requestDigest,
                generation: status.confirmation.generation,
                account: status.confirmation.account,
              },
            },
          };
          result = await withAcceptedPluginGatewayHandoffClaim(confirmClaim, () =>
            dispatch(confirmClaim),
          );
        }
        expect(result).toMatchObject({
          status: "published",
          publisher: { source: "personal", accountId: 11, login: "alice" },
          url: `${project.web_url}/-/merge_requests/9`,
        });
        expect(publicationTransport.pushes).toBe(1);
        expect(mrs).toHaveLength(1);
        expect(mrs[0]).toMatchObject({
          author: { id: 11 },
          sha: publicationTransport.remoteHead,
        });
        expect(worktreeGit("show", "-s", "--format=%an|%ae|%cn|%ce", "HEAD")).toBe(
          "Alice Human|alice@example.test|Alice Human|alice@example.test",
        );
        expect(worktreeGit("rev-parse", "HEAD^")).toBe(source);
        if (checkout) {
          const transfers = checkoutTransport.calls;
          await service.disconnect(
            await preparePersonalForgeAction(
              { client: alice, context },
              "operator.read",
              undefined,
              "GitLab",
            ),
          );
          const revokedClaim = {
            ...claim,
            method: "tools.gitlab.publication.refresh",
            params: { ...params, operation: { action: "refresh" } },
          };
          await expect(
            withAcceptedPluginGatewayHandoffClaim(revokedClaim, () => dispatch(revokedClaim)),
          ).rejects.toThrow();
          expect(checkoutTransport.calls).toBe(transfers);
        }
        const publishedRequestId = (result as { requestId: string }).requestId;
        const bobAuthority = expectDefined(
          await captureGatewayOperatorRunAuthority({ client: bob, context }),
          "Bob run authority",
        );
        try {
          const bobFactoryContext = createPluginToolFactoryContext({
            entry,
            registry: registration.registry.registry,
            context: { agentId: "main", sessionKey },
            assertInvocationCurrent: () => {},
          });
          const bobRaw = entry.factory(bobFactoryContext);
          if (!bobRaw || Array.isArray(bobRaw)) {
            throw new Error("GitLab publication tool missing");
          }
          const bobTool = bindPluginToolCallbacks(
            entry,
            registration.registry.registry,
            bobRaw,
            bobFactoryContext.assertInvocationCurrent,
          );
          await expect(
            withPluginRuntimeGatewayRequestScope(
              { client: bob, context, isWebchatConnect: () => false },
              () =>
                withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey,
                    operationalRunInstance: { instanceId: "instance-bob", runId: "run-bob" },
                    operatorAuthority: bobAuthority.authority,
                    receiptAuthority: () => true,
                    assertToolAllowed: () => {},
                    gatewayContextResolver: () => context,
                  },
                  () =>
                    bobTool.execute(randomUUID(), {
                      action: "status",
                      requestId: publishedRequestId,
                    }),
                ),
            ),
          ).rejects.toThrow();
        } finally {
          bobAuthority.release();
        }
        await expect(dispatch()).rejects.toThrow("accepted plugin tool handoff");
      } finally {
        current = false;
        captured.release();
      }
    } finally {
      await service.stop();
      catalog.release();
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
