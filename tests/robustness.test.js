// Regression tests for the robustness audit: bad data, storage failures, cache keys and the
// cost of comparing options in a large clash.  Run with: node tests/robustness.test.js
import { sleep } from './shim.js';

const store = await import('../assets/js/store.js');
const { buildModel, diffKnown, cacheUrl } = await import('../assets/js/data.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');
const { createVenue } = await import('../assets/js/venue.js');
const { canBoth, compareOptions, optimize, lunchConfig, DEFAULT_PLANNER } = await import('../assets/js/planner.js');
const { checkLive, liveWindow, changeCounts, countsLine, diff: liveDiff } = await import('../assets/js/live.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ? `${msg}: ` : ''}expected ${B}, got ${A}`);
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
for (const [name, patch, read, want] of [
  ['a null speaker', { speakers: [null] }, s => s.speakers, []],
  ['a text delivery', { delivery: 'In-person' }, s => [s.delivery, s.inPerson], [['In-person'], true]],
  ['text topics', { topics: 'AI' }, s => s.topics, ['AI']],
  ['null tags', { tags: null }, s => s.tags, []],
]) {
  await test(`should read a record that has ${name}`, () => {
    eq(read(build(patch).sessions[0]), want);
  });
}
await test('should skip records that are not objects', () => {
  eq(buildModel({ sessions: [null, 7, { ...rec }] }, { overrides: {} }, null, ignite, venue).sessions.length, 1);
});
await test('should schedule a session whose end comes before its start by its duration', () => {
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
await test("should tell subscribers the device's storage is full, not just that the save failed", async () => {
  // A full quota is reported as its own event (issue #140's "storage full" telemetry), distinct
  // from the general 'save-error' (blocked storage, private mode); shim.js's localStorage
  // throws a QuotaExceededError the same way a real full disk would.
  localStorage.clear();
  store.load('quota');
  const seen = [];
  const off = store.subscribe(w => seen.push(w));
  globalThis.__quota = 10;
  store.mutatePicks(p => { p.A = { p: 3, lock: null, note: '', at: 1 }; });
  await sleep(200);
  globalThis.__quota = null;
  off();
  eq(seen.includes('storage-full'), true);
  eq(seen.includes('save-error'), false);   // one event per failure, not both
});

// ---- the test shim's storage quota is shared across every key, like a real browser (issue #77)
// A real browser gives ~5MB per origin, shared by every key saved there (the main site, /gino/,
// and all three conferences each save under their own key), so tests/shim.js must fail a write
// once the site's total crosses the quota, not only when the one value being written is itself
// that large.
await test('should fail a small write once other keys already fill the shared quota', () => {
  localStorage.clear();
  globalThis.__quota = 100;
  localStorage.setItem('a', 'x'.repeat(60));
  localStorage.setItem('b', 'x'.repeat(30));
  let threw = null;
  try { localStorage.setItem('c', 'x'.repeat(20)); } catch (e) { threw = e.name; }
  globalThis.__quota = null;
  eq([threw, localStorage.getItem('c')], ['QuotaExceededError', null], 'c alone is well under 100 bytes, but a+b+c is not');
});
await test('should allow a write that exactly fills the shared quota, and refuse one byte more', () => {
  localStorage.clear();
  globalThis.__quota = 100;
  localStorage.setItem('a', 'x'.repeat(60));
  localStorage.setItem('b', 'x'.repeat(40));
  eq(localStorage.getItem('b'), 'x'.repeat(40));
  localStorage.removeItem('b');
  let threw = null;
  try { localStorage.setItem('b', 'x'.repeat(41)); } catch (e) { threw = e.name; }
  globalThis.__quota = null;
  eq(threw, 'QuotaExceededError');
});
await test("should not count a key's own previous value against itself when it is overwritten", () => {
  localStorage.clear();
  globalThis.__quota = 100;
  localStorage.setItem('a', 'x'.repeat(90));
  localStorage.setItem('a', 'y'.repeat(95)); // replacing it, not adding to it: still under 100 total
  globalThis.__quota = null;
  eq(localStorage.getItem('a'), 'y'.repeat(95));
});
await test('should free room for a later write once a key is removed', () => {
  localStorage.clear();
  globalThis.__quota = 100;
  localStorage.setItem('a', 'x'.repeat(90));
  localStorage.removeItem('a');
  localStorage.setItem('b', 'x'.repeat(95));
  globalThis.__quota = null;
  eq(localStorage.getItem('b'), 'x'.repeat(95));
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

// ---- a 300-pick plan re-plans quickly (issue #81): the real re:Invent catalog, many repeat runs
await test('should re-plan 300 picks on the real re:Invent catalog within a generous budget', async () => {
  const { readFileSync } = await import('node:fs');
  const conf = CONFERENCES.reinvent2026, v = createVenue(conf.venue);
  const m = buildModel(JSON.parse(readFileSync(new URL('../data/reinvent2026/sessions.json', import.meta.url), 'utf8')), { overrides: {} }, conf.rsvp, conf, v, null);
  const groups = [...m.byGroup.entries()].filter(([, runs]) => runs.some(s => s.day && s.inPerson));
  const step = groups.length / 300, items = [];
  for (let i = 0; i < 300; i++) for (const s of groups[Math.floor(i * step)][1]) {
    if (s.day && s.endMin > s.startMin && !s.onlineOnly) items.push({ key: s.key, id: s.group, code: s.code, type: s.type, day: s.day, startMin: s.startMin, endMin: s.endMin, loc: s.loc, recorded: s.recorded, priority: 3 - (i % 3), locked: false });
  }
  eq([new Set(items.map(x => x.id)).size, new Set(items.map(x => x.key)).size], [300, items.length], 'precondition: 300 distinct sessions, no run twice');
  const repeated = new Set(items.filter(x => items.filter(y => y.id === x.id).length > 1).map(x => x.id)).size;
  if (!(repeated > 50)) throw new Error(`precondition: only ${repeated} sessions have repeat runs; the slow case needs many`);
  const ctx = { ...DEFAULT_PLANNER, walk: v.walk, keynoteBuildings: v.keynoteBuildings };
  const t = performance.now();
  const res = optimize(items, ctx, lunchConfig(conf.lunch));
  const ms = performance.now() - t;
  // Fast is only worth anything if the plan is right.
  const planned = Object.values(res.plan).flat(), ids = planned.map(x => x.id);
  if (planned.length === 0) throw new Error('the plan is empty');
  eq(new Set(ids).size, ids.length, 'a session attended twice');
  if (!planned.every(x => items.includes(x))) throw new Error("a planned item that isn't one of the picks");
  for (const [day, dayPlan] of Object.entries(res.plan)) for (const x of dayPlan) {
    if (x.day !== day) throw new Error(`${x.key} filed under ${day} but its day is ${x.day}`);
  }
  for (const day of Object.values(res.plan)) for (const a of day) for (const b of day) {
    if (a !== b && !canBoth(a, b, ctx)) throw new Error(`${a.key} and ${b.key} clash on ${a.day}`);
  }
  if (!(ms < 1500)) throw new Error(`took ${Math.round(ms)} ms; about 40 ms on a desktop, 450 ms before #81`);
});

// ---- changes are counted per session; an extra run dropped or added is not a cancellation
await test('should count dropped extra runs apart from removed sessions', () => {
  eq(changeCounts({ added: [{ code: 'A' }, { code: 'B', repeat: true }], removed: [{ code: 'C', repeat: true }, { code: 'D' }], changed: [{ code: 'E' }] }),
    { added: 1, addedRuns: 1, removed: 1, removedRuns: 1, changed: 1 });
});

await test('should count a wholly added or removed multi-run session as one session plus extra runs', () => {
  const run = (id, inst, start) => ({ id, inst, code: inst, title: 'T', start, speakers: [] });
  const three = [run('A', 'A1', '2026-11-18T18:00:00Z'), run('A', 'A2', '2026-11-19T18:00:00Z'), run('A', 'A3', '2026-11-20T18:00:00Z')];
  const one = run('B', 'B1', '2026-11-18T19:00:00Z');
  const addedDiff = liveDiff([], [...three, one]);
  eq(addedDiff.added.map(x => [x.inst, x.repeat]), [['A1', false], ['A2', true], ['A3', true], ['B1', false]]);
  eq([addedDiff.removed, addedDiff.changed], [[], []]);
  eq(changeCounts(addedDiff), { added: 2, addedRuns: 2, removed: 0, removedRuns: 0, changed: 0 });
  const removedDiff = liveDiff([...three, one], []);
  eq([removedDiff.added, removedDiff.changed], [[], []]);
  eq(removedDiff.removed.map(x => [x.inst, x.repeat]), [['A1', false], ['A2', true], ['A3', true], ['B1', false]]);
  eq(changeCounts(removedDiff), { added: 0, addedRuns: 0, removed: 2, removedRuns: 2, changed: 0 });
});

await test('should show session and extra-run counts apart in a Changes header', () => {
  eq(countsLine({ added: [{ code: 'A' }, { code: 'B', repeat: true }], removed: [{ code: 'C', repeat: true }, { code: 'D' }], changed: [{ code: 'E' }] }),
    '+1 · −1 · ~1 · +1 run · −1 run');
  eq(countsLine({ added: [{ code: 'A', repeat: true }, { code: 'B', repeat: true }], removed: [], changed: [] }), '+0 · −0 · ~0 · +2 runs');
  eq(countsLine({ added: [], removed: [], changed: [] }), '+0 · −0 · ~0');
  eq(countsLine({}), '+0 · −0 · ~0');
});

// ---- the live check's partial-catalog guard counts sessions, not runs (same rule as sync.py)
async function liveAgainst(prev, raw) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async u => ({ ok: true, json: async () => (String(u).includes('settings') ? {} : raw) });
  try { const r = await checkLive({ sessions: prev }, ignite); return r.doc.sessions.length; } catch (e) { return e.message; } finally { globalThis.fetch = realFetch; }
}
const snapRuns = (n, runs) => Array.from({ length: n * runs }, (_, i) => ({ id: `s${i % n}`, inst: `s${i % n}-run${Math.floor(i / n)}`, speakers: [] }));
const feedRuns = (n, runs) => Array.from({ length: n * runs }, (_, i) => ({ sessionId: `s${i % n}`, sessionInstanceId: `s${i % n}-run${Math.floor(i / n)}`, title: `T${i % n}`, sessionCode: `C${i % n}` }));
await test('should accept a live catalog that only drops extra runs of the same sessions', async () => {
  eq(await liveAgainst(snapRuns(100, 2), feedRuns(100, 1)), 100);
});
await test('should refuse a live catalog that loses sessions even when extra runs keep the count up', async () => {
  eq(/looks partial/.test(String(await liveAgainst(snapRuns(100, 2), feedRuns(59, 3)))), true);
});

// ---- a live feed that is largely malformed is refused, not read as removals (same 5% limit as sync.py)
async function liveCheck(raw) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async u => ({ ok: true, json: async () => (String(u).includes('settings') ? {} : raw) });
  try { await checkLive({ sessions: [] }, ignite); return null; } catch (e) { return e.message; } finally { globalThis.fetch = realFetch; }
}
const liveFeed = (every, bad) => Array.from({ length: 100 }, (_, i) => (i % every === 0 ? bad(i) : { sessionId: `s${i}`, title: `T${i}`, sessionCode: `C${i}` }));
// [name, feed, verb, expected [refused as malformed, completed without any error]]
for (const [name, raw, verb, want] of [
  ['a fifth of entries null', liveFeed(5, () => null), 'refuse', [true, false]],
  ['a fifth of entries without a session id', liveFeed(5, i => ({ title: `T${i}` })), 'refuse', [true, false]],
  ['one entry in 25 null (4%)', liveFeed(25, () => null), 'accept', [false, true]],
]) {
  await test(`should ${verb} a live catalog with ${name}`, async () => {
    const err = await liveCheck(raw);
    eq([/malformed/.test(err || ''), err === null], want);
  });
}

// ---- a relied-upon field in a shape never read before is a format change, refused with the sync's words
// (specs/features/ignite-catalog-sync.feature, "The browser agrees with the sync")
const shapedFeed = odd => Array.from({ length: 100 }, (_, i) => ({ sessionId: `s${i}`, title: `T${i}`, sessionCode: `C${i}`, location: i < odd ? { id: i } : { displayValue: `Room ${i}` } }));
await test('should refuse a live catalog whose room field changed shape, naming the field and an example', async () => {
  eq(await liveCheck(shapedFeed(100)), 'feed format changed: `location` has an unrecognised shape in 100 of 100 sessions (e.g. {"id":0}); keeping last good data');
});
await test('should accept a live catalog with odd room shapes on five entries in a hundred, and refuse at six', async () => {
  eq(await liveCheck(shapedFeed(5)), null);
  eq(/`location` has an unrecognised shape in 6 of 100/.test(String(await liveCheck(shapedFeed(6)))), true);
});

// ---- the event window the browser applies to the live catalog (same rule as sync.py)
await test("should take the browser's event window from the site's dates", () => {
  eq(liveWindow({ eventStartDate: '2026-11-16T08:00:00-08:00', eventEndDate: '2026-11-19T17:00:00-08:00' }, ignite), ['2026-11-16', '2026-11-19']);
});
await test("should fall back to the conference's days when the site's dates are reversed", () => {
  eq(liveWindow({ eventStartDate: '2026-11-20', eventEndDate: '2026-11-17' }, ignite), [ignite.days[0], ignite.days[ignite.days.length - 1]]);
});

// ---- the service worker (sw.js), run in a sandbox with fake caches and fetch
const fs = await import('node:fs');
const vm = await import('node:vm');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // decodes %20 etc. in the checkout path
const SW_SOURCE = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

// Loads sw.js as the worker for `scope`, with the named caches already present.
function worker(scope, cacheNames = [], cachedPage = undefined) {
  const handlers = {};
  const existing = new Set(cacheNames);
  const deleted = [];
  const self = {
    registration: { scope }, location: new URL(scope), clients: { claim: async () => {}, matchAll: async () => [] },
    addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {},
  };
  const caches = { keys: async () => [...existing], delete: async k => { deleted.push(k); return existing.delete(k); },
    open: async () => ({ match: async k => (k === 'index.html' ? cachedPage : undefined), put: async () => {}, addAll: async () => {} }) };
  vm.runInNewContext(SW_SOURCE, { self, caches, URL, Request: class { constructor(u) { this.url = u; } }, setTimeout, fetch: async () => { throw new Error('offline'); } });
  return { handlers, deleted, consts: vm.runInNewContext(`${SW_SOURCE}; ({ SHELL, DATA, VERSION, SHELL_PREFIX })`, { self, caches, URL }) };
}
const MAIN = 'https://example.github.io/2026Ignite/';

await test('should list every app file for offline use, and only files that exist', () => {
  const { SHELL } = worker(MAIN).consts;
  const onDisk = [
    ...['index.html', 'manifest.webmanifest'].filter(f => fs.existsSync(path.join(ROOT, f))),
    ...['assets/css', 'assets/js', 'assets/icons'].flatMap(d => fs.readdirSync(path.join(ROOT, d), { recursive: true })
      .filter(f => fs.statSync(path.join(ROOT, d, f)).isFile()).map(f => `${d}/${f.split(path.sep).join('/')}`)),
  ].sort();
  eq(SHELL.filter(p => p !== './').sort(), onDisk);
});

// data.js fetchAll reads these per conference; favorites and profile only exist for some.
await test("should list every conference's data files for offline use", () => {
  const { DATA } = worker(MAIN).consts;
  const wanted = Object.values(CONFERENCES).flatMap(c => [
    ...['sessions', 'changes', 'meta'].map(f => `${c.dataDir}/${f}.json`),
    ...['favorites', 'profile'].map(f => `${c.dataDir}/${f}.json`).filter(p => fs.existsSync(path.join(ROOT, p))),
  ]);
  eq(wanted.filter(p => !DATA.includes(p)), []);
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

// Installs sw.js for `scope` against a fake site: the CDN edge still holds the previous deploy's
// files at the addresses it has already served (`edge`, ignoring the request's cache mode, as a
// CDN does), and any other address is fetched from the new deploy (`missing` answers 404).
// Caches behave like the browser's: open creates, put/match resolve keys against the worker;
// `fullAt` makes saving that file fail as a full disk does; `fullFrom` ({file: n}) lets the
// first n saves of a file succeed and the later ones fail. `existing` maps cache names to
// {address: body}. `version` stamps sw.js the way sync.yml's sed does.
async function install(scope, { edge = new Map(), missing = '', fullAt = '', fullFrom = {}, existing = {}, version = '' } = {}) {
  const full = new Map(Object.entries(fullAt ? { ...fullFrom, [fullAt]: 0 } : fullFrom).map(([p, n]) => [new URL(p, scope).href, n]));
  const saves = new Map();
  const stamp = "const VERSION = 'ignite26-dev';";
  if (version && !SW_SOURCE.includes(stamp)) throw new Error("sw.js no longer has sync.yml's VERSION placeholder");
  const source = version ? SW_SOURCE.replace(stamp, `const VERSION = '${version}';`) : SW_SOURCE;
  const href = r => new URL(typeof r === 'string' ? r : r.url, scope).href;
  const fetched = [];
  const puts = [];
  const reply = (url, status, body) => ({ url, status, ok: status === 200, body, headers: { 'content-type': 'text/plain' }, blob: async () => body });
  const fetch = async (r, init = {}) => {
    const u = href(r);
    fetched.push({ url: u, cache: init.cache });
    const plain = new URL(u); plain.search = '';
    if (missing && plain.href === new URL(missing, scope).href) return reply(u, 404, 'not found');
    if (edge.has(u)) return reply(u, 200, edge.get(u));
    return reply(u, 200, `new:${plain.pathname}`);
  };
  // A response the worker builds itself has no address of its own, like the browser's.
  class Response {
    constructor(body, init = {}) {
      if (Object.prototype.toString.call(body) === '[object ArrayBuffer]') body = new TextDecoder().decode(body);
      Object.assign(this, { url: '', body, status: init.status, ok: init.status === 200, headers: init.headers });
    }
    clone() { return new Response(this.body, this); }
    async arrayBuffer() { return new TextEncoder().encode(this.body).buffer; }
  }
  const saved = body => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  const store = new Map(Object.entries(existing).map(([name, entries]) =>
    [name, new Map(Object.entries(entries).map(([u, body]) => [href(u), saved(body)]))]));
  const cacheFor = (name, m) => ({
    put: async (k, res) => {
      const n = saves.get(href(k)) ?? 0;
      saves.set(href(k), n + 1);
      if (full.has(href(k)) && n >= full.get(href(k))) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      puts.push([name, href(k)]);
      m.set(href(k), res);
    },
    delete: async k => m.delete(href(k)),
    match: async (k, { ignoreSearch = false } = {}) => {
      const key = new URL(href(k)); if (ignoreSearch) key.search = '';
      for (const [u, res] of m) { const c = new URL(u); if (ignoreSearch) c.search = ''; if (c.href === key.href) return res; }
      return undefined;
    },
  });
  const caches = {
    has: async name => store.has(name),
    open: async name => { if (!store.has(name)) store.set(name, new Map()); return cacheFor(name, store.get(name)); },
    keys: async () => [...store.keys()], delete: async name => store.delete(name),
  };
  const handlers = {};
  let skipped = false;
  const self = {
    registration: { scope }, location: new URL('sw.js', scope), clients: { claim: async () => {}, matchAll: async () => [] },
    addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => { skipped = true; },
  };
  const sandbox = { self, caches, URL, Response, setTimeout, fetch };
  vm.runInNewContext(source, sandbox);
  const consts = vm.runInNewContext(`${source}; ({ SHELL, SHELL_CACHE, SHELL_PREFIX })`, { ...sandbox, self: { ...self, addEventListener: () => {} } });
  let done;
  handlers.install({ waitUntil: p => { done = p; } });
  const outcome = await done.then(() => 'installed', e => `refused: ${e.message}`);
  const serve = async (url, mode = 'no-cors') => {
    let response;
    handlers.fetch({ request: { method: 'GET', url: href(url), mode }, respondWith: p => { response = p; } });
    return (await response).body;
  };
  // The files fetched for the app shell, i.e. at an address with a query.
  const shellFetches = () => fetched.filter(f => new URL(f.url).search).map(f => [f.url, f.cache]).sort();
  // The addresses saved into this version's shell cache, in order.
  const shellPuts = () => puts.filter(([name]) => name === consts.SHELL_CACHE).map(([, u]) => u);
  // What a cache holds, as {address: body}.
  const bodies = name => Object.fromEntries([...store.get(name)].map(([u, r]) => [u, r.body]));
  return { outcome, store, shellFetches, consts, skipped: () => skipped, serve, fetch, shellPuts, bodies };
}

for (const [scope, dir] of [[MAIN, '/2026Ignite/'], [`${MAIN}gino/`, '/2026Ignite/gino/']]) {
  await test(`should save the new deploy's app files when the CDN still serves the old ones (${dir})`, async () => {
    // The CDN still holds the previous deploy's files at their usual addresses and at every
    // address the previous version's worker asked for when it installed.
    const prev = await install(scope, { version: 'ignite26-old111' });
    const { consts } = prev;
    const edge = new Map([...consts.SHELL.map(p => new URL(p, scope).href), ...prev.shellFetches().map(([u]) => u)]
      .map(u => [u, `old:${new URL(u).pathname}`]));
    const w = await install(scope, { edge, version: 'ignite26-abc123' });
    const asked = w.shellFetches(); // before the checks below fetch anything themselves
    // Preconditions: the edge really hands out the previous app.js at the address the app uses
    // and at the address the previous version fetched it from; each version has its own name.
    eq((await w.fetch('assets/js/app.js')).body, `old:${dir}assets/js/app.js`);
    eq((await w.fetch('assets/js/app.js?v=ignite26-old111')).body, `old:${dir}assets/js/app.js`);
    eq([prev.consts.SHELL_CACHE, w.consts.SHELL_CACHE], [`shell:${dir}:ignite26-old111`, `shell:${dir}:ignite26-abc123`]);
    eq([w.outcome, w.skipped()], ['installed', true]);
    const shell = w.store.get(w.consts.SHELL_CACHE);
    const expected = consts.SHELL.map(p => new URL(p, scope));
    // Saved under the plain address the page asks for; every copy is the new deploy's file,
    // keeps its headers, and has no address of its own (so the page never sees ?v=).
    eq([...shell.keys()].sort(), expected.map(u => u.href).sort());
    eq([...shell.values()].map(r => [r.body, r.url, r.headers['content-type']]).sort(),
      expected.map(u => [`new:${u.pathname}`, '', 'text/plain']).sort());
    // Each file was asked for once, at this version's own address, past the browser's cache too.
    eq(asked, expected.map(u => [`${u.href}?v=ignite26-abc123`, 'reload']).sort());
    eq(await w.serve(`${scope}?conf=ignite2026`, 'navigate'), `new:${dir}index.html`);
    eq(await w.serve(`${scope}assets/js/app.js`), `new:${dir}assets/js/app.js`);
  });
}

await test('should keep nothing of a new version that cannot fetch one of its app files', async () => {
  const { consts } = await install(MAIN);
  const old = `${consts.SHELL_PREFIX}old`;
  const w = await install(MAIN, { missing: 'assets/js/venue.js', existing: { [old]: { [`${MAIN}index.html`]: 'old page' } } });
  eq([...w.store.keys()].filter(k => k.startsWith(consts.SHELL_PREFIX)), [old]);
  eq(w.bodies(old), { [`${MAIN}index.html`]: 'old page' });
  eq([w.outcome, w.skipped()], ['refused: assets/js/venue.js: HTTP 404', false]);
  // Precondition: the other files were fetched; only the one 404 stopped the install.
  eq(w.shellFetches().length, consts.SHELL.length);
});

await test('should keep nothing of a new version when the phone runs out of space saving it', async () => {
  const { consts } = await install(MAIN);
  const old = `${consts.SHELL_PREFIX}old`;
  const w = await install(MAIN, { fullAt: 'assets/js/venue.js', existing: { [old]: { [`${MAIN}index.html`]: 'old page' } } });
  eq([...w.store.keys()].filter(k => k.startsWith(consts.SHELL_PREFIX)), [old]);
  eq(w.bodies(old), { [`${MAIN}index.html`]: 'old page' });
  eq([w.outcome, w.skipped()], ['refused: The quota has been exceeded.', false]);
  // Precondition: other files were saved before the disk filled up; the whole cache is then deleted.
  eq(w.shellPuts().includes(`${MAIN}assets/js/app.js`), true);
  eq(w.shellFetches().length, consts.SHELL.length);
});

await test('should keep the copy in use when an update with the same app files runs out of space', async () => {
  const { consts } = await install(MAIN);
  // This version's copy is already there (the worker in use made it); only sw.js changed.
  const w = await install(MAIN, { fullAt: 'assets/js/venue.js', existing: { [consts.SHELL_CACHE]: { [`${MAIN}assets/js/venue.js`]: 'venue in use' } } });
  eq([w.outcome, w.skipped()], ['refused: The quota has been exceeded.', false]);
  eq([...w.store.keys()].filter(k => k.startsWith(consts.SHELL_PREFIX)), [consts.SHELL_CACHE]);
  // Precondition: other files were saved before the disk filled up; they are taken out again.
  eq(w.shellPuts().includes(`${MAIN}assets/js/app.js`), true);
  eq(w.bodies(consts.SHELL_CACHE), { [`${MAIN}assets/js/venue.js`]: 'venue in use' });
  eq(await w.serve(`${MAIN}assets/js/venue.js`), 'venue in use');
});

// A copy in use made before this fix can hold files the CDN handed out stale (#77).
const shellOf = (consts, scope, body) => Object.fromEntries(consts.SHELL.map(p => [new URL(p, scope).href, body(new URL(p, scope))]));

await test('should save no app file again when the copy in use already holds them all', async () => {
  const { consts } = await install(MAIN);
  const current = shellOf(consts, MAIN, u => `new:${u.pathname}`);
  // Saving venue.js would fail, but the copy already holds it, so nothing needs saving.
  const w = await install(MAIN, { fullAt: 'assets/js/venue.js', existing: { [consts.SHELL_CACHE]: current } });
  eq([w.outcome, w.skipped(), w.shellPuts()], ['installed', true, []]);
  eq(w.bodies(consts.SHELL_CACHE), current);
});

await test('should replace only the stale files in the copy in use', async () => {
  const { consts } = await install(MAIN);
  const app = `${MAIN}assets/js/app.js`;
  // app.js was cut short (the start of the new file): equal bytes as far as they go isn't the same file.
  const current = { ...shellOf(consts, MAIN, u => `new:${u.pathname}`), [app]: 'new:/2026Ignite/assets/js/app' };
  const w = await install(MAIN, { fullAt: 'assets/js/venue.js', existing: { [consts.SHELL_CACHE]: current } });
  eq([w.outcome, w.skipped(), w.shellPuts()], ['installed', true, [app]]);
  eq(w.bodies(consts.SHELL_CACHE), { ...current, [app]: 'new:/2026Ignite/assets/js/app.js' });
  eq(await w.serve(app), 'new:/2026Ignite/assets/js/app.js');
});

await test('should put back the copy in use exactly as it was when repairing it runs out of space', async () => {
  const { consts } = await install(MAIN);
  const stale = shellOf(consts, MAIN, u => `old:${u.pathname}`);
  const w = await install(MAIN, { fullAt: 'assets/js/venue.js', existing: { [consts.SHELL_CACHE]: stale } });
  eq([w.outcome, w.skipped()], ['refused: The quota has been exceeded.', false]);
  // Precondition: app.js was replaced before the disk filled up at venue.js.
  eq(w.shellPuts().includes(`${MAIN}assets/js/app.js`), true);
  eq(w.bodies(consts.SHELL_CACHE), stale);
  eq(await w.serve(`${MAIN}assets/js/app.js`), 'old:/2026Ignite/assets/js/app.js');
});

await test('should put back every other file when one cannot be put back, and finish on the next try', async () => {
  const { consts } = await install(MAIN);
  const app = `${MAIN}assets/js/app.js`;
  const stale = shellOf(consts, MAIN, u => `old:${u.pathname}`);
  // app.js is replaced, venue.js can't be saved, and then putting app.js back fails as well.
  const w = await install(MAIN, { fullFrom: { 'assets/js/venue.js': 0, 'assets/js/app.js': 1 }, existing: { [consts.SHELL_CACHE]: stale } });
  eq([w.outcome, w.skipped()], ['refused: The quota has been exceeded.', false]);
  eq(w.bodies(consts.SHELL_CACHE), { ...stale, [app]: 'new:/2026Ignite/assets/js/app.js' });
  // With room again, the next try replaces exactly the files that still differ.
  const next = await install(MAIN, { existing: { [consts.SHELL_CACHE]: w.bodies(consts.SHELL_CACHE) } });
  eq([next.outcome, next.skipped(), next.shellPuts()], ['installed', true, Object.keys(stale).filter(u => u !== app)]);
  eq(next.bodies(consts.SHELL_CACHE), shellOf(consts, MAIN, u => `new:${u.pathname}`));
});

await test("should leave a colleague's copy to its own worker", () => {
  const { handlers } = worker(MAIN);
  let answered = false;
  handlers.fetch({ request: { method: 'GET', url: `${MAIN}gino/index.html`, mode: 'navigate' }, respondWith: () => { answered = true; } });
  eq(answered, false);
});

await test('should serve its own app page from the offline copy', async () => {
  const page = { body: 'the app page' };
  const { handlers } = worker(MAIN, [], page);
  let response;
  handlers.fetch({ request: { method: 'GET', url: `${MAIN}index.html`, mode: 'navigate' }, respondWith: p => { response = p; } });
  eq(await response, page);
});

// A telemetry call (assets/js/telemetry.js) always POSTs to a different origin than the app's
// own: the worker's very first guard (non-GET, or cross-origin) already skips it, so it is
// never cached, never served from cache, and never retried here (issue #140).
await test('should never intercept a telemetry call: not cached, not served stale, not retried', () => {
  const { handlers } = worker(MAIN);
  let intercepted = false;
  handlers.fetch({ request: { method: 'POST', url: 'https://api.honeycomb.io/1/batch/app-errors', mode: 'cors' }, respondWith: () => { intercepted = true; } });
  eq(intercepted, false);
});

// ---- opt-in app-error telemetry (assets/js/telemetry.js, issue #140)
// A tiny stand-in for the two <meta> tags telemetry.js reads; no other module under test here
// touches `document`, so this is safe to define only for these tests.
const metaValues = {};
globalThis.document = { querySelector: sel => {
  const name = /meta\[name="([^"]+)"\]/.exec(sel)?.[1];
  return name in metaValues ? { content: metaValues[name] } : null;
} };
const { buildEvent, browserFamily, reportError } = await import('../assets/js/telemetry.js');
const APP_ERROR_FIELDS = ['event_type', 'app_version', 'conference', 'browser_family', 'error_name', 'at'].sort();

await test('should classify a Chrome user agent', () => {
  eq(browserFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'), 'Chrome');
});
await test('should classify a Safari user agent (also "Safari/" in a Chrome string, so order matters)', () => {
  eq(browserFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), 'Safari');
});
await test('should classify an unrecognised user agent as Other', () => {
  eq(browserFamily('SomeBot/1.0'), 'Other');
});

await test('should build an app-error event with only the allow-listed fields', () => {
  metaValues['app-version'] = 'ignite26-abc123';
  const event = buildEvent('uncaught-exception', { conference: 'ignite2026', errorName: 'TypeError', now: Date.UTC(2026, 10, 17, 8), ua: 'Chrome/120' });
  eq(Object.keys(event).sort(), APP_ERROR_FIELDS);
  eq([event.event_type, event.app_version, event.conference, event.browser_family, event.error_name],
     ['uncaught-exception', 'ignite26-abc123', 'ignite2026', 'Chrome', 'TypeError']);
  eq(event.at, new Date(Date.UTC(2026, 10, 17, 8)).toISOString());
  delete metaValues['app-version'];
});
await test('should default the app version to "dev" when no version is stamped on the page', () => {
  eq(buildEvent('startup-failure', {}).app_version, 'dev');
});
await test('should never carry anything outside the app-error allow list, however it is called', () => {
  // No helper here accepts extra fields at all (CLAUDE.md test rule 11): buildEvent's own
  // object literal is the allow list, so this asserts the actual shape it produces.
  const event = buildEvent('save-error', { conference: 'ignite2026', errorName: 'QuotaExceededError' });
  eq(Object.keys(event).every(k => APP_ERROR_FIELDS.includes(k)), true);
  eq('message' in event || 'note' in event || 'picks' in event || 'userAgent' in event, false);
});

function withFetch(fn, impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return fn(); } finally { globalThis.fetch = real; }
}

await test('should send nothing when telemetry is off, even with a key stamped on the page', () => {
  metaValues['honeycomb-browser-key'] = 'hcaik_test';
  let called = false;
  const sent = withFetch(() => reportError('uncaught-exception', { enabled: false, conference: 'ignite2026' }), () => { called = true; return Promise.resolve(); });
  delete metaValues['honeycomb-browser-key'];
  eq([sent, called], [false, false]);
});
await test('should send nothing when no key is stamped on the page, even when telemetry is on', () => {
  let called = false;
  const sent = withFetch(() => reportError('uncaught-exception', { enabled: true, conference: 'ignite2026' }), () => { called = true; return Promise.resolve(); });
  eq([sent, called], [false, false]);
});
await test('should send exactly the allow-listed event once telemetry is on and a key is stamped', () => {
  metaValues['honeycomb-browser-key'] = 'hcaik_test';
  metaValues['app-version'] = 'ignite26-abc123';
  let seen = null;
  const sent = withFetch(
    () => reportError('save-error', { enabled: true, conference: 'ignite2026', errorName: 'QuotaExceededError' }),
    (url, opts) => { seen = { url, headers: opts.headers, body: JSON.parse(opts.body) }; return Promise.resolve(); });
  delete metaValues['honeycomb-browser-key'];
  delete metaValues['app-version'];
  eq(sent, true);
  eq(seen.url, 'https://api.honeycomb.io/1/batch/app-errors');
  eq(seen.headers['X-Honeycomb-Team'], 'hcaik_test');
  eq(Object.keys(seen.body[0].data).sort(), APP_ERROR_FIELDS);
  eq([seen.body[0].data.event_type, seen.body[0].data.conference, seen.body[0].data.error_name],
     ['save-error', 'ignite2026', 'QuotaExceededError']);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
