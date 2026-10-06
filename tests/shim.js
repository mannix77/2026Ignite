// Minimal browser globals so the app's storage and data modules can be imported under Node.
// Set globalThis.__quota to a byte count to make localStorage.setItem fail like a full disk.
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    if (globalThis.__quota != null && String(v).length > globalThis.__quota) {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      throw e;
    }
    mem.set(k, String(v));
  },
  removeItem: k => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.location ??= { search: '', hostname: 'localhost', href: 'https://example.github.io/2026Ignite/' };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
