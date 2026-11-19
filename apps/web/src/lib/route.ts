import { useEffect, useState } from "react";
import { versionFromHash } from "./version-link";

export type Route = { page: "home" } | { page: "recent" } | { page: "doc"; id: number; versionId?: string | null } | { page: "unsupported"; id: number } | { page: "playground" } | { page: "trash" } | { page: "favorites" } | { page: "join"; token: string } | { page: "base"; id: number } | { page: "slides"; id: number } | { page: "sheet"; id: number } | { page: "file"; id: number } | { page: "form"; token: string } | { page: "legacy-form" } | { page: "public"; token: string } | { page: "drive"; folderId: number | null; personal: boolean } | { page: "org" } | { page: "wiki" } | { page: "wiki-space"; spaceId: number; nodeId: number | null };

export function parseHash(h: string): Route {
  const unsupported = /^#\/unsupported\/(\d+)\/?$/.exec(h);
  if (unsupported) { const id = Number(unsupported[1]); return Number.isSafeInteger(id) && id > 0 ? { page: "unsupported", id } : { page: "home" }; }
  const m = /^#\/doc\/(\d+)/.exec(h);
  if (m) { const versionId = versionFromHash(h); return versionId === undefined ? { page: "doc", id: Number(m[1]) } : { page: "doc", id: Number(m[1]), versionId }; }
  const bm = /^#\/base\/(\d+)/.exec(h);
  if (bm) return { page: "base", id: Number(bm[1]) };
  const file = /^#\/file\/(\d+)\/?$/.exec(h);
  if (file) return { page: "file", id: Number(file[1]) };
  const sm = /^#\/slides\/(\d+)/.exec(h);
  if (sm) return { page: "slides", id: Number(sm[1]) };
  const shm = /^#\/sheet\/(\d+)/.exec(h);
  if (shm) return { page: "sheet", id: Number(shm[1]) };
  const j = /^#\/s\/([0-9a-f]+)/.exec(h);
  if (j) return { page: "join", token: j[1] };
  if (h.startsWith("#/recent")) return { page: "recent" };
  if (h.startsWith("#/favorites")) return { page: "favorites" };
  // Old numeric links were enumerable and are intentionally no longer public.
  if (/^#\/form\/\d+\/\d+\/?$/.test(h)) return { page: "legacy-form" };
  const fm = h.match(/^#\/form\/([A-Za-z0-9_-]{43})\/?$/);
  if (fm) return { page: "form", token: fm[1] };
  if (h.startsWith("#/form/")) return { page: "legacy-form" };
	if (h.startsWith("#/drive")) {
		if (/^#\/drive\/mine\/?$/.test(h)) return { page: "drive", folderId: null, personal: true };
		const m = h.match(/^#\/drive\/(\d+)/);
		return { page: "drive", folderId: m ? Number(m[1]) : null, personal: false };
	}
  const pb = h.match(/^#\/p\/([A-Za-z0-9_-]+)/);
  if (pb) return { page: "public", token: pb[1] };
  const wn = /^#\/wiki\/(\d+)\/node\/(\d+)/.exec(h);
  if (wn) {
    const spaceId = Number(wn[1]);
    const nodeId = Number(wn[2]);
    if (Number.isSafeInteger(spaceId) && spaceId > 0 && Number.isSafeInteger(nodeId) && nodeId > 0) {
      return { page: "wiki-space", spaceId, nodeId };
    }
  }
  const ws = /^#\/wiki\/(\d+)\/?$/.exec(h);
  if (ws) {
    const spaceId = Number(ws[1]);
    if (Number.isSafeInteger(spaceId) && spaceId > 0) return { page: "wiki-space", spaceId, nodeId: null };
  }
  if (h.startsWith("#/wiki")) return { page: "wiki" };
  if (h.startsWith("#/org")) return { page: "org" };
  if (h.startsWith("#/trash")) return { page: "trash" };
  if (h.startsWith("#/playground")) return { page: "playground" };
  return { page: "home" };
}

export function useRoute(): Route {
  const [r, setR] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setR(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const go = (hash: string) => {
  location.hash = hash;
};

export function isKnownNodeKind(kind: unknown): kind is "doc" | "base" | "slides" | "sheet" | "file" | "folder" {
  return kind === "doc" || kind === "base" || kind === "slides" || kind === "sheet" || kind === "file" || kind === "folder";
}

/** Route known node kinds to their dedicated editor or viewer. */
export function nodeHref(d: { id: number; kind?: string; wikiSpaceId?: number | null }): string {
  if (!Number.isSafeInteger(d.id) || d.id <= 0) return "#/";
  if (d.wikiSpaceId && Number.isSafeInteger(d.wikiSpaceId) && d.wikiSpaceId > 0) {
    return `#/wiki/${d.wikiSpaceId}/node/${d.id}`;
  }
  if (d.kind === "doc") return `#/doc/${d.id}`;
  if (d.kind === "base") return `#/base/${d.id}`;
  if (d.kind === "slides") return `#/slides/${d.id}`;
  if (d.kind === "sheet") return `#/sheet/${d.id}`;
  if (d.kind === "file") return `#/file/${d.id}`;
  if (d.kind === "folder") return `#/drive/${d.id}`;
  return `#/unsupported/${d.id}`;
}
