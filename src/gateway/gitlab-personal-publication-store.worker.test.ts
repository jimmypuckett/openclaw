import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { replaceUserGitLabConnection } from "../state/user-gitlab-connections.js";
import { disconnectedUserGitLabConnection } from "../state/user-gitlab-connections.kernel.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  personalGitLabRequestDigest,
  type PersonalGitLabPublicationRow,
} from "./gitlab-personal-publication-store.js";
import {
  claimPersonalGitLabPublicationInDatabase,
  insertPersonalGitLabPublicationInDatabase,
  readPersonalGitLabPublicationInDatabase,
  requirePersonalGitLabPublicationConfirmationInDatabase,
  writePersonalGitLabPublicationInDatabase,
} from "./gitlab-personal-publication-store.worker.js";

const issuer = "https://gitlab.example.test";
const current = () => {};

it("fences the old execution after restart and replacement claim", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("gitlab-native-publication@example.test").id;
    const connection = await replaceUserGitLabConnection(
      owner,
      issuer,
      undefined,
      {
        ...disconnectedUserGitLabConnection(issuer),
        selection: {
          kind: "connected",
          account: { issuer, accountId: 42, login: "alice" },
          tokens: {
            accessToken: "test-access",
            refreshToken: "test-refresh",
            expiresAtMs: Date.now() + 3600000,
            scopes: ["api"],
          },
        },
      },
      current,
    );
    const now = Date.now();
    const row: PersonalGitLabPublicationRow = {
      request_id: randomUUID(),
      owner_profile_id: owner,
      issuer,
      connection_generation: connection.generation,
      idempotency_key: randomUUID(),
      request_digest: "",
      session_id: randomUUID(),
      session_key: "agent:main:test",
      agent_id: "main",
      session_lifecycle_revision: null,
      worktree_id: "worktree-test",
      repository_fingerprint: "fingerprint-test",
      identity_account_id: 42,
      identity_login: "alice",
      branch: "topic-test",
      receipt_json: JSON.stringify({
        target: {
          issuer,
          projectId: 12,
          projectPath: "org/repo",
          gitUrl: "https://gitlab.example.test/org/repo.git",
          webUrl: "https://gitlab.example.test/org/repo",
          baseBranch: "master",
        },
        actor: { accountId: 42, login: "alice" },
        sessionIdentity: {
          sessionId: "",
          sessionKey: "agent:main:test",
          agentId: "main",
          lifecycleRevision: null,
        },
        sourceId: "worktree-test",
        worktreeId: "worktree-test",
        repositoryFingerprint: "fingerprint-test",
        branch: "topic-test",
        sourceHead: "b".repeat(40),
        baseTree: "a".repeat(40),
        workspaceHead: "c".repeat(40),
        repositoryRoot: "/tmp/repo",
        sourceIndexTree: "a".repeat(40),
        createdAtMs: now,
      }),
      status: "requested",
      gateway_instance_id: null,
      execution_id: null,
      head_commit: null,
      pull_request_url: null,
      error_code: null,
      next_action: null,
      last_effect: null,
      effect_state: null,
      push_observation: null,
      result_json: null,
      created_at_ms: now,
      updated_at_ms: now,
      reported_at_ms: null,
    };
    row.receipt_json = JSON.stringify({
      ...JSON.parse(row.receipt_json),
      sessionIdentity: {
        sessionId: row.session_id,
        sessionKey: row.session_key,
        agentId: row.agent_id,
        lifecycleRevision: null,
      },
    });
    row.request_digest = personalGitLabRequestDigest(row);
    const mismatched = {
      ...row,
      receipt_json: row.receipt_json.replace('"login":"alice"', '"login":"mallory"'),
    };
    mismatched.request_digest = personalGitLabRequestDigest(mismatched);
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        insertPersonalGitLabPublicationInDatabase(database, mismatched, current),
      ),
    ).toThrow("accepted checkpoint is inconsistent");
    runOpenClawStateWriteTransaction((database) =>
      insertPersonalGitLabPublicationInDatabase(database, row, current),
    );
    const another = { ...row, request_id: randomUUID(), idempotency_key: randomUUID() };
    another.request_digest = personalGitLabRequestDigest(another);
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        insertPersonalGitLabPublicationInDatabase(database, another, current),
      ),
    ).toThrow("unresolved request");
    const first = runOpenClawStateWriteTransaction((database) =>
      claimPersonalGitLabPublicationInDatabase(
        database,
        row,
        "gateway-first",
        "execution-first",
        current,
      ),
    );
    expect(first.status).toBe("publishing");
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        claimPersonalGitLabPublicationInDatabase(
          database,
          row,
          "gateway-second",
          "execution-second",
          current,
        ),
      ),
    ).toThrow("execution changed");
    runOpenClawStateWriteTransaction((database) =>
      requirePersonalGitLabPublicationConfirmationInDatabase(database, "gateway-second"),
    );
    const interrupted = readPersonalGitLabPublicationInDatabase(
      openOpenClawStateDatabase().db,
      owner,
      issuer,
      { requestId: row.request_id },
    )!;
    expect(interrupted.status).toBe("needs_confirmation");
    const second = runOpenClawStateWriteTransaction((database) =>
      claimPersonalGitLabPublicationInDatabase(
        database,
        interrupted,
        "gateway-second",
        "execution-second",
        current,
      ),
    );
    expect(second.execution_id).toBe("execution-second");
    expect(() =>
      runOpenClawStateWriteTransaction((database) =>
        writePersonalGitLabPublicationInDatabase(
          database,
          first,
          "gateway-first",
          "execution-first",
          { head_commit: "a".repeat(40) },
        ),
      ),
    ).toThrow("no longer current");
    const written = runOpenClawStateWriteTransaction((database) =>
      writePersonalGitLabPublicationInDatabase(
        database,
        second,
        "gateway-second",
        "execution-second",
        { head_commit: "b".repeat(40) },
      ),
    );
    expect(written.head_commit).toBe("b".repeat(40));
  });
});
