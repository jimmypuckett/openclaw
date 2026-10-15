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

function readObjectProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, property);
}

export function checkMSTeamsInboundTenant(params: {
  activity: unknown;
  allowedTenantIds: readonly string[];
}): MSTeamsInboundTenantVerdict {
  const channelDataTenantId = readObjectProperty(
    readObjectProperty(readObjectProperty(params.activity, "channelData"), "tenant"),
    "id",
  );
  const conversationTenantId = readObjectProperty(
    readObjectProperty(params.activity, "conversation"),
    "tenantId",
  );
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
  let normalizedTenantId: string | undefined;
  for (const value of presentTenantIds) {
    if (typeof value !== "string" || !isMSTeamsTenantId(value)) {
      return { allowed: false, reason: "malformed", ...diagnostic };
    }
    const normalizedValue = value.toLowerCase();
    if (normalizedTenantId !== undefined && normalizedValue !== normalizedTenantId) {
      return { allowed: false, reason: "conflicting", ...diagnostic };
    }
    normalizedTenantId = normalizedValue;
  }

  const allowedTenantIds = new Set(params.allowedTenantIds.map((value) => value.toLowerCase()));
  if (normalizedTenantId === undefined || !allowedTenantIds.has(normalizedTenantId)) {
    return { allowed: false, reason: "foreign", ...diagnostic };
  }
  return { allowed: true };
}
