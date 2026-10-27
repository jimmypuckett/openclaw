import {
  ErrorCodes,
  errorShape,
  validateUsersGitLabStatusParams,
  validateUsersGitLabAuthorizeStartParams,
  validateUsersGitLabAuthorizeCompleteParams,
  validateUsersGitLabDisconnectParams,
  validateSessionGitLabOptionsParams,
  validateSessionGitLabStatusParams,
  validateSessionGitLabConfirmParams,
  validateSessionGitLabPublishParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { PersonalGitLabCredential } from "../gitlab-personal-oauth.js";
import {
  confirmPersonalGitLabPublication,
  readPersonalGitLabPublicationOptions,
  readPersonalGitLabPublicationStatus,
  requestPersonalGitLabPublication,
} from "../gitlab-personal-publication.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import {
  preparePersonalGitLabPublicationOptionsRead,
  preparePersonalGitLabSessionActionV2,
} from "./github-personal-authorization.js";
import { preparePersonalForgeAction } from "./personal-forge-authorization.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type Options = Pick<
  GatewayRequestHandlerOptions,
  | "client"
  | "context"
  | "signal"
  | "respond"
  | "req"
  | "hasCurrentClientAuthority"
  | "sessionMutationCommitGuard"
  | "sessionMutationAuthorization"
>;

function respondFailure(options: Options, error: unknown, message: string) {
  options.respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : message),
  );
}

function rejectSelection(options: Options, idempotencyKey: string): void {
  options.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.UNAVAILABLE,
      "The selected GitLab publisher is unavailable or changed; review publication options and retry.",
      { details: { code: "GITLAB_PUBLICATION_SELECTION_REJECTED", idempotencyKey } },
    ),
  );
}

function assertRequestedOwner(
  options: Options,
  target: { sessionKey: string; agentId?: string },
): void {
  if (target.agentId === undefined) {
    return;
  }
  const owner = resolveRequestedSessionAgentId(
    options.context.getRuntimeConfig(),
    target.sessionKey,
    target.agentId,
  );
  if (!owner.ok) {
    throw new Error(owner.error.message);
  }
}

async function personal<T>(
  options: Options,
  run: (
    action: Awaited<ReturnType<typeof preparePersonalForgeAction>>,
    service: NonNullable<Options["context"]["gitlabOAuthService"]>,
  ) => Promise<T>,
) {
  try {
    const action = await preparePersonalForgeAction(options, "operator.read", undefined, "GitLab");
    const service = options.context.gitlabOAuthService;
    if (!service) {
      throw new Error("Personal GitLab is unavailable; retry after Gateway startup.");
    }
    const result = await run(action, service);
    action.assertCurrent();
    options.respond(true, result);
  } catch (error) {
    respondFailure(options, error, "Personal GitLab action failed.");
  }
}

/** Native session actions use the same direct human connection and requester custody as GitHub. */
export const gitLabHandlers: GatewayRequestHandlers = {
  "users.gitlab.status": defineValidatedGatewayMethod(
    "users.gitlab.status",
    validateUsersGitLabStatusParams,
    async (options) => {
      if (!options.context.getRuntimeConfig().gateway?.gitlab) {
        options.respond(true, { configured: false });
        return;
      }
      await personal(options, async (action, service) => {
        const status = await service.status(action);
        return {
          ...status,
          account: status.account
            ? { accountId: status.account.accountId, login: status.account.login }
            : null,
        };
      });
    },
  ),
  "users.gitlab.authorize.start": defineValidatedGatewayMethod(
    "users.gitlab.authorize.start",
    validateUsersGitLabAuthorizeStartParams,
    (options) => personal(options, (action, service) => service.start(action)),
  ),
  "users.gitlab.authorize.complete": defineValidatedGatewayMethod(
    "users.gitlab.authorize.complete",
    validateUsersGitLabAuthorizeCompleteParams,
    (options) =>
      personal(options, async (action, service) => {
        const status = await service.complete(
          action,
          options.params.requestId,
          options.params.callbackUrl,
        );
        return {
          ...status,
          account: status.account
            ? { accountId: status.account.accountId, login: status.account.login }
            : null,
        };
      }),
  ),
  "users.gitlab.disconnect": defineValidatedGatewayMethod(
    "users.gitlab.disconnect",
    validateUsersGitLabDisconnectParams,
    (options) => personal(options, (action, service) => service.disconnect(action)),
  ),
  "sessions.gitlab.options": defineValidatedGatewayMethod(
    "sessions.gitlab.options",
    validateSessionGitLabOptionsParams,
    async (options) => {
      try {
        assertRequestedOwner(options, options.params);
        using prepared = await preparePersonalGitLabPublicationOptionsRead(options, options.params);
        if (!prepared.action) {
          options.respond(true, {
            personal: null,
            shared: null,
            sharedUnavailableReason: "unavailable",
            pendingPersonal: null,
            latestShared: null,
            target: null,
          });
          return;
        }
        const result = await readPersonalGitLabPublicationOptions(
          options,
          prepared.action,
          null,
          options.params.idempotencyKey,
        );
        prepared.action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        respondFailure(options, error, "GitLab publication options are unavailable.");
      }
    },
  ),
  "sessions.gitlab.status": defineValidatedGatewayMethod(
    "sessions.gitlab.status",
    validateSessionGitLabStatusParams,
    async (options) => {
      try {
        assertRequestedOwner(options, options.params);
        using prepared = await preparePersonalGitLabPublicationOptionsRead(options, options.params);
        if (!prepared.action) {
          throw new Error("GitLab publication was not found for this session and caller.");
        }
        const service = options.context.gitlabOAuthService;
        const connection = service ? await service.status(prepared.action) : null;
        let credential: PersonalGitLabCredential | null = null;
        if (connection?.connected) {
          try {
            credential = await service!.credential(prepared.action);
          } catch {
            // The original receipt remains readable when refresh or verification fails.
            prepared.action.assertCurrent();
          }
        }
        const result = await readPersonalGitLabPublicationStatus(
          options,
          prepared.action,
          credential,
          options.params.requestId,
        );
        prepared.action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        respondFailure(options, error, "GitLab publication status is unavailable.");
      }
    },
  ),
  "sessions.gitlab.confirm": defineValidatedGatewayMethod(
    "sessions.gitlab.confirm",
    validateSessionGitLabConfirmParams,
    async (options) => {
      try {
        assertRequestedOwner(options, options.params);
        const service = options.context.gitlabOAuthService;
        if (!service) {
          throw new Error("Personal GitLab is unavailable; retry after Gateway startup.");
        }
        const admitted = await preparePersonalGitLabSessionActionV2(
          options,
          options.params,
          "sessions.gitlab.confirm",
        );
        using _ = { [Symbol.dispose]: () => admitted.release() };
        const credential = await service.credential(admitted.action);
        const result = await confirmPersonalGitLabPublication(
          options,
          admitted.action,
          credential,
          options.params,
        );
        admitted.action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        respondFailure(options, error, "GitLab publication confirmation failed.");
      }
    },
  ),
  "sessions.gitlab.publish": defineValidatedGatewayMethod(
    "sessions.gitlab.publish",
    validateSessionGitLabPublishParams,
    async (options) => {
      const { params } = options;
      if (params.selection?.source !== "personal" || !params.sessionKey) {
        rejectSelection(options, params.idempotencyKey);
        return;
      }
      try {
        assertRequestedOwner(options, { sessionKey: params.sessionKey, agentId: params.agentId });
        const service = options.context.gitlabOAuthService;
        if (!service) {
          rejectSelection(options, params.idempotencyKey);
          return;
        }
        const admitted = await preparePersonalGitLabSessionActionV2(options, {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
        });
        using _ = { [Symbol.dispose]: () => admitted.release() };
        const credential = await service.credential(admitted.action);
        if (
          credential.generation !== params.selection.generation ||
          credential.account.accountId !== params.selection.account.accountId ||
          credential.account.login !== params.selection.account.login
        ) {
          rejectSelection(options, params.idempotencyKey);
          return;
        }
        const result = await requestPersonalGitLabPublication(
          options,
          admitted.action,
          credential,
          params,
        );
        admitted.action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        respondFailure(options, error, "GitLab publication request failed.");
      }
    },
  ),
};
