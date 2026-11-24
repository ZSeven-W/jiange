import { useId, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { enterpriseApi, type WorkspaceSecurityPolicy } from "@/lib/enterprise-api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const DEFAULT_WATERMARK_OPACITY = 0.07;
export const MIN_WATERMARK_OPACITY = 0.02;
export const MAX_WATERMARK_OPACITY = 0.25;

export const workspaceSecurityPolicyQueryKey = (workspaceId?: number) =>
  ["workspace-security-policy", workspaceId ?? 0] as const;

/**
 * Fetches the workspace's unified security policy (including suite-wide watermark settings).
 */
export function useWorkspaceSecurityPolicy(workspaceId?: number) {
  const validWs = typeof workspaceId === "number" && Number.isFinite(workspaceId) && workspaceId > 0;
  return useQuery<WorkspaceSecurityPolicy>({
    queryKey: workspaceSecurityPolicyQueryKey(validWs ? workspaceId : 0),
    queryFn: ({ signal }) => enterpriseApi.getSecurityPolicy(workspaceId!, undefined, signal),
    enabled: validWs,
    staleTime: 60_000,
    retry: false,
  });
}

export interface FormatWatermarkLabelOptions {
  policy?: Partial<WorkspaceSecurityPolicy> | null;
  userName?: string | null;
  userEmail?: string | null;
  copyProtected?: boolean;
  customText?: string | null;
  date?: Date | string | null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatWatermarkDate(input?: Date | string | null): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    if (trimmed) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return `${parsed.getUTCFullYear()}-${pad2(parsed.getUTCMonth() + 1)}-${pad2(parsed.getUTCDate())}`;
      }
    }
  }
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    // Preserve exact calendar date for both UTC midnight ISO dates and local Date instances.
    if (
      input.getUTCHours() === 0 &&
      input.getUTCMinutes() === 0 &&
      input.getUTCSeconds() === 0 &&
      input.getUTCMilliseconds() === 0
    ) {
      return `${input.getUTCFullYear()}-${pad2(input.getUTCMonth() + 1)}-${pad2(input.getUTCDate())}`;
    }
    return `${input.getFullYear()}-${pad2(input.getMonth() + 1)}-${pad2(input.getDate())}`;
  }
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function clampWatermarkOpacityValue(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WATERMARK_OPACITY;
  return Math.min(MAX_WATERMARK_OPACITY, Math.max(MIN_WATERMARK_OPACITY, value));
}

/**
 * Formats the diagonal watermark string for a document/sheet/base/slides view.
 * Returns null when neither workspace policy nor copy-protection requests a watermark.
 */
export function formatWatermarkLabel({
  policy,
  userName,
  userEmail,
  copyProtected,
  customText,
  date,
}: FormatWatermarkLabelOptions): string | null {
  const policyEnabled = Boolean(policy?.watermarkEnabled);
  const protectedFallback = Boolean(copyProtected);
  if (!policyEnabled && !protectedFallback) {
    return null;
  }

  const cleanName = (userName ?? "").trim();
  const cleanEmail = (userEmail ?? "").trim();
  const cleanCustom = (customText ?? "").trim();

  if (policyEnabled) {
    const parts: string[] = [];
    const prefix = cleanCustom || (policy?.watermarkText ?? "").trim();
    if (prefix) parts.push(prefix);
    if ((policy?.watermarkShowUser ?? true) && cleanName) parts.push(cleanName);
    if ((policy?.watermarkShowEmail ?? true) && cleanEmail) parts.push(cleanEmail);
    if (policy?.watermarkShowDate ?? true) parts.push(formatWatermarkDate(date));
    if (parts.length > 0) return parts.join(" · ");
    return cleanName || cleanEmail || t("机密文档");
  }

  // copyProtected fallback when workspace-wide watermark policy is disabled or absent.
  const fallbackParts: string[] = [];
  if (cleanCustom) fallbackParts.push(cleanCustom);
  if (cleanName) fallbackParts.push(cleanName);
  if (cleanEmail) fallbackParts.push(cleanEmail);
  if (fallbackParts.length > 0) return fallbackParts.join(" ");
  return t("机密文档");
}

function estimateTileWidth(label: string, compact: boolean): number {
  let width = 0;
  for (const ch of label) {
    width += ch.charCodeAt(0) > 0x2e7f ? 13 : 7.5;
  }
  const minW = compact ? 180 : 250;
  const maxW = compact ? 380 : 560;
  const pad = compact ? 56 : 96;
  return Math.round(Math.min(maxW, Math.max(minW, width + pad)));
}

export interface DocumentWatermarkProps {
  workspaceId?: number;
  policy?: Partial<WorkspaceSecurityPolicy> | null;
  userName?: string | null;
  userEmail?: string | null;
  copyProtected?: boolean;
  customText?: string | null;
  date?: Date | string | null;
  /** When true, fills the nearest relative container instead of fixed full-viewport overlay. */
  contained?: boolean;
  className?: string;
}

interface OverlayProps {
  policy?: Partial<WorkspaceSecurityPolicy> | null;
  userName?: string | null;
  userEmail?: string | null;
  copyProtected?: boolean;
  customText?: string | null;
  date?: Date | string | null;
  contained?: boolean;
  className?: string;
}

function DocumentWatermarkOverlay({
  policy,
  userName,
  userEmail,
  copyProtected,
  customText,
  date,
  contained = false,
  className,
}: OverlayProps) {
  const rawId = useId();
  const patternId = useMemo(() => `jg-wm-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [rawId]);

  const label = useMemo(
    () => formatWatermarkLabel({ policy, userName, userEmail, copyProtected, customText, date }),
    [policy, userName, userEmail, copyProtected, customText, date],
  );

  if (!label) return null;

  const source = policy?.watermarkEnabled ? "policy" : "copy-protected";
  const opacity = clampWatermarkOpacityValue(
    policy?.watermarkEnabled ? policy?.watermarkOpacity : DEFAULT_WATERMARK_OPACITY,
  );
  const tileW = estimateTileWidth(label, contained);
  const rowH = contained ? 96 : 148;
  const patternH = rowH * 2;
  const fontSize = contained ? 12 : 13;

  return (
    <div
      className={cn(
        contained
          ? "pointer-events-none absolute inset-0 z-10 select-none overflow-hidden"
          : "pointer-events-none fixed inset-0 z-50 select-none overflow-hidden",
        className,
      )}
      data-watermark=""
      data-watermark-source={source}
      data-watermark-label={label}
      data-watermark-opacity={String(opacity)}
      aria-hidden="true"
    >
      <svg
        className="h-full w-full text-[#1f2329] dark:text-[#e8eaed]"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern
            id={patternId}
            width={tileW}
            height={patternH}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(-24)"
          >
            <text
              x={tileW / 2}
              y={rowH * 0.55}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="currentColor"
              fillOpacity={opacity}
              fontSize={fontSize}
              fontWeight="500"
              letterSpacing="0.02em"
              style={{ fontFamily: "var(--font-sans, Inter, PingFang SC, sans-serif)" }}
            >
              {label}
            </text>
            <text
              x={0}
              y={rowH * 1.55}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="currentColor"
              fillOpacity={opacity}
              fontSize={fontSize}
              fontWeight="500"
              letterSpacing="0.02em"
              style={{ fontFamily: "var(--font-sans, Inter, PingFang SC, sans-serif)" }}
            >
              {label}
            </text>
            <text
              x={tileW}
              y={rowH * 1.55}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="currentColor"
              fillOpacity={opacity}
              fontSize={fontSize}
              fontWeight="500"
              letterSpacing="0.02em"
              style={{ fontFamily: "var(--font-sans, Inter, PingFang SC, sans-serif)" }}
            >
              {label}
            </text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    </div>
  );
}

function WorkspacePolicyWatermark({ workspaceId, ...rest }: DocumentWatermarkProps & { workspaceId: number }) {
  const { data } = useWorkspaceSecurityPolicy(workspaceId);
  return <DocumentWatermarkOverlay {...rest} policy={data} />;
}

/**
 * Unified suite-wide diagonal tiled watermark overlay supporting Workspace Security Policy
 * and per-document copy-protection across Doc, Sheet, Base, Slides, and ReadOnly pages.
 */
export function DocumentWatermark(props: DocumentWatermarkProps) {
  if (props.policy !== undefined || !props.workspaceId || props.workspaceId <= 0) {
    return <DocumentWatermarkOverlay {...props} />;
  }
  return <WorkspacePolicyWatermark {...props} workspaceId={props.workspaceId} />;
}
