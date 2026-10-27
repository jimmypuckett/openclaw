// Provider-specific operation contract. Importing this module does not activate the plugin.
export {
  GitLabIssueOperationSchema,
  parseGitLabIssueOperation,
  isGitLabIssueWrite,
  type GitLabIssueOperation,
} from "./src/operations.js";
