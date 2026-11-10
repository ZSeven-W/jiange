// Tests run in plain node (no jsdom). Provide a minimal localStorage so the
// i18n module (and components using it) behave like the browser.
if (typeof localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  } as Storage;
}
// Tests assert Chinese UI text (the source language); jsdom's navigator
// language is en-US, so pin the locale before any module reads it.
localStorage.setItem("jiange.locale", "zh-CN");
