import {
  GitLabIssueOperationSchema,
  isGitLabIssueWrite,
  parseGitLabIssueOperation,
} from "@openclaw/gateway-protocol/gitlab-issues";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";

export default definePluginEntry({
  id: "gitlab",
  name: "GitLab",
  description: "Requester-attributed GitLab issues and discussions",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "gitlab_issues",
          label: "GitLab Issues and Comments",
          description:
            "Read and manage GitLab issues, issue comments, and existing merge-request discussions as the person requesting this turn. Uses that person's connected My GitLab account inside the Gateway; never uses System, agent, CLI, or another person's credentials as fallback. Supply the explicit projectUrl on the configured GitLab server. Read current issue/note fields before editing or deleting; retain returned IDs and pagination. Use discussion replies for threads and ordinary notes for root comments. Only make writes the user requested. After an uncertain write, read the exact target and reconcile its author/content before retrying; never repeat create/post/reply blindly. Missing or ambiguous requester authorization requires a new signed-in user turn or connecting My GitLab in Profile. Repository publication is a separate action.",
          parameters: GitLabIssueOperationSchema,
          async execute(_toolCallId, input, signal) {
            context.assertInvocationCurrent();
            signal?.throwIfAborted();
            const operation = parseGitLabIssueOperation(input);
            if (!operation) {
              throw new Error(
                "Provide a supported GitLab issue or discussion action and explicit project URL.",
              );
            }
            const write = isGitLabIssueWrite(operation);
            const result = await api.runtime.gateway.request(
              write ? "tools.gitlab.issues.write" : "tools.gitlab.issues.read",
              operation,
              {
                scopes: [write ? "operator.sessions.write" : "operator.sessions.read"],
                timeoutMs: 120_000,
                signal,
              },
            );
            const { wrapExternalContent } = await import("openclaw/plugin-sdk/security-runtime");
            context.assertInvocationCurrent();
            signal?.throwIfAborted();
            return textResult(
              wrapExternalContent(JSON.stringify(result, null, 2), {
                source: "api",
                includeWarning: false,
              }),
              result,
            );
          },
        }),
      },
      { name: "gitlab_issues", workspaceAccess: false },
    );
  },
});
