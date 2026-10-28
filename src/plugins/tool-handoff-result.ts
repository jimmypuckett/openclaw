import type { AgentToolResult } from "../agents/runtime/index.js";

/** An unforgeable process-local marker for a tool result returned after its owner yielded. */
const accepted = new WeakSet<object>();
const yieldingTools = new WeakSet<object>();

/** Host-only registration fact: this exact tool can request a Gateway-owned turn handoff. */
export function markPluginGatewayHandoffTool<T extends object>(tool: T): T {
  yieldingTools.add(tool);
  return tool;
}

export function copyPluginGatewayHandoffTool(source: object, target: object): void {
  if (yieldingTools.has(source)) {
    yieldingTools.add(target);
  }
}

export function isPluginGatewayHandoffTool(tool: object): boolean {
  return yieldingTools.has(tool);
}

export function markAcceptedPluginToolHandoffResult<T extends AgentToolResult<unknown>>(
  result: T,
): T {
  accepted.add(result);
  return result;
}

export function isAcceptedPluginToolHandoffResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && accepted.has(value);
}
