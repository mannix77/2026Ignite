// Regression tests for the robustness audit: bad data, storage failures, cache keys and the
// cost of comparing options in a large clash.  Run with: node tests/robustness.test.js
import { sleep } from './shim.js';

const store = await import('../assets/js/store.js');
const { buildModel, diffKnown, cacheUrl } = await import('../assets/js/data.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');
const { createVenue } = await import('../assets/js/venue.js');
const { compareOptions, DEFAULT_PLANNER } = await import('../assets/js/planner.js');

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
await test('should report alerts when a snapshot entry is malformed', () => {
  eq(diffKnown({ byGroup: new Map() }, new Set(), { x: null }).alerts, []);
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

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
