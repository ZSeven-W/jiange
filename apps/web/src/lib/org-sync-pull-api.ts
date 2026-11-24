import {
  ApiError,
  type OrgSyncProvider,
  type OrgSyncRun,
  type OrgSyncSource,
} from "@/lib/api";

export type OrgSyncPullProvider = "ldap" | "wecom" | "dingtalk";

export type OrgSyncTriggerModeExtended =
  | OrgSyncRun["triggerMode"]
  | "pull"
  | "scheduled";

export type OrgSyncRunExtended = Omit<OrgSyncRun, "triggerMode"> & {
  triggerMode: OrgSyncTriggerModeExtended;
};

export interface OrgConnectorConfig {
  endpointUrl?: string;
  // LDAP v3
  bindDn?: string;
  bindPassword?: string;
  baseDn?: string;
  userFilter?: string;
  deptFilter?: string;
  emailAttr?: string;
  nameAttr?: string;
  deptAttr?: string;
  insecureSkipVerify?: boolean;
  // WeCom (企业微信)
  corpId?: string;
  corpSecret?: string;
  // DingTalk (钉钉)
  appKey?: string;
  appSecret?: string;
  // Shared WeCom / DingTalk root department ID
  rootDeptId?: number;
}

export interface OrgSyncSourceExtended extends OrgSyncSource {
  endpointUrl?: string;
  connectorConfigHint?: string;
  hasConnectorConfig?: boolean;
  syncIntervalMinutes?: number;
  lastAutoSyncAt?: string | null;
}

export interface SaveConnectorConfigPatch {
  endpointUrl?: string;
  connectorConfig?: OrgConnectorConfig;
  syncIntervalMinutes?: number;
}

export interface SaveConnectorConfigResponse {
  source: OrgSyncSourceExtended;
  token?: string;
}

export interface OrgSyncPullFetched {
  departments: number;
  groups: number;
  members: number;
}

export interface OrgSyncPullResult {
  run: OrgSyncRunExtended;
  fetched: OrgSyncPullFetched;
}

export function isPullConnectorProvider(
  provider: OrgSyncProvider,
): provider is OrgSyncPullProvider {
  return provider === "ldap" || provider === "wecom" || provider === "dingtalk";
}

async function pullRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  userId?: number,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (userId !== undefined && userId > 0) {
    headers["X-Jiange-User-Id"] = String(userId);
  }
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.error ?? "error",
      data.message ?? res.statusText,
      data,
    );
  }
  return data as T;
}

export function saveConnectorConfig(
  wsId: number,
  sourceId: number,
  patch: SaveConnectorConfigPatch,
  userId?: number,
): Promise<SaveConnectorConfigResponse> {
  return pullRequest<SaveConnectorConfigResponse>(
    "PATCH",
    `/api/workspaces/${wsId}/org/sync-sources/${sourceId}`,
    patch,
    userId,
  );
}

export function pullOrgSync(
  wsId: number,
  sourceId: number,
  dryRun = false,
  userId?: number,
  pruneMissing?: boolean,
): Promise<OrgSyncPullResult> {
  return pullRequest<OrgSyncPullResult>(
    "POST",
    `/api/workspaces/${wsId}/org/sync-sources/${sourceId}/pull`,
    {
      dryRun,
      ...(pruneMissing !== undefined ? { pruneMissing } : {}),
    },
    userId,
  );
}
