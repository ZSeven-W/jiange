import { useEffect, useState } from "react";

export type Route = { page: "home" } | { page: "recent" } | { page: "doc"; id: number } | { page: "playground" } | { page: "trash" } | { page: "join"; token: string } | { page: "base"; id: number };

export function parseHash(h: string): Route {
  const m = /^#\/doc\/(\d+)/.exec(h);
  if (m) return { page: "doc", id: Number(m[1]) };
  const bm = /^#\/base\/(\d+)/.exec(h);
  if (bm) return { page: "base", id: Number(bm[1]) };
  const j = /^#\/s\/([0-9a-f]+)/.exec(h);
  if (j) return { page: "join", token: j[1] };
  if (h.startsWith("#/recent")) return { page: "recent" };
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
