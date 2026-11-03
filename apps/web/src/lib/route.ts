import { useEffect, useState } from "react";

export type Route = { page: "home" } | { page: "recent" } | { page: "doc"; id: number } | { page: "playground" };

export function parseHash(h: string): Route {
  const m = /^#\/doc\/(\d+)/.exec(h);
  if (m) return { page: "doc", id: Number(m[1]) };
  if (h.startsWith("#/recent")) return { page: "recent" };
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
