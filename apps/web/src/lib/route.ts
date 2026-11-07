import { useEffect, useState } from "react";

export type Route = { page: "home" } | { page: "recent" } | { page: "doc"; id: number } | { page: "playground" } | { page: "trash" } | { page: "favorites" } | { page: "join"; token: string } | { page: "base"; id: number } | { page: "form"; token: string } | { page: "legacy-form" } | { page: "public"; token: string } | { page: "drive"; folderId: number | null };

export function parseHash(h: string): Route {
  const m = /^#\/doc\/(\d+)/.exec(h);
  if (m) return { page: "doc", id: Number(m[1]) };
  const bm = /^#\/base\/(\d+)/.exec(h);
  if (bm) return { page: "base", id: Number(bm[1]) };
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
    const m = h.match(/^#\/drive\/(\d+)/);
    return { page: "drive", folderId: m ? Number(m[1]) : null };
  }
  const pb = h.match(/^#\/p\/([A-Za-z0-9_-]+)/);
  if (pb) return { page: "public", token: pb[1] };
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
