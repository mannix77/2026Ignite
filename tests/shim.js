// Minimal browser globals so the app's storage and data modules can be imported under Node.
// Set globalThis.__quota to a byte count to make localStorage.setItem fail like a full disk.
// A real browser's quota (~5MB) is shared across every key on the origin - the main site,
// /gino/, and all three conferences each save under their own key - so the check here sums
// every stored key's size, not just the one being written (issue #77).
const mem = new Map();
const storedBytes = excludeKey => {
  let total = 0;
  for (const [k, v] of mem) if (k !== excludeKey) total += v.length;
  return total;
};
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    const value = String(v);
    if (globalThis.__quota != null && storedBytes(k) + value.length > globalThis.__quota) {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      throw e;
    }
    mem.set(k, value);
  },
  removeItem: k => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.location ??= { search: '', hostname: 'localhost', href: 'https://example.github.io/2026Ignite/' };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
