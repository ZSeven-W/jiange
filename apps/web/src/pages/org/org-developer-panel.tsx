import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Download,
  KeyRound,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { openAccountSecurity } from "@/components/account-security-dialog";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type OpenAPIHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const SUPPORTED_METHODS: readonly OpenAPIHttpMethod[] = [
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
];

export interface OpenAPIParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string };
}

export interface OpenAPISchemaProperty {
  type?: string;
  description?: string;
  example?: unknown;
  enum?: string[];
  items?: { type?: string };
}

export interface OpenAPIRequestBody {
  required?: boolean;
  description?: string;
  content?: Record<
    string,
    {
      schema?: {
        type?: string;
        required?: string[];
        properties?: Record<string, OpenAPISchemaProperty>;
      };
    }
  >;
}

export interface OpenAPIOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, { description?: string }>;
  security?: unknown[];
}

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  tags?: Array<{ name: string; description?: string }>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
  paths: Record<string, Record<string, OpenAPIOperation>>;
}

export interface OpenAPIEndpointItem {
  key: string;
  method: OpenAPIHttpMethod;
  path: string;
  tag: string;
  tags: string[];
  operationId: string;
  summary: string;
  description: string;
  parameters: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  contentType: string;
  responses: Array<{ code: string; description: string }>;
  isPublic: boolean;
}

export interface SCIMEndpointReference {
  resource: "ServiceProviderConfig" | "Users" | "Groups";
  methods: OpenAPIHttpMethod[];
  path: string;
  descriptionKey: string;
}

export const SCIM_ENDPOINT_REFERENCES: readonly SCIMEndpointReference[] = [
  {
    resource: "ServiceProviderConfig",
    methods: ["GET"],
    path: "/scim/v2/ServiceProviderConfig",
    descriptionKey: "查询 SCIM 2.0 能力声明（支持 PatchOp、Filter 与 Bearer 鉴权）",
  },
  {
    resource: "Users",
    methods: ["GET", "POST"],
    path: "/scim/v2/Users",
    descriptionKey: "按邮箱筛选、分页列出空间成员，或自动创建并供应新用户",
  },
  {
    resource: "Users",
    methods: ["GET", "PATCH", "DELETE"],
    path: "/scim/v2/Users/{uid}",
    descriptionKey: "查询单个用户、调整角色、通过 active=false 停用或移出空间",
  },
  {
    resource: "Groups",
    methods: ["GET", "POST"],
    path: "/scim/v2/Groups",
    descriptionKey: "列出或新建空间用户组，并同步初始成员关系",
  },
  {
    resource: "Groups",
    methods: ["GET", "PATCH", "DELETE"],
    path: "/scim/v2/Groups/{gid}",
    descriptionKey: "重命名用户组、增删组成员或删除用户组",
  },
] as const;

export const SCIM_AUTH_HEADER_EXAMPLE = "Authorization: Bearer <admin PAT>";

export function resolveRuntimeOrigin(originOverride?: string): string {
  if (typeof originOverride === "string" && originOverride.trim()) {
    return originOverride.trim().replace(/\/+$/, "");
  }
  if (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null") {
    return window.location.origin.replace(/\/+$/, "");
  }
  return "https://jiange.example.com";
}

export function buildScimBaseUrl(origin: string, workspaceId: number): string {
  const cleanOrigin = origin.trim().replace(/\/+$/, "");
  const suffix = workspaceId > 0 ? `?workspaceId=${workspaceId}` : "";
  return `${cleanOrigin}/scim/v2${suffix}`;
}

export function flattenOpenAPIEndpoints(spec: OpenAPISpec | null | undefined): OpenAPIEndpointItem[] {
  if (!spec?.paths) return [];
  const tagOrder = new Map<string, number>();
  (spec.tags ?? []).forEach((tag, idx) => tagOrder.set(tag.name, idx));

  const items: OpenAPIEndpointItem[] = [];
  for (const [path, methodsObj] of Object.entries(spec.paths)) {
    if (!methodsObj || typeof methodsObj !== "object") continue;
    for (const method of SUPPORTED_METHODS) {
      const op = methodsObj[method.toLowerCase()];
      if (!op) continue;
      const tags = op.tags && op.tags.length > 0 ? op.tags : ["General"];
      const contentTypes = op.requestBody?.content ? Object.keys(op.requestBody.content) : [];
      const contentType =
        contentTypes[0] ?? (path.startsWith("/scim/") ? "application/scim+json" : "application/json");
      const responses = Object.entries(op.responses ?? {})
        .map(([code, val]) => ({ code, description: val?.description ?? "" }))
        .sort((a, b) => a.code.localeCompare(b.code));
      items.push({
        key: `${method} ${path}`,
        method,
        path,
        tag: tags[0],
        tags,
        operationId: op.operationId ?? `${method.toLowerCase()}_${path}`,
        summary: op.summary ?? path,
        description: op.description ?? "",
        parameters: op.parameters ?? [],
        requestBody: op.requestBody,
        contentType,
        responses,
        isPublic: Array.isArray(op.security) && op.security.length === 0,
      });
    }
  }

  items.sort((a, b) => {
    const ta = tagOrder.get(a.tag) ?? 999;
    const tb = tagOrder.get(b.tag) ?? 999;
    if (ta !== tb) return ta - tb;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return SUPPORTED_METHODS.indexOf(a.method) - SUPPORTED_METHODS.indexOf(b.method);
  });
  return items;
}

export function filterOpenAPIEndpoints(
  items: readonly OpenAPIEndpointItem[],
  selectedTag: string,
  searchQuery: string,
): OpenAPIEndpointItem[] {
  const q = searchQuery.trim().toLowerCase();
  return items.filter((item) => {
    if (selectedTag !== "all" && !item.tags.includes(selectedTag)) {
      return false;
    }
    if (!q) return true;
    return (
      item.path.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q) ||
      item.summary.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });
}

function buildSampleBody(endpoint: OpenAPIEndpointItem): Record<string, unknown> | null {
  const content = endpoint.requestBody?.content;
  if (!content) return null;
  const media = content[endpoint.contentType] ?? Object.values(content)[0];
  const props = media?.schema?.properties;
  if (!props || Object.keys(props).length === 0) return {};

  const requiredSet = new Set(media?.schema?.required ?? []);
  const entries = Object.entries(props);
  const picked = requiredSet.size > 0
    ? entries.filter(([k]) => requiredSet.has(k)).slice(0, 5)
    : entries.slice(0, 4);
  const out: Record<string, unknown> = {};
  for (const [key, prop] of picked) {
    if (prop.example !== undefined) {
      out[key] = prop.example;
    } else if (prop.enum && prop.enum.length > 0) {
      out[key] = prop.enum[0];
    } else if (prop.type === "integer" || prop.type === "number") {
      out[key] = 1;
    } else if (prop.type === "boolean") {
      out[key] = true;
    } else if (prop.type === "array") {
      out[key] = [];
    } else if (prop.type === "object") {
      out[key] = {};
    } else {
      out[key] = `<${key}>`;
    }
  }
  return out;
}

export function buildEndpointCurl(
  endpoint: OpenAPIEndpointItem,
  origin: string,
  workspaceId: number,
): string {
  const base = origin.trim().replace(/\/+$/, "");
  const ws = workspaceId > 0 ? String(workspaceId) : "1";
  let resolvedPath = endpoint.path.replaceAll("{wsId}", ws);
  if (
    resolvedPath.startsWith("/scim/v2/") &&
    resolvedPath !== "/scim/v2/ServiceProviderConfig" &&
    workspaceId > 0
  ) {
    resolvedPath = `${resolvedPath}?workspaceId=${workspaceId}`;
  }
  const url = `${base}${resolvedPath}`;
  const parts: string[] = ["curl -sS"];
  if (endpoint.method !== "GET") {
    parts.push(`-X ${endpoint.method}`);
  }
  parts.push('-H "Authorization: Bearer $JIANGE_PAT"');

  if (endpoint.method === "POST" || endpoint.method === "PATCH" || endpoint.method === "PUT") {
    parts.push(`-H "Content-Type: ${endpoint.contentType}"`);
    const sample = buildSampleBody(endpoint);
    if (sample !== null) {
      parts.push(`-d '${JSON.stringify(sample)}'`);
    }
  }
  parts.push(`"${url}"`);
  return parts.join(" ");
}

function methodBadgeTone(method: OpenAPIHttpMethod): string {
  switch (method) {
    case "GET":
      return "border-[#c7dcff] bg-[#eef4ff] text-[#1456f0] dark:border-[#24427a] dark:bg-[#1d3461] dark:text-[#7aa7ff]";
    case "POST":
      return "border-[#b7eb8f] bg-[#e3f9e5] text-[#008026] dark:border-[#1f5c2d] dark:bg-[#143d1f] dark:text-[#52c41a]";
    case "PATCH":
      return "border-[#ffd8a8] bg-[#fff4e6] text-[#c26a00] dark:border-[#6e4610] dark:bg-[#4a2f0b] dark:text-[#ffb74d]";
    case "PUT":
      return "border-[#d8c4ff] bg-[#f4edff] text-[#6425d0] dark:border-[#4b2d80] dark:bg-[#2d1e4f] dark:text-[#c4a1ff]";
    case "DELETE":
      return "border-[#ffccc7] bg-[#fde2e2] text-[#d83931] dark:border-[#782626] dark:bg-[#4c1d1d] dark:text-[#ff7875]";
  }
}

function responseBadgeTone(code: string): string {
  if (code.startsWith("2")) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  }
  if (code.startsWith("3")) {
    return "bg-sky-500/10 text-sky-700 dark:text-sky-400";
  }
  return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy copy
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export interface OrgDeveloperPanelProps {
  workspaceId: number;
  canAdmin: boolean;
  /** Optional initial spec for SSR / unit tests. */
  initialSpec?: OpenAPISpec | null;
  /** Optional initially expanded endpoint keys (e.g. "GET /api/docs"). */
  initialExpandedKeys?: string[];
  /** Optional initial tag filter for SSR / unit tests. */
  initialTag?: string;
  /** Optional initial search keyword for SSR / unit tests. */
  initialSearch?: string;
  /** Optional origin override for SSR / unit tests. */
  originOverride?: string;
}

export function OrgDeveloperPanel({
  workspaceId,
  canAdmin,
  initialSpec = null,
  initialExpandedKeys,
  initialTag = "all",
  initialSearch = "",
  originOverride,
}: OrgDeveloperPanelProps) {
  const { t } = useI18n();
  const origin = resolveRuntimeOrigin(originOverride);
  const scimBaseUrl = buildScimBaseUrl(origin, workspaceId);

  const [selectedTag, setSelectedTag] = useState<string>(initialTag);
  const [searchQuery, setSearchQuery] = useState<string>(initialSearch);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const k of initialExpandedKeys ?? []) {
      init[k] = true;
    }
    return init;
  });
  const [copiedKey, setCopiedKey] = useState<string>("");

  const specQuery = useQuery<OpenAPISpec>({
    queryKey: ["openapi-spec"],
    queryFn: async () => {
      const res = await fetch("/api/openapi.json", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as OpenAPISpec;
    },
    initialData: initialSpec ?? undefined,
    staleTime: 5 * 60 * 1000,
  });

  const spec = specQuery.data ?? null;

  const allEndpoints = useMemo(() => flattenOpenAPIEndpoints(spec), [spec]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ep of allEndpoints) {
      counts.set(ep.tag, (counts.get(ep.tag) ?? 0) + 1);
    }
    const orderedTags: Array<{ name: string; count: number }> = [];
    const seen = new Set<string>();
    for (const tagMeta of spec?.tags ?? []) {
      const count = counts.get(tagMeta.name) ?? 0;
      if (count > 0) {
        orderedTags.push({ name: tagMeta.name, count });
        seen.add(tagMeta.name);
      }
    }
    for (const [name, count] of counts.entries()) {
      if (!seen.has(name)) {
        orderedTags.push({ name, count });
      }
    }
    return orderedTags;
  }, [allEndpoints, spec?.tags]);

  const filteredEndpoints = useMemo(
    () => filterOpenAPIEndpoints(allEndpoints, selectedTag, searchQuery),
    [allEndpoints, selectedTag, searchQuery],
  );

  const triggerCopy = async (key: string, value: string) => {
    const ok = await copyText(value);
    if (!ok) return;
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? "" : prev));
    }, 2000);
  };

  const toggleExpanded = (key: string) => {
    setExpandedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleDownloadSpec = () => {
    if (!spec || typeof window === "undefined") return;
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "openapi.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div data-org-developer-panel className="space-y-5">
      {/* Section 1: SCIM 2.0 Provisioning */}
      <section
        data-scim-section
        className="rounded-xl border bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Users size={18} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-semibold text-foreground">
                  {t("SCIM 2.0 身份供应配置")}
                </h2>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  RFC 7643 / 7644
                </span>
              </div>
              <p className="mt-1 text-[12px] text-subtle">
                {t("对接 Okta、Microsoft Entra ID (Azure AD) 与飞书企业目录，实现成员与用户组的全自动供应、角色更新与离职停用。")}
              </p>
            </div>
          </div>
          {canAdmin && (
            <button
              type="button"
              data-open-pat-manager
              onClick={() => openAccountSecurity("pat")}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-white transition-colors hover:bg-primary/90"
            >
              <KeyRound size={13} />
              {t("管理访问令牌 (PAT)")}
            </button>
          )}
        </div>

        {!canAdmin ? (
          <div
            data-scim-admin-guard
            className="mt-4 flex items-start gap-2.5 rounded-lg border border-dashed bg-canvas/70 px-3.5 py-3 text-[13px] text-muted-foreground"
          >
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
            <div>
              <p className="font-medium text-foreground">
                {t("仅空间所有者或管理员可配置 SCIM 2.0 身份供应")}
              </p>
              <p className="mt-0.5 text-[12px] text-subtle">
                {t("SCIM 2.0 成员与用户组供应接口需要管理员权限与 admin 作用域的个人访问令牌；您仍可浏览下方 OpenAPI 3.1 开放接口文档。")}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Supported IdP badges */}
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="text-subtle">{t("兼容身份提供商：")}</span>
              {["Okta", "Azure AD (Entra ID)", t("飞书 SCIM 2.0")].map((idp) => (
                <span
                  key={idp}
                  className="inline-flex items-center gap-1 rounded-full border bg-canvas px-2.5 py-0.5 text-[11px] font-medium text-foreground"
                >
                  <Server size={11} className="text-primary" />
                  {idp}
                </span>
              ))}
            </div>

            {/* Connection parameters */}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border bg-canvas/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                    SCIM Base URL
                  </span>
                  <button
                    type="button"
                    data-copy-scim-url
                    onClick={() => void triggerCopy("scim-url", scimBaseUrl)}
                    className="inline-flex h-6 items-center gap-1 rounded border bg-surface px-2 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
                  >
                    {copiedKey === "scim-url" ? (
                      <>
                        <Check size={11} className="text-emerald-600" />
                        {t("已复制")}
                      </>
                    ) : (
                      <>
                        <Copy size={11} />
                        {t("复制")}
                      </>
                    )}
                  </button>
                </div>
                <code
                  data-scim-base-url
                  className="mt-1.5 block break-all rounded bg-surface px-2.5 py-1.5 font-mono text-[12px] text-foreground"
                >
                  {scimBaseUrl}
                </code>
                <p className="mt-1.5 text-[11px] text-subtle">
                  {t("亦可通过请求头 X-Jiange-Workspace-Id 指定目标空间。")}
                </p>
              </div>

              <div className="rounded-lg border bg-canvas/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                    {t("鉴权请求头格式")}
                  </span>
                  <button
                    type="button"
                    data-copy-scim-auth
                    onClick={() => void triggerCopy("scim-auth", SCIM_AUTH_HEADER_EXAMPLE)}
                    className="inline-flex h-6 items-center gap-1 rounded border bg-surface px-2 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
                  >
                    {copiedKey === "scim-auth" ? (
                      <>
                        <Check size={11} className="text-emerald-600" />
                        {t("已复制")}
                      </>
                    ) : (
                      <>
                        <Copy size={11} />
                        {t("复制")}
                      </>
                    )}
                  </button>
                </div>
                <code
                  data-scim-auth-header
                  className="mt-1.5 block break-all rounded bg-surface px-2.5 py-1.5 font-mono text-[12px] text-foreground"
                >
                  {SCIM_AUTH_HEADER_EXAMPLE}
                </code>
                <p className="mt-1.5 text-[11px] text-subtle">
                  {t("需使用包含 admin 作用域的个人访问令牌（jg_pat_...），仅 read/write 令牌将被拒绝。")}
                </p>
              </div>
            </div>

            {/* Supported SCIM 2.0 endpoints table */}
            <div>
              <h3 className="mb-2 text-[12px] font-semibold text-foreground">
                {t("支持的 SCIM 2.0 端点")}
              </h3>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-left text-[12px]" data-scim-endpoints-table>
                  <thead>
                    <tr className="border-b bg-canvas/70 text-[11px] text-subtle">
                      <th className="px-3 py-2 font-medium">{t("资源类型")}</th>
                      <th className="px-3 py-2 font-medium">{t("支持方法")}</th>
                      <th className="px-3 py-2 font-medium">{t("端点路径")}</th>
                      <th className="px-3 py-2 font-medium">{t("说明")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {SCIM_ENDPOINT_REFERENCES.map((ep) => (
                      <tr key={ep.path} className="align-middle hover:bg-hover/40">
                        <td className="whitespace-nowrap px-3 py-2 font-medium text-foreground">
                          {ep.resource}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            {ep.methods.map((m) => (
                              <span
                                key={m}
                                className={cn(
                                  "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold",
                                  methodBadgeTone(m),
                                )}
                              >
                                {m}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-foreground">
                          {ep.path}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {t(ep.descriptionKey)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Section 2: OpenAPI 3.1 Interactive Explorer */}
      <section
        data-openapi-section
        className="rounded-xl border bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <BookOpen size={18} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-semibold text-foreground">
                  {t("OpenAPI 3.1 开放接口浏览器")}
                </h2>
                {spec && (
                  <>
                    <span
                      data-openapi-version
                      className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-medium text-primary"
                    >
                      OpenAPI {spec.openapi} · v{spec.info.version}
                    </span>
                    <span
                      data-openapi-endpoint-count
                      className="rounded-full bg-sidebar px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                    >
                      {t("共 {count} 个接口", { count: allEndpoints.length })}
                    </span>
                  </>
                )}
              </div>
              <p className="mt-1 text-[12px] text-subtle">
                {spec?.info.description ||
                  t("实时加载 /api/openapi.json 规范，按模块检索 Jiange 全套件开放接口并一键复制 cURL 调试命令。")}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-refresh-openapi
              disabled={specQuery.isFetching}
              onClick={() => void specQuery.refetch()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-surface px-2.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw size={13} className={cn(specQuery.isFetching && "animate-spin")} />
              {t("刷新")}
            </button>
            <button
              type="button"
              data-download-openapi
              disabled={!spec}
              onClick={handleDownloadSpec}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-surface px-3 text-[12px] font-medium text-foreground hover:bg-hover disabled:opacity-50"
            >
              <Download size={13} />
              {t("下载 openapi.json")}
            </button>
          </div>
        </div>

        {/* Search & Tag Filter Pills */}
        <div className="mt-4 space-y-3">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle"
            />
            <input
              type="search"
              data-openapi-search
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("按路径、HTTP 方法、接口名称或说明搜索（如 /scim/v2、webhook、ai）…")}
              aria-label={t("搜索开放接口")}
              className="h-9 w-full rounded-lg border bg-canvas/50 pl-9 pr-9 text-[13px] text-foreground placeholder:text-subtle focus:border-primary focus:bg-surface focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label={t("清空搜索")}
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {tagCounts.length > 0 && (
            <div
              role="tablist"
              aria-label={t("接口模块筛选")}
              data-openapi-tag-pills
              className="flex flex-wrap items-center gap-1.5"
            >
              <button
                type="button"
                role="tab"
                aria-selected={selectedTag === "all"}
                data-openapi-tag="all"
                onClick={() => setSelectedTag("all")}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                  selectedTag === "all"
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-canvas/60 text-muted-foreground hover:bg-hover hover:text-foreground",
                )}
              >
                {t("全部")}
                <span className={cn("text-[10px]", selectedTag === "all" ? "text-white/85" : "text-subtle")}>
                  {allEndpoints.length}
                </span>
              </button>
              {tagCounts.map(({ name, count }) => {
                const active = selectedTag === name;
                return (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-openapi-tag={name}
                    onClick={() => setSelectedTag(name)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                      active
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-canvas/60 text-muted-foreground hover:bg-hover hover:text-foreground",
                    )}
                  >
                    {name}
                    <span className={cn("text-[10px]", active ? "text-white/85" : "text-subtle")}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Endpoint list */}
        <div className="mt-4">
          {specQuery.isPending && !spec ? (
            <p className="py-8 text-center text-[13px] text-subtle">
              {t("正在加载 OpenAPI 3.1 规范…")}
            </p>
          ) : specQuery.isError && !spec ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive"
            >
              {t("加载 OpenAPI 规范失败，请点击右上角刷新重试。")}
            </div>
          ) : filteredEndpoints.length === 0 ? (
            <div className="rounded-lg border border-dashed py-8 text-center text-[13px] text-subtle">
              {t("没有匹配当前筛选条件的开放接口。")}
            </div>
          ) : (
            <div className="space-y-2" data-openapi-endpoint-list>
              {filteredEndpoints.map((ep) => {
                const isExpanded = Boolean(expandedKeys[ep.key]);
                const curlCmd = buildEndpointCurl(ep, origin, workspaceId);
                const copyId = `curl:${ep.key}`;
                const bodyContent = ep.requestBody?.content?.[ep.contentType] ??
                  (ep.requestBody?.content ? Object.values(ep.requestBody.content)[0] : undefined);
                const bodyProps = bodyContent?.schema?.properties
                  ? Object.entries(bodyContent.schema.properties)
                  : [];
                const bodyRequired = new Set(bodyContent?.schema?.required ?? []);

                return (
                  <article
                    key={ep.key}
                    data-openapi-endpoint={ep.key}
                    className="overflow-hidden rounded-lg border bg-canvas/40 transition-colors hover:border-primary/40"
                  >
                    <button
                      type="button"
                      data-openapi-toggle={ep.key}
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpanded(ep.key)}
                      className="flex w-full flex-wrap items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-hover/50"
                    >
                      <span className="text-subtle">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                      <span
                        data-http-method={ep.method}
                        className={cn(
                          "inline-flex w-16 shrink-0 justify-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold",
                          methodBadgeTone(ep.method),
                        )}
                      >
                        {ep.method}
                      </span>
                      <code className="min-w-0 font-mono text-[12px] font-medium text-foreground">
                        {ep.path}
                      </code>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                        {ep.summary}
                      </span>
                      <span className="shrink-0 rounded bg-surface px-2 py-0.5 text-[11px] text-subtle">
                        {ep.tag}
                      </span>
                    </button>

                    {isExpanded && (
                      <div
                        data-openapi-detail={ep.key}
                        className="space-y-3 border-t bg-surface px-4 py-3.5 text-[12px]"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="font-medium text-foreground">{ep.summary}</p>
                            {ep.description && (
                              <p className="text-muted-foreground">{ep.description}</p>
                            )}
                          </div>
                          <button
                            type="button"
                            data-copy-curl={ep.key}
                            onClick={() => void triggerCopy(copyId, curlCmd)}
                            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-canvas px-2.5 text-[11px] font-medium text-foreground hover:bg-hover"
                          >
                            {copiedKey === copyId ? (
                              <>
                                <Check size={12} className="text-emerald-600" />
                                {t("已复制")}
                              </>
                            ) : (
                              <>
                                <Terminal size={12} className="text-primary" />
                                {t("复制 cURL")}
                              </>
                            )}
                          </button>
                        </div>

                        {/* Parameters */}
                        {ep.parameters.length > 0 && (
                          <div>
                            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                              {t("请求参数")}
                            </p>
                            <div className="overflow-x-auto rounded border">
                              <table className="w-full border-collapse text-left text-[11px]">
                                <thead>
                                  <tr className="border-b bg-canvas/70 text-subtle">
                                    <th className="px-2.5 py-1.5 font-medium">{t("参数名")}</th>
                                    <th className="px-2.5 py-1.5 font-medium">{t("位置")}</th>
                                    <th className="px-2.5 py-1.5 font-medium">{t("类型")}</th>
                                    <th className="px-2.5 py-1.5 font-medium">{t("说明")}</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y">
                                  {ep.parameters.map((p) => (
                                    <tr key={`${p.in}:${p.name}`}>
                                      <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-foreground">
                                        {p.name}
                                        {p.required && (
                                          <span className="ml-1 text-destructive">*</span>
                                        )}
                                      </td>
                                      <td className="whitespace-nowrap px-2.5 py-1.5 text-subtle">
                                        {p.in}
                                      </td>
                                      <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-subtle">
                                        {p.schema?.type ?? "string"}
                                      </td>
                                      <td className="px-2.5 py-1.5 text-muted-foreground">
                                        {p.description ?? "—"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* Request Body Schema */}
                        {bodyProps.length > 0 && (
                          <div>
                            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                              <Code2 size={12} />
                              {t("请求体字段")}
                              <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] font-normal lowercase">
                                {ep.contentType}
                              </code>
                            </p>
                            <div className="grid gap-1.5 sm:grid-cols-2">
                              {bodyProps.map(([propName, prop]) => (
                                <div
                                  key={propName}
                                  className="rounded border bg-canvas/50 px-2.5 py-1.5"
                                >
                                  <div className="flex items-center gap-1.5">
                                    <code className="font-mono text-[11px] font-medium text-foreground">
                                      {propName}
                                    </code>
                                    {bodyRequired.has(propName) && (
                                      <span className="text-[10px] font-medium text-destructive">
                                        {t("必填")}
                                      </span>
                                    )}
                                    <span className="ml-auto font-mono text-[10px] text-subtle">
                                      {prop.type ?? "any"}
                                    </span>
                                  </div>
                                  {prop.description && (
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                                      {prop.description}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Responses */}
                        {ep.responses.length > 0 && (
                          <div>
                            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                              {t("响应状态码")}
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {ep.responses.map((resp) => (
                                <span
                                  key={resp.code}
                                  className={cn(
                                    "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px]",
                                    responseBadgeTone(resp.code),
                                  )}
                                >
                                  <code className="font-mono font-semibold">{resp.code}</code>
                                  <span>{resp.description}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Pre-filled cURL snippet */}
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                            {t("cURL 示例")}
                          </p>
                          <pre
                            data-curl-preview={ep.key}
                            className="overflow-x-auto rounded-md border bg-canvas px-3 py-2 font-mono text-[11px] text-foreground"
                          >
                            <code>{curlCmd}</code>
                          </pre>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
