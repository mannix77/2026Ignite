// Regression tests for the robustness audit: bad data, storage failures, cache keys and the
// cost of comparing options in a large clash.  Run with: node tests/robustness.test.js
import { sleep } from './shim.js';

const store = await import('../assets/js/store.js');
const { buildModel, diffKnown, cacheUrl } = await import('../assets/js/data.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');
const { createVenue } = await import('../assets/js/venue.js');
const { compareOptions, DEFAULT_PLANNER } = await import('../assets/js/planner.js');
const { checkLive } = await import('../assets/js/live.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}`);
}

// ---- settings survive a reload
await test('should keep the conference lunch window after a reload when only the length was edited', async () => {
  localStorage.clear();
  store.configure({ defaults: { lunch: CONFERENCES.gartner2026.lunch }, buildingIds: ['D', 'S'] });
  store.load('gartner2026');
  store.updateSettings({ lunch: { length: 45 } });
  await sleep(200);
  store.load('gartner2026');
  eq([store.settings().lunch.from, store.settings().lunch.to, store.settings().lunch.length], [705, 885, 45]);
});

// ---- the live result is cached under a URL the Cache API accepts
await test('should build an https cache URL for the persisted live result', () => {
  eq(new URL(cacheUrl('ignite26.planner.live:ignite2026', 'https://example.github.io/2026Ignite/')).protocol, 'https:');
});

// ---- malformed catalog records
const ignite = CONFERENCES.ignite2026;
const venue = createVenue(ignite.venue);
const rec = { id: 'X', inst: 'X', code: 'BRK1', title: 't', type: 'Breakout', delivery: ['In-person'], speakers: [], dur: 45 };
const build = patch => buildModel({ sessions: [{ ...rec, ...patch }] }, { overrides: {} }, null, ignite, venue);
for (const [name, patch] of [['a null speaker', { speakers: [null] }], ['a text delivery', { delivery: 'In-person' }], ['text topics', { topics: 'AI' }], ['null tags', { tags: null }]]) {
  await test(`should build the model when a record has ${name}`, () => {
    eq(build(patch).sessions.length, 1);
  });
}
await test('should skip records that are not objects', () => {
  eq(buildModel({ sessions: [null, 7, { ...rec }] }, { overrides: {} }, null, ignite, venue).sessions.length, 1);
});
await test('should not schedule a session whose end comes before its start', () => {
  const s = build({ start: '2026-11-18T18:00:00Z', end: '2026-11-18T17:00:00Z' }).sessions[0];
  eq(s.endMin - s.startMin, 45);
});

// ---- corrupted saved state
await test('should ignore null entries in stored change-tracking snapshots', () => {
  localStorage.clear();
  localStorage.setItem('ignite26.planner.v1:corrupt', JSON.stringify({ v: 1, picks: {}, known: { a: null, b: { inst: 'b', g: 'G' } } }));
  store.load('corrupt');
  eq(Object.keys(store.get().known), ['b']);
});
await test('should raise no alert from a null stored snapshot entry', () => {
  eq(diffKnown({ byGroup: new Map() }, new Set(), { x: null }).alerts, []);
});

// ---- change alerts on the sessions you picked (diffKnown against the last acknowledged snapshot)
const run = (inst, patch = {}) => ({ ...rec, id: 'ICE', inst, code: inst, group: 'ANT319', title: 'Iceberg analytics',
  start: '2026-11-18T17:00:00Z', end: '2026-11-18T18:00:00Z', room: 'Moscone West, Level 2, Room 2001', ...patch });
const catalog = runs => buildModel({ sessions: runs }, { overrides: {} }, null, ignite, venue);
const acknowledged = runs => diffKnown(catalog(runs), new Set(['ANT319']), {}).next;
const alertsAfter = (before, after, picked = ['ANT319']) =>
  diffKnown(catalog(after), new Set(picked), acknowledged(before)).alerts.map(a => [a.kind, a.code, Object.keys(a.fields || {})]);

await test('should alert when a picked session moves room', () => {
  eq(alertsAfter([run('ANT319-R')], [run('ANT319-R', { room: 'Moscone South, Room 156' })]), [['changed', 'ANT319-R', ['room']]]);
});
await test('should alert when a picked session is retimed', () => {
  eq(alertsAfter([run('ANT319-R')], [run('ANT319-R', { start: '2026-11-18T19:00:00Z', end: '2026-11-18T20:00:00Z' })]),
    [['changed', 'ANT319-R', ['start', 'end']]]);
});
await test('should alert when one run of a picked session is cancelled', () => {
  eq(alertsAfter([run('ANT319-R'), run('ANT319-R1')], [run('ANT319-R')]), [['run-removed', 'ANT319-R1', []]]);
});
await test('should alert when a picked session is cancelled entirely', () => {
  eq(alertsAfter([run('ANT319-R')], []), [['removed', 'ANT319-R', []]]);
});
await test('should alert when a picked session gains a run', () => {
  eq(alertsAfter([run('ANT319-R')], [run('ANT319-R'), run('ANT319-R1')]), [['run-added', 'ANT319-R1', []]]);
});
await test('should not alert about a cancelled session you have since unpicked', () => {
  eq(alertsAfter([run('ANT319-R')], [], []), []);
});
await test('should alert only for picked sessions', () => {
  const other = (patch = {}) => run('DVT212', { id: 'DVT', group: 'DVT212', ...patch });
  eq(alertsAfter([run('ANT319-R'), other()], [run('ANT319-R', { room: 'Moscone South, Room 156' }), other({ room: 'Moscone South, Room 160' })]),
    [['changed', 'ANT319-R', ['room']]]);
});

// ---- failed saves are reported, not swallowed
await test('should tell subscribers when picks could not be saved', async () => {
  localStorage.clear();
  store.load('quota');
  const seen = [];
  const off = store.subscribe(w => seen.push(w));
  globalThis.__quota = 10;
  store.mutatePicks(p => { p.A = { p: 3, lock: null, note: '', at: 1 }; });
  await sleep(200);
  globalThis.__quota = null;
  off();
  eq(seen.includes('save-error'), true);
});

// ---- comparing options in a large clash stays cheap
await test('should run at most the cap of what-if plans for a large clash', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    key: `k${i}`, id: `g${i}`, code: `C${i}`, title: `T${i}`, type: 'Breakout', day: '2026-11-18',
    startMin: 600, endMin: 645, loc: { building: 'W', floor: '2', known: true, label: '' }, priority: 1 + (i % 3), locked: false,
  }));
  const out = compareOptions(items, items, { ...DEFAULT_PLANNER, walk: venue.walk }, null, { cap: 4 });
  eq(out.outcomes.size, 4);
});

await test('should refuse a live catalog whose entries largely lack session ids', async () => {
  const raw = Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? { title: `T${i}` } : { sessionId: `s${i}`, title: `T${i}`, sessionCode: `C${i}` }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async u => ({ ok: true, json: async () => (String(u).includes('settings') ? {} : raw) });
  let err = null;
  try { await checkLive({ sessions: [] }, ignite); } catch (e) { err = e.message; } finally { globalThis.fetch = realFetch; }
  eq(/malformed/.test(err || ''), true);
});

// ---- a live feed that is largely malformed is refused, not read as removals
await test('should refuse a live catalog whose entries are largely malformed', async () => {
  const raw = Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? null : { sessionId: `s${i}`, title: `T${i}`, sessionCode: `C${i}` }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async u => ({ ok: true, json: async () => (String(u).includes('settings') ? {} : raw) });
  let err = null;
  try { await checkLive({ sessions: raw.filter(Boolean) }, ignite); } catch (e) { err = e.message; } finally { globalThis.fetch = realFetch; }
  eq(/malformed/.test(err || ''), true);
});

// ---- the service worker (sw.js), run in a sandbox with fake caches and fetch
const fs = await import('node:fs');
const vm = await import('node:vm');
const path = await import('node:path');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SW_SOURCE = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

// Loads sw.js as the worker for `scope`, with the named caches already present.
function worker(scope, cacheNames = []) {
  const handlers = {};
  const existing = new Set(cacheNames);
  const deleted = [];
  const self = {
    registration: { scope }, location: new URL(scope), clients: { claim: async () => {}, matchAll: async () => [] },
    addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {},
  };
  const caches = { keys: async () => [...existing], delete: async k => { deleted.push(k); return existing.delete(k); },
    open: async () => ({ match: async () => undefined, put: async () => {}, addAll: async () => {} }) };
  vm.runInNewContext(SW_SOURCE, { self, caches, URL, Request: class { constructor(u) { this.url = u; } }, setTimeout, fetch: async () => { throw new Error('offline'); } });
  return { handlers, deleted, consts: vm.runInNewContext(`${SW_SOURCE}; ({ SHELL, DATA, VERSION, SHELL_PREFIX })`, { self, caches, URL }) };
}
const MAIN = 'https://example.github.io/2026Ignite/';

await test('should list every app file for offline use, and only files that exist', () => {
  const { SHELL } = worker(MAIN).consts;
  const onDisk = ['index.html', 'manifest.webmanifest', ...['assets/css', 'assets/js', 'assets/icons']
    .flatMap(d => fs.readdirSync(path.join(ROOT, d)).map(f => `${d}/${f}`))].sort();
  eq(SHELL.filter(p => p !== './').sort(), onDisk);
});

await test("should list every conference's catalog for offline use", () => {
  const { DATA } = worker(MAIN).consts;
  const missing = Object.values(CONFERENCES).map(c => `${c.dataDir}/sessions.json`).filter(p => !DATA.includes(p));
  eq(missing, []);
});

await test("should delete only this copy's old app caches when a new version activates", async () => {
  const { consts } = worker(MAIN);
  const mine = consts.SHELL_PREFIX;
  const w = worker(MAIN, [`${mine}old`, `${mine}${consts.VERSION}`, 'shell-legacy', 'data-v1', 'shell:/2026Ignite/gino/:old']);
  let done;
  w.handlers.activate({ waitUntil: p => { done = p; } });
  await done;
  eq(w.deleted.sort(), [`${mine}old`, 'shell-legacy'].sort());
});

await test("should leave a colleague's copy to its own worker", () => {
  const { handlers } = worker(MAIN);
  let answered = false;
  handlers.fetch({ request: { method: 'GET', url: `${MAIN}gino/index.html`, mode: 'navigate' }, respondWith: () => { answered = true; } });
  eq(answered, false);
});

await test('should answer for its own app page', () => {
  const { handlers } = worker(MAIN);
  let answered = false;
  handlers.fetch({ request: { method: 'GET', url: `${MAIN}index.html`, mode: 'navigate' }, respondWith: p => { answered = true; p.catch(() => {}); } });
  eq(answered, true);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
