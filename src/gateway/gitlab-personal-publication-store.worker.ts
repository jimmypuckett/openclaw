import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { ensurePersonalGitLabPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readUserGitLabConnectionInDatabase } from "../state/user-gitlab-connections.kernel.js";
import {
  personalGitLabRequestDigest,
  type PersonalGitLabPublicationRow,
} from "./gitlab-personal-publication-store.js";

const table = "gitlab_personal_publication_requests";
const query = (db: EngineConnection) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

function checked(row: PersonalGitLabPublicationRow): PersonalGitLabPublicationRow {
  if (row.request_digest !== personalGitLabRequestDigest(row)) {
    throw new Error("Personal GitLab publication receipt is corrupt.");
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(row.receipt_json);
  } catch {
    throw new Error("Personal GitLab publication accepted checkpoint is invalid.");
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (
    !object(receipt) ||
    !object(receipt.target) ||
    !object(receipt.actor) ||
    !object(receipt.sessionIdentity) ||
    receipt.target.issuer !== row.issuer ||
    !Number.isInteger(receipt.target.projectId) ||
    Number(receipt.target.projectId) <= 0 ||
    receipt.actor.accountId !== row.identity_account_id ||
    receipt.actor.login !== row.identity_login ||
    receipt.sessionIdentity.sessionId !== row.session_id ||
    receipt.sessionIdentity.sessionKey !== row.session_key ||
    receipt.sessionIdentity.agentId !== row.agent_id ||
    receipt.sessionIdentity.lifecycleRevision !== row.session_lifecycle_revision ||
    receipt.worktreeId !== row.worktree_id ||
    receipt.repositoryFingerprint !== row.repository_fingerprint ||
    receipt.branch !== row.branch ||
    receipt.createdAtMs !== row.created_at_ms ||
    [receipt.sourceHead, receipt.baseTree, receipt.workspaceHead].some(
      (oid) => typeof oid !== "string" || !/^[a-f0-9]{40}$/u.test(oid),
    ) ||
    typeof receipt.repositoryRoot !== "string" ||
    !receipt.repositoryRoot ||
    typeof receipt.sourceIndexTree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(receipt.sourceIndexTree) ||
    ["headCommit", "lastEffect", "effectState", "outcome"].some((key) => key in receipt)
  ) {
    throw new Error("Personal GitLab publication accepted checkpoint is inconsistent.");
  }
  return row;
}

function assertConnection(db: EngineConnection, row: PersonalGitLabPublicationRow): void {
  const connection = readUserGitLabConnectionInDatabase(db, row.owner_profile_id, row.issuer);
  if (
    connection?.generation !== row.connection_generation ||
    connection.selection.kind !== "connected" ||
    connection.selection.refresh ||
    connection.selection.refreshFailure ||
    connection.selection.account.accountId !== row.identity_account_id ||
    connection.selection.account.login !== row.identity_login
  ) {
    throw new Error("Personal GitLab publication connection changed.");
  }
}

export function readPersonalGitLabPublicationInDatabase(
  db: EngineConnection,
  owner: string,
  issuer: string,
  selector:
    | { requestId: string }
    | { sessionId: string; idempotencyKey: string }
    | { sessionKey: string; agentId: string },
): PersonalGitLabPublicationRow | undefined {
  if (!tableExists(db, table)) {
    return undefined;
  }
  let selection = query(db)
    .selectFrom(table)
    .selectAll()
    .where("owner_profile_id", "=", owner)
    .where("issuer", "=", issuer);
  selection =
    "requestId" in selector
      ? selection.where("request_id", "=", selector.requestId)
      : "sessionId" in selector
        ? selection
            .where("session_id", "=", selector.sessionId)
            .where("idempotency_key", "=", selector.idempotencyKey)
        : selection
            .where("session_key", "=", selector.sessionKey)
            .where("agent_id", "=", selector.agentId)
            .where("status", "in", ["requested", "publishing", "needs_confirmation"])
            .orderBy("created_at_ms", "desc")
            .orderBy("request_id", "desc")
            .limit(1);
  const row = executeSqliteQueryTakeFirstSync(db, selection);
  return row ? checked(row) : undefined;
}

export function insertPersonalGitLabPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitLabPublicationRow,
  assertCurrent: () => void,
): PersonalGitLabPublicationRow {
  const { db } = database;
  assertCurrent();
  ensurePersonalGitLabPublicationSchema(db);
  checked(row);
  assertConnection(db, row);
  const unresolved = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("owner_profile_id", "=", row.owner_profile_id)
      .where("issuer", "=", row.issuer)
      .where("session_id", "=", row.session_id)
      .where(
        "session_lifecycle_revision",
        row.session_lifecycle_revision === null ? "is" : "=",
        row.session_lifecycle_revision,
      )
      .where("status", "in", ["requested", "publishing", "needs_confirmation"])
      .orderBy("created_at_ms", "desc")
      .limit(1),
  );
  if (unresolved && unresolved.idempotency_key !== row.idempotency_key) {
    throw new Error("Personal GitLab publication has an unresolved request for this session.");
  }
  const inserted = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .insertInto(table)
      .values(row)
      .onConflict((conflict) => conflict.doNothing())
      .returningAll(),
  );
  if (inserted) {
    assertCurrent();
    githubPublicationReceipts.stageRow(db, "gitlab-personal", inserted);
    return inserted;
  }
  const existing = readPersonalGitLabPublicationInDatabase(db, row.owner_profile_id, row.issuer, {
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
  });
  if (!existing || existing.request_digest !== row.request_digest) {
    throw new Error("Personal GitLab publication idempotency key was reused.");
  }
  assertCurrent();
  return existing;
}

export function claimPersonalGitLabPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitLabPublicationRow,
  instanceId: string,
  executionId: string,
  assertCurrent: () => void,
): PersonalGitLabPublicationRow {
  const { db } = database;
  assertCurrent();
  checked(row);
  if (row.status !== "requested" && row.status !== "needs_confirmation") {
    throw new Error("Personal GitLab publication is not awaiting execution.");
  }
  assertConnection(db, row);
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({
        status: "publishing",
        gateway_instance_id: instanceId,
        execution_id: executionId,
        updated_at_ms: Date.now(),
      })
      .where("request_id", "=", row.request_id)
      .where("owner_profile_id", "=", row.owner_profile_id)
      .where("issuer", "=", row.issuer)
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", row.status)
      .where("execution_id", row.execution_id === null ? "is" : "=", row.execution_id)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("Personal GitLab publication execution changed.");
  }
  assertCurrent();
  githubPublicationReceipts.stageRow(db, "gitlab-personal", updated);
  return checked(updated);
}

export function writePersonalGitLabPublicationInDatabase(
  database: OpenClawStateDatabase,
  row: PersonalGitLabPublicationRow,
  instanceId: string,
  executionId: string,
  values: Partial<PersonalGitLabPublicationRow>,
): PersonalGitLabPublicationRow {
  const { db } = database;
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .updateTable(table)
      .set({ ...values, updated_at_ms: Date.now() })
      .where("request_id", "=", row.request_id)
      .where("owner_profile_id", "=", row.owner_profile_id)
      .where("issuer", "=", row.issuer)
      .where("request_digest", "=", row.request_digest)
      .where("status", "=", "publishing")
      .where("gateway_instance_id", "=", instanceId)
      .where("execution_id", "=", executionId)
      .returningAll(),
  );
  if (!updated) {
    throw new Error("Personal GitLab publication execution is no longer current.");
  }
  githubPublicationReceipts.stageRow(db, "gitlab-personal", updated);
  return checked(updated);
}

export function requirePersonalGitLabPublicationConfirmationInDatabase(
  database: OpenClawStateDatabase,
  instanceId: string,
): PersonalGitLabPublicationRow[] {
  if (!tableExists(database.db, table)) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    database.db,
    query(database.db)
      .updateTable(table)
      .set({ status: "needs_confirmation", updated_at_ms: Date.now() })
      .where("status", "in", ["requested", "publishing"])
      .where((eb) =>
        eb.or([eb("gateway_instance_id", "is", null), eb("gateway_instance_id", "!=", instanceId)]),
      )
      .returningAll(),
  ).rows;
  for (const row of rows) {
    checked(row);
    githubPublicationReceipts.stageRow(database.db, "gitlab-personal", row);
  }
  return rows;
}

export function listUnreportedPersonalGitLabPublicationsInDatabase(db: EngineConnection) {
  if (!tableExists(db, table)) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(table)
      .selectAll()
      .where("status", "in", ["published", "failed"])
      .where("reported_at_ms", "is", null)
      .orderBy("updated_at_ms"),
  ).rows.map(checked);
}

export function markPersonalGitLabPublicationReportedInDatabase(
  database: OpenClawStateDatabase,
  requestId: string,
): PersonalGitLabPublicationRow | undefined {
  if (!tableExists(database.db, table)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    query(database.db)
      .updateTable(table)
      .set({ reported_at_ms: Date.now() })
      .where("request_id", "=", requestId)
      .where("status", "in", ["published", "failed"])
      .returningAll(),
  );
  if (row) {
    checked(row);
    githubPublicationReceipts.stageRow(database.db, "gitlab-personal", row);
  }
  return row;
}
