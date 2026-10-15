export const MAX_MSTEAMS_ALLOWED_INBOUND_TENANTS = 32;

export const MSTEAMS_TENANT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export function isMSTeamsTenantId(value: string): boolean {
  return MSTEAMS_TENANT_ID_PATTERN.test(value);
}

export type MSTeamsInboundTenantDenialReason = "missing" | "malformed" | "conflicting" | "foreign";

type MSTeamsInboundTenantVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: MSTeamsInboundTenantDenialReason;
      hasChannelDataTenantId: boolean;
      hasConversationTenantId: boolean;
    };

export function checkMSTeamsInboundTenant(params: {
  activity: unknown;
  allowedTenantIds: readonly string[];
}): MSTeamsInboundTenantVerdict {
  const activity = params.activity as {
    channelData?: { tenant?: { id?: unknown } };
    conversation?: { tenantId?: unknown };
  };
  const channelDataTenantId = activity?.channelData?.tenant?.id;
  const conversationTenantId = activity?.conversation?.tenantId;
  const presentTenantIds = [channelDataTenantId, conversationTenantId].filter(
    (value) => value !== undefined,
  );
  const diagnostic = {
    hasChannelDataTenantId: channelDataTenantId !== undefined,
    hasConversationTenantId: conversationTenantId !== undefined,
  };

  if (presentTenantIds.length === 0) {
    return { allowed: false, reason: "missing", ...diagnostic };
  }
  const normalizedTenantIds: string[] = [];
  for (const value of presentTenantIds) {
    if (typeof value !== "string" || !isMSTeamsTenantId(value)) {
      return { allowed: false, reason: "malformed", ...diagnostic };
    }
    normalizedTenantIds.push(value.toLowerCase());
  }
  if (new Set(normalizedTenantIds).size !== 1) {
    return { allowed: false, reason: "conflicting", ...diagnostic };
  }

  const allowedTenantIds = new Set(params.allowedTenantIds.map((value) => value.toLowerCase()));
  if (!allowedTenantIds.has(normalizedTenantIds[0]!)) {
    return { allowed: false, reason: "foreign", ...diagnostic };
  }
  return { allowed: true };
}
