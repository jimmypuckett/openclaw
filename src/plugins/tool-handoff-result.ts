import type { AgentToolResult } from "../agents/runtime/index.js";

/** An unforgeable process-local marker for a tool result returned after its owner yielded. */
const accepted = new WeakSet<object>();

export function markAcceptedPluginToolHandoffResult<T extends AgentToolResult<unknown>>(
  result: T,
): T {
  accepted.add(result);
  return result;
}

export function isAcceptedPluginToolHandoffResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && accepted.has(value);
}
