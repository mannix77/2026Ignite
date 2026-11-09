// Saved user data: picks, backups and resets must never lose a user's plan.
// Run with: node tests/store.test.js
// Each test uses its own storage namespace and waits out the 150 ms save delay, so one
// test's pending save can't land in the next test's storage.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sleep } from './shim.js';

// The page events the store listens to (pagehide, visibilitychange), captured so tests can fire them.
const pageEvents = {};
globalThis.window = { addEventListener: (type, fn) => { (pageEvents[type] ||= []).push(fn); } };
globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener: (type, fn) => { (pageEvents[type] ||= []).push(fn); } };
const fire = type => { for (const fn of pageEvents[type] || []) fn({}); };
const store = await import('../assets/js/store.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}`);
}
const SAVE = 200; // longer than the store's save delay

// ---- picks survive a reload
await test('should keep a rating, lock and note after a reload', async () => {
  store.load('reload-pick');
  store.mutatePicks(p => { p.S1 = { p: 3, lock: 'S1', note: 'ask about pricing', at: 1 }; });
  await sleep(SAVE);
  store.load('reload-pick');
  const s = store.pick('S1');
  eq([s?.p, s?.lock, s?.note], [3, 'S1', 'ask about pricing']);
});

await test('should keep a reserved seat, own score and watch choice after a reload', async () => {
  store.load('reload-extras');
  store.mutatePicks(p => { p.S2 = { p: 2, lock: null, reserved: 'S2', score: 72.5, mode: 'watch', note: '', at: 1 }; });
  await sleep(SAVE);
  store.load('reload-extras');
  const s = store.pick('S2');
  eq([s?.reserved, s?.score, s?.mode], ['S2', 72.5, 'watch']);
});

await test('should drop a saved pick with no rating, lock, seat or note on reload', async () => {
  localStorage.setItem('ignite26.planner.v1:reload-junk', JSON.stringify({ v: 1, picks: { S3: { p: 'Must', at: 1 } } }));
  store.load('reload-junk');
  eq(store.pick('S3'), null);
});

// ---- saved state from earlier versions of the planner
function loadSaved(ns, saved) {
  localStorage.setItem(`ignite26.planner.v1:${ns}`, JSON.stringify(saved));
  return store.load(ns);
}

await test('should not carry forward the pre-release block that stored every default setting', () => {
  const state = loadSaved('old-settings', { v: 1, picks: {}, settings: { buffer: 99 } });
  eq(['settings' in state, store.settings().buffer], [false, store.DEFAULT_SETTINGS.buffer]);
});

await test('should drop a saved simulated clock', () => {
  eq(loadSaved('old-simnow', { v: 1, picks: {}, prefs: { simNow: 123, buffer: 7 } }).prefs, { buffer: 7 });
});

await test('should drop change tracking saved before it was keyed by run', () => {
  eq(loadSaved('old-known', { v: 1, picks: {}, known: { S1: { g: 'G', code: 'BRK1' } } }).known, {});
});

await test('should drop change tracking whose run id is blank or not its own', () => {
  const kept = { inst: 'S3', g: 'G', code: 'BRK3' };
  eq(loadSaved('bad-known', { v: 1, picks: {}, known: { S1: { inst: '', g: 'G' }, S2: { inst: 'S9', g: 'G' }, S3: kept } }).known, { S3: kept });
});

await test('should keep the rest of the change tracking when one entry has no run id', () => {
  const kept = { inst: 'S2', g: 'G', code: 'BRK2' };
  eq(loadSaved('mixed-known', { v: 1, picks: {}, known: { S1: { g: 'G', code: 'BRK1' }, S2: kept } }).known, { S2: kept });
});

// ---- saved state that is damaged must not lock the user out or vanish
await test('should start normally when the saved display settings are null', () => {
  eq(loadSaved('ui-null', { v: 1, picks: {}, ui: null }).ui.tab, 'browse');
});

await test('should keep a copy of saved data it cannot read', () => {
  localStorage.setItem('ignite26.planner.v1:corrupt-json', '{"v":1,"picks":{"S1":');
  store.load('corrupt-json');
  eq([localStorage.getItem('ignite26.planner.v1:corrupt-json#unreadable'), store.get().picks], ['{"v":1,"picks":{"S1":', {}]);
});

// ---- a change is saved even when you leave straight away (specs/features/saving.feature)
const saved = ns => JSON.parse(localStorage.getItem(`ignite26.planner.v1:${ns}`) || '{"picks":{}}').picks;

await test('should save the change just made when the page is left', () => {
  store.load('leave-pagehide');
  store.mutatePicks(p => { p.S1 = { p: 3, lock: null, note: '', at: 1 }; });
  fire('pagehide');
  eq(saved('leave-pagehide').S1?.p, 3);
});

await test('should save the change just made when the page is hidden', () => {
  store.load('leave-hidden');
  store.setGroupNote(['S1'], 'S1', 'bring the laptop');
  document.visibilityState = 'hidden';
  fire('visibilitychange');
  document.visibilityState = 'visible';
  eq(saved('leave-hidden').S1?.note, 'bring the laptop');
});

await test('should not save early when the page is only shown again', () => {
  store.load('leave-visible');
  store.mutatePicks(p => { p.S1 = { p: 3, lock: null, note: '', at: 1 }; });
  fire('visibilitychange');
  eq(saved('leave-visible'), {});
});
await sleep(SAVE);

// ---- restoring a backup (specs/features/backups.feature)
const BACKUP = 'ignite26-planner';
const ratedPlan = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`S${i}`, { p: 2, lock: null, note: '', at: 1 }]));
function throws(fn) {
  try { fn(); } catch (e) { return e.message; }
  throw new Error('expected an error, but none was thrown');
}

await test('should refuse a Replace backup whose ratings cannot be read', async () => {
  store.load('restore-unreadable');
  store.mutatePicks(p => Object.assign(p, ratedPlan(12)));
  const msg = throws(() => store.importData({ app: BACKUP, picks: { S9: { p: 'Must' } } }, { replace: true }));
  eq(/no picks/i.test(msg), true);
});

await test('should keep every current pick when a Replace backup is refused', async () => {
  store.load('restore-unreadable-kept');
  store.mutatePicks(p => Object.assign(p, ratedPlan(12)));
  try { store.importData({ app: BACKUP, picks: { S9: { p: 'Must' } } }, { replace: true }); } catch { /* refused */ }
  eq(Object.keys(store.get().picks).length, 12);
});

await test('should replace the plan with a readable backup', async () => {
  store.load('restore-readable');
  store.mutatePicks(p => Object.assign(p, ratedPlan(12)));
  store.importData({ app: BACKUP, picks: { A: { p: 3, at: 2 }, B: { p: 1, at: 2 }, C: { p: 0, at: 2 } } }, { replace: true });
  eq(Object.keys(store.get().picks).sort(), ['A', 'B', 'C']);
});
const MORNING = Date.now() - 3 * 3600e3; // earlier today: older than "now", newer than any undated pick
await test('should keep a newer local pick when a backup pick has no time', async () => {
  store.load('merge-undated');
  store.mutatePicks(p => { p.ICE = { p: 3, lock: 'ICE', note: '', at: MORNING }; });
  store.importData({ app: BACKUP, picks: { ICE: { p: 0 } } });
  const s = store.pick('ICE');
  eq([s.p, s.lock], [3, 'ICE']);
});

await test('should take a backup pick made after the local one', async () => {
  store.load('merge-newer');
  store.mutatePicks(p => { p.ICE = { p: 3, lock: null, note: '', at: MORNING }; });
  store.importData({ app: BACKUP, picks: { ICE: { p: 0, at: MORNING + 3600e3 } } });
  eq(store.pick('ICE').p, 0);
});

await test('should keep an undated local pick when a second undated backup is merged', async () => {
  store.load('merge-undated-twice');
  store.importData({ app: BACKUP, picks: { ICE: { p: 3, lock: 'ICE' } } });
  store.importData({ app: BACKUP, picks: { ICE: { p: 0 } } });
  eq(store.pick('ICE').p, 3);
});

await test('should add an undated backup pick for a session not in the plan', async () => {
  store.load('merge-undated-new');
  store.importData({ app: BACKUP, picks: { ICE: { p: 2 } } });
  eq(store.pick('ICE')?.p, 2);
});
await sleep(SAVE);

const damaged = '{"v":1,"picks":{"S1":' + 'x'.repeat(5000); // unreadable, and too big to copy under the quota below
await test('should not overwrite unreadable data it could not copy', async () => {
  localStorage.setItem('ignite26.planner.v1:uncopyable', damaged);
  globalThis.__quota = 2000;
  store.load('uncopyable');
  store.mutatePicks(p => { p.S1 = { p: 3, lock: null, note: '', at: 1 }; });
  await sleep(SAVE);
  globalThis.__quota = null;
  eq(localStorage.getItem('ignite26.planner.v1:uncopyable'), damaged);
});

await test('should copy unreadable data first, then save, once storage allows it', async () => {
  localStorage.setItem('ignite26.planner.v1:copy-later', damaged);
  globalThis.__quota = 2000;
  store.load('copy-later');
  globalThis.__quota = null;
  store.mutatePicks(p => { p.S1 = { p: 3, lock: null, note: '', at: 1 }; });
  await sleep(SAVE);
  eq([localStorage.getItem('ignite26.planner.v1:copy-later#unreadable') === damaged, store.get().picks.S1?.p,
    JSON.parse(localStorage.getItem('ignite26.planner.v1:copy-later')).picks.S1?.p], [true, 3, 3]);
});

await test('should restore "preferences never set" when replacing from such a backup', () => {
  store.load('profile-replace-null');
  store.updateProfile({ roles: ['architect'] });
  store.importData({ app: BACKUP, picks: {}, profile: null }, { replace: true });
  eq(store.get().profile, null);
});

await test('should refuse a backup whose picks are a list', () => {
  store.load('restore-list');
  eq(/backup/i.test(throws(() => store.importData({ app: BACKUP, picks: [{ p: 3 }, { p: 2 }] }))), true);
});

await test('should report how many picks a merge actually applied', () => {
  store.load('restore-count');
  store.mutatePicks(p => { p.A = { p: 3, lock: null, note: '', at: Date.now() }; });
  eq(store.importData({ app: BACKUP, picks: { A: { p: 1, at: 1 }, B: { p: 2, at: 1 } } }), 1); // A is newer here
});

await test('should leave preferences unset on a fresh device restored from a backup that never set them', () => {
  store.load('profile-unset-from');
  const backup = store.exportData();
  store.load('profile-unset-to');
  store.importData(backup, { replace: true });
  eq(store.seedProfile({ profile: { roles: ['architect'] } }), true);
});
await sleep(SAVE);

// ---- "Erase all your ratings, locks and notes … Settings are kept." (app.js reset-all)
async function planWithSettings(ns) {
  store.load(ns);
  store.mutatePicks(p => { p.S1 = { p: 3, lock: 'S1', note: 'bring laptop', at: 1 }; });
  store.setSetting('custom', [{ id: 'c1', title: 'Partner dinner', day: '2026-10-20', start: 1140, end: 1260, building: 'D' }]);
  store.setSetting('blocks', [{ id: 'b1', day: '2026-10-20', start: 600, end: 660, label: 'Booth duty' }]);
  store.updateSettings({ buffer: 7, lunch: { on: false } });
  store.updateProfile({ roles: ['architect'] });
  store.resetAll();
  await sleep(SAVE);
  store.load(ns);
}

await test('should erase every pick when the plan is reset', async () => {
  await planWithSettings('reset-picks');
  eq(store.get().picks, {});
});

await test('should keep settings, added sessions and blocked time when the plan is reset', async () => {
  await planWithSettings('reset-settings-kept');
  const s = store.settings();
  eq([s.buffer, s.lunch.on, s.custom.length, s.blocks.length], [7, false, 1, 1]);
});

await test('should keep quick-start preferences when the plan is reset', async () => {
  await planWithSettings('reset-profile-kept');
  eq(store.profile().roles, ['architect']);
});

// ---- settings keep the value you see (specs/features/settings.feature)
async function setThenReopen(ns, patch) {
  store.load(ns);
  store.updateSettings(patch);
  const seen = store.settings();
  await sleep(SAVE);
  store.load(ns);
  return [seen, store.settings()];
}

await test('should hold a buffer above the maximum at the maximum, before and after a reload', async () => {
  const [seen, reopened] = await setThenReopen('settings-buffer-high', { buffer: 300 });
  eq([seen.buffer, reopened.buffer], [240, 240]);
});

await test('should keep a buffer inside the range as entered', async () => {
  const [seen, reopened] = await setThenReopen('settings-buffer-ok', { buffer: 7 });
  eq([seen.buffer, reopened.buffer], [7, 7]);
});

await test('should hold a weight above the maximum at the maximum, before and after a reload', async () => {
  const [seen, reopened] = await setThenReopen('settings-weight-high', { weights: { 3: 9000 } }); // a Must's weight
  eq([seen.weights[3], reopened.weights[3]], [5000, 5000]);
});

await test('should still drop blocked time outside the day', async () => {
  store.load('settings-block-bad');
  store.setSetting('blocks', [{ id: 'b1', day: '2026-10-20', start: 1500, end: 1600, label: 'Late' }]);
  eq(store.settings().blocks, []);
});

// ---- share links: "Ratings and locks for sessions you've already rated will be replaced;
// notes and reserved seats are kept." (app.js importShare)
const same = x => x; // these tests use session codes as ids and run keys
function share(picks) {
  store.load('share-from');
  store.mutatePicks(p => Object.assign(p, picks));
  return store.shareString(same, same);
}
function receive(link, local = {}) {
  store.load('share-to');
  store.mutatePicks(p => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, local); });
  store.applyShared(store.parseShare(link, same, same));
  return store.get().picks;
}

await test('should carry ratings, scores, watch choices and locks through a share link', async () => {
  const got = receive(share({
    BRK1: { p: 3, lock: 'BRK1', note: '', at: 1 },
    BRK2: { p: 2, score: 72.5, mode: 'watch', lock: null, note: '', at: 1 },
    BRK3: { p: 1, lock: 'BRK3-R1', lockMode: 'preview', note: '', at: 1 },
  }));
  eq([got.BRK1.p, got.BRK1.lock, got.BRK2.score, got.BRK2.mode, got.BRK3.lock, got.BRK3.lockMode],
    [3, 'BRK1', 72.5, 'watch', 'BRK3-R1', 'preview']);
});

await test('should keep my note when a share link rates the same session', async () => {
  const got = receive('BRK1.3', { BRK1: { p: 1, lock: null, note: 'ask about pricing', at: 1 } });
  eq([got.BRK1.p, got.BRK1.note], [3, 'ask about pricing']);
});

await test('should keep my reserved seat when a share link locks another run', async () => {
  const got = receive('BRK1.3!BRK1-R1', { BRK1: { p: 2, lock: 'BRK1', reserved: 'BRK1', note: '', at: 1 } });
  eq([got.BRK1.reserved, got.BRK1.lock], ['BRK1', 'BRK1']);
});

await test('should replace my rating and score when a share link rates the same session', async () => {
  const got = receive('BRK1.0s10', { BRK1: { p: 3, score: 95, lock: null, note: '', at: 1 } });
  eq([got.BRK1.p, got.BRK1.score], [0, 10]);
});

await test('should ignore share-link tokens it cannot read', async () => {
  eq(Object.keys(store.parseShare('BRK1.3~BRK2.9~not a token~~BRK3.2x', same, same)), ['BRK1']);
});

// ---- llms.txt, the guide for AI assistants (specs/features/ai-assistant-guide.feature).
// Its examples are what assistants copy, so each must import exactly what the guide says.
const guide = readFileSync(fileURLToPath(new URL('../llms.txt', import.meta.url)), 'utf8');
const importLinks = [...guide.matchAll(/https:\/\/\S+?#\/import\/([^\s`<>)]+)/g)].map(m => m[0]);
const tokensOf = link => decodeURIComponent(link.split('#/import/')[1]);
// The `TOKEN` bullets under a "### heading" of the guide.
function documentedTokens(heading) {
  const lines = guide.split('\n');
  const at = lines.indexOf(`### ${heading}`);
  if (at < 0) throw new Error(`llms.txt has no "### ${heading}" section`);
  const end = lines.findIndex((l, i) => i > at && l.startsWith('#'));
  return lines.slice(at + 1, end < 0 ? undefined : end).map(l => /^- `([^`]+)`/.exec(l)?.[1]).filter(Boolean);
}
const summary = picks => Object.fromEntries(Object.entries(picks).map(([id, v]) => [id, [v.p, v.score ?? null, v.mode ?? null, v.lock]]));

await test("should import the guide's worked example as the guide describes it", async () => {
  const example = importLinks.find(l => l.includes('?conf=reinvent2026#/import/AIM314-R.'));
  eq(summary(receive(tokensOf(example))), {
    'AIM314-R': [3, null, null, 'AIM314-R1'],   // Must, the AIM314-R1 run locked
    'AIM326-R': [2, 87.5, null, null],          // Want, own score 87.5
    'BIZ333-R': [1, null, 'watch', null],        // Maybe, watch the recording later
    'CMP323-R': [0, null, null, null],           // Skip
  });
});

await test('should read every token of every import link in the guide', async () => {
  const counts = importLinks.map(l => [tokensOf(l).split('~').length, Object.keys(store.parseShare(tokensOf(l), same, same)).length]);
  eq([counts.length > 0, counts.filter(([a, b]) => a !== b)], [true, []]);
});

await test('should import each token the guide lists as accepted the way the guide says', async () => {
  const expected = {   // [rating, own score, watch, locked run], from the guide's own words
    'BRK201.3': [3, null, null, null],
    'BRK201.0': [0, null, null, null],
    'BRK201.2s0': [2, 0, null, null],
    'BRK201.2s100': [2, 100, null, null],
    'BRK201.2s100.5': [2, null, null, null],
    'BRK201.1w': [1, null, 'watch', null],
    'BRK201.3s92.5w!BRK201': [3, 92.5, 'watch', 'BRK201'],
    'BRK201.2*BRK201': [2, null, null, 'BRK201'],   // a preview choice: lockMode preview, checked below
  };
  const documented = documentedTokens('Accepted tokens');
  const got = Object.fromEntries(documented.map(t => [t, summary(receive(t)).BRK201]));
  eq(got, expected);
  const lockOf = t => { const r = receive(t).BRK201; return [r.lock, r.lockMode ?? null]; };
  eq([lockOf('BRK201.2*BRK201'), lockOf('BRK201.2!BRK201')], [['BRK201', 'preview'], ['BRK201', null]], 'both lock the run; only *RUN marks it a preview choice');
});

await test('should ignore each token the guide lists as ignored, and still import the rest of the link', async () => {
  const documented = documentedTokens('Ignored tokens');
  // Both what the import dialog counts (parseShare) and what is saved (applyShared).
  const counted = documented.map(t => Object.keys(store.parseShare(`BRK202.3~${t}`, same, same)));
  eq([documented, counted, documented.map(t => Object.keys(receive(`BRK202.3~${t}`)))], [
    ['BRK201.4', 'BRK201.3s92.55', 'BRK201.3s1000', 'BRK201.Must', 'BRK201', 'BRK201.3 w'],
    [['BRK202'], ['BRK202'], ['BRK202'], ['BRK202'], ['BRK202'], ['BRK202']],
    [['BRK202'], ['BRK202'], ['BRK202'], ['BRK202'], ['BRK202'], ['BRK202']],
  ]);
  // The valid token still imports as a Must (3), both in the dialog's count and in what is saved.
  eq(documented.map(t => store.parseShare(`BRK202.3~${t}`, same, same).BRK202?.p), [3, 3, 3, 3, 3, 3]);
  eq(documented.map(t => receive(`BRK202.3~${t}`).BRK202?.p), [3, 3, 3, 3, 3, 3]);
});
await sleep(SAVE);

// ---- an older tab never saves over newer data (specs/features/saving.feature)
const KEY_OF = ns => `ignite26.planner.v1:${ns}`;
const seedRaw = (ns, saved) => { const raw = JSON.stringify(saved); localStorage.setItem(KEY_OF(ns), raw); return raw; };
const NEWER = { v: 2, picks: { N1: { p: 3, lock: null, note: 'kept', at: 5, futureField: 'x' } }, futureTop: { a: 1 } };

await test('should write nothing over saved data from a newer version, and ask for a reload', async () => {
  const raw = seedRaw('newer-a', NEWER);
  const seen = [];
  const off = store.subscribe(what => seen.push(what));
  store.load('newer-a');
  eq(store.newerVersion(), true);
  store.mutatePicks(p => { p.N2 = { p: 2, lock: null, note: '', at: 6 }; });
  await sleep(SAVE);
  fire('pagehide'); // leaving the page flushes a pending save too
  off();
  eq(localStorage.getItem(KEY_OF('newer-a')) === raw, true); // byte for byte, unknown fields included
  eq(seen.includes('newer-version'), true);
});

await test('should save as usual when the saved version is the one this code knows, or has none', async () => {
  for (const [ns, saved] of [['known-v1', { v: 1, picks: {} }], ['known-none', { picks: {} }]]) {
    seedRaw(ns, saved);
    store.load(ns);
    eq(store.newerVersion(), false);
    store.mutatePicks(p => { p.K1 = { p: 3, lock: null, note: '', at: 1 }; });
    await sleep(SAVE);
    eq(JSON.parse(localStorage.getItem(KEY_OF(ns))).picks.K1?.p, 3);
  }
});

await test('should refuse only a version newer than this code knows (v 2 refused, v 1 and a non-number saved)', async () => {
  for (const [ns, v, refused] of [['thr-1', 1, false], ['thr-2', 2, true], ['thr-text', '2', false]]) {
    const raw = seedRaw(ns, { v, picks: {} });
    store.load(ns);
    store.mutatePicks(p => { p.T1 = { p: 1, lock: null, note: '', at: 1 }; });
    await sleep(SAVE);
    eq([ns, store.newerVersion(), localStorage.getItem(KEY_OF(ns)) === raw], [ns, refused, refused]);
  }
});

await test('should stop saving when another tab saves a newer version while this tab has a pending edit', async () => {
  seedRaw('newer-live', { v: 1, picks: {} });
  store.load('newer-live');
  store.mutatePicks(p => { p.L1 = { p: 3, lock: null, note: '', at: 1 }; }); // pending: not yet written
  const raw = seedRaw('newer-live', NEWER);                                      // the other tab's save
  for (const fn of pageEvents.storage || []) fn({ key: KEY_OF('newer-live'), newValue: raw });
  eq(store.newerVersion(), true);
  store.mutatePicks(p => { p.L2 = { p: 2, lock: null, note: '', at: 2 }; });
  await sleep(SAVE);
  eq(localStorage.getItem(KEY_OF('newer-live')) === raw, true);
});

await test('should refuse to save over a newer version written by another tab before its storage event arrives', async () => {
  seedRaw('newer-silent', { v: 1, picks: {} });
  store.load('newer-silent');
  const raw = seedRaw('newer-silent', NEWER);   // the other tab's save; no storage event is fired here
  eq(store.newerVersion(), false);              // this tab doesn't know yet
  store.mutatePicks(p => { p.Q1 = { p: 2, lock: null, note: '', at: 1 }; });
  await sleep(SAVE);
  eq([store.newerVersion(), localStorage.getItem(KEY_OF('newer-silent')) === raw], [true, true]);
});

await test('should save again once the page is loaded with a conference whose data it understands', async () => {
  seedRaw('newer-then-ok', NEWER);
  store.load('newer-then-ok');
  eq(store.newerVersion(), true);
  store.load('nothing-saved-yet'); // no saved text at all: the flag must not carry over
  eq(store.newerVersion(), false);
  store.mutatePicks(p => { p.E1 = { p: 1, lock: null, note: '', at: 1 }; });
  await sleep(SAVE);
  eq(JSON.parse(localStorage.getItem(KEY_OF('nothing-saved-yet'))).picks.E1?.p, 1);
  seedRaw('newer-again', NEWER);
  store.load('newer-again');
  seedRaw('ok-after', { v: 1, picks: {} });
  store.load('ok-after');
  eq(store.newerVersion(), false);
  store.mutatePicks(p => { p.A1 = { p: 2, lock: null, note: '', at: 1 }; });
  await sleep(SAVE);
  eq(JSON.parse(localStorage.getItem(KEY_OF('ok-after'))).picks.A1?.p, 2);
});

// ---- previewing a backup or link before it is applied (specs/features/restoring-picks.feature)
const backupOf = picks => ({ app: 'ignite26-planner', v: 1, conference: 'gartner2026', picks });
const seed = (ns, picks) => { store.load(ns); store.mutatePicks(p => Object.assign(p, picks)); };

await test('should list changed and new picks in a backup without applying them', async () => {
  seed('pv-list', { A: { p: 2, lock: null, note: '', at: 10 } });
  const pv = store.previewImport(backupOf({ A: { p: 3, at: 20 }, B: { p: 2, at: 20 }, C: { p: 1, at: 20 } }), { replace: false });
  eq([pv.changed, pv.added, pv.unchanged, pv.removed], [[{ id: 'A', from: 2, to: 3 }], ['B', 'C'], 0, []]);
  await sleep(SAVE);
});
await test('should leave picks untouched while previewing a backup', async () => {
  seed('pv-untouched', { A: { p: 2, lock: null, note: '', at: 10 } });
  store.previewImport(backupOf({ A: { p: 3, at: 20 }, B: { p: 2, at: 20 } }), { replace: true });
  eq([store.pick('A')?.p, store.pick('B')], [2, null]);
  await sleep(SAVE);
});
await test('should apply exactly the previewed changes when adding a backup', async () => {
  seed('pv-exact', { A: { p: 2, lock: null, note: '', at: 10 }, D: { p: 1, lock: null, note: '', at: 10 }, E: { p: 3, lock: null, note: '', at: 50 } });
  const backup = backupOf({ A: { p: 3, at: 20 }, B: { p: 2, at: 20 }, D: { p: 1, at: 20 }, E: { p: 0, at: 30 } });
  const pv = store.previewImport(backup, { replace: false });
  store.importData(backup, { replace: false });
  // A changed, B new, D same rating, E's local rating is newer and stays.
  eq([pv.changed.map(c => c.id), pv.added, pv.removed, pv.unchanged, ['A', 'B', 'D', 'E'].map(id => store.pick(id)?.p)], [['A'], ['B'], [], 2, [3, 2, 1, 3]]);
  await sleep(SAVE);
});
await test('should list the picks a replace would remove', async () => {
  seed('pv-remove', { A: { p: 2, lock: null, note: '', at: 10 }, Z: { p: 3, lock: null, note: '', at: 10 } });
  const pv = store.previewImport(backupOf({ A: { p: 2, at: 20 } }), { replace: true });
  eq([pv.removed, pv.unchanged, pv.added, pv.changed], [['Z'], 1, [], []]);
  await sleep(SAVE);
});
await test('should keep a note and reserved seat when adding a backup that rates the same session', async () => {
  seed('pv-keep', { A: { p: 2, lock: 'A', reserved: 'A', note: 'bring laptop', at: 10 } });
  store.importData(backupOf({ A: { p: 3, at: 20 } }), { replace: false });
  const a = store.pick('A');
  eq([a?.p, a?.note, a?.reserved], [3, 'bring laptop', 'A']);
  await sleep(SAVE);
});
await test('should preview a picks link without applying it', async () => {
  seed('pv-link', { A: { p: 1, lock: null, note: 'x', at: 10 } });
  const link = { A: { p: 3, code: 'K1', at: 20 }, B: { p: 2, code: 'K2', at: 20 }, C: { p: 0, code: 'K3', at: 20 } };
  const pv = store.previewShared(link);
  eq([pv.changed, pv.added, store.pick('A')?.p, store.pick('B')], [[{ id: 'A', from: 1, to: 3 }], ['B', 'C'], 1, null]);
  await sleep(SAVE);
});
await test('should count only the link\'s own sessions as already the same', async () => {
  seed('pv-scope', { A: { p: 2, lock: null, note: '', at: 10 }, X: { p: 1, lock: null, note: '', at: 10 }, Y: { p: 3, lock: null, note: '', at: 10 } });
  const pv = store.previewShared({ A: { p: 2, code: 'K1', at: 20 }, B: { p: 3, code: 'K2', at: 20 } });
  eq([pv.unchanged, pv.added, pv.changed], [1, ['B'], []]);
  await sleep(SAVE);
});
await test('should report link entries whose session code is not in the catalog', () => {
  const report = {};
  const picks = store.parseShare('K1.3~CX88.0~not-a-token', code => ({ K1: 'S1' })[code] || null, () => null, report);
  eq([Object.keys(picks), report.unknown, report.invalid], [['S1'], ['CX88'], 1]);
});
await test('should apply exactly the previewed changes from a picks link', async () => {
  seed('pv-link-exact', { A: { p: 1, lock: null, note: 'x', at: 10 }, B: { p: 2, lock: null, note: '', at: 10 } });
  const link = { A: { p: 3, code: 'K1', at: 20 }, B: { p: 2, code: 'K2', at: 20 } };
  const pv = store.previewShared(link);
  store.applyShared(link);
  eq([pv.changed.map(c => c.id), pv.added, pv.unchanged, store.pick('A')?.p, store.pick('A')?.note, store.pick('B')?.p], [['A'], [], 1, 3, 'x', 2]);
  await sleep(SAVE);
});

// ---- one backup file for every conference on this device (specs/features/one-backup-for-all.feature)
// Conferences are {id, namespace}: the live one is the store's current namespace; the others are
// read from and written to their own saved state without switching what the app shows.
const CONFS = [{ id: 'ignite2026', namespace: 'all-live' }, { id: 'gartner2026', namespace: 'all-other' }, { id: 'reinvent2026', namespace: 'all-untouched' }];
const savedOf = ns => JSON.parse(localStorage.getItem(`ignite26.planner.v1:${ns}`) || 'null');

await test('should back up every conference with picks or settings, and leave an untouched one out', async () => {
  localStorage.removeItem('ignite26.planner.v1:all-untouched');
  localStorage.setItem('ignite26.planner.v1:all-other', JSON.stringify({ v: 1, picks: { G1: { p: 2, lock: null, note: 'gartner note', at: 5 } }, prefs: {}, profile: null }));
  store.load('all-live');
  store.mutatePicks(p => { p.S1 = { p: 3, lock: 'S1', note: '', at: 7 }; });
  store.updateSettings({ buffer: 4 });
  const doc = store.exportAll(CONFS, new Date('2026-11-09T05:00:00Z'));
  eq([doc.app, doc.v, doc.kind, doc.exportedAt, doc.instance, Object.keys(doc.conferences).sort()],
    ['ignite26-planner', 1, 'all', '2026-11-09T05:00:00.000Z', '', ['gartner2026', 'ignite2026']]);
  eq([doc.conferences.ignite2026.picks.S1.p, doc.conferences.ignite2026.settings.buffer, doc.conferences.gartner2026.picks.G1.note], [3, 4, 'gartner note']);
  eq(store.isAllBackup(doc), true);
  eq(store.isAllBackup({ app: BACKUP, picks: {} }), false, 'an old single-conference file is not one');
});

await test('should restore every conference into its own place on a fresh device', async () => {
  localStorage.removeItem('ignite26.planner.v1:all-other');
  store.load('all-live');
  const doc = { app: BACKUP, v: 1, kind: 'all', exportedAt: 'x', conferences: {
    ignite2026: { picks: { S1: { p: 3, at: 2 } }, settings: { buffer: 6 }, profile: null },
    gartner2026: { picks: { G1: { p: 2, at: 2 }, G2: { p: 1, at: 2 } }, settings: {}, profile: null } } };
  const pv = store.previewImportAll(doc, CONFS, { replace: false });
  eq([pv.parts.ignite2026.added, pv.parts.gartner2026.added.sort(), pv.missing], [['S1'], ['G1', 'G2'], []]);
  const applied = store.importAllData(doc, CONFS, { replace: true });
  eq(applied, { ignite2026: 1, gartner2026: 2 });
  eq([store.pick('S1')?.p, store.settings().buffer, store.namespace()], [3, 6, 'all-live'], 'the live conference changed in place');
  store.load('all-other');
  eq([store.pick('G1')?.p, store.pick('G2')?.p], [2, 1], 'the other conference was written to its own saved state');
});

await test('should keep a newer rating in another conference when adding a backup', async () => {
  localStorage.setItem('ignite26.planner.v1:all-other', JSON.stringify({ v: 1, picks: { G1: { p: 2, lock: null, note: 'mine', at: MORNING }, G3: { p: 1, lock: null, note: '', at: MORNING } }, prefs: {}, profile: null }));
  store.load('all-live');
  const doc = { app: BACKUP, v: 1, kind: 'all', conferences: { gartner2026: { picks: { G1: { p: 0 }, G2: { p: 3, at: MORNING + 3600e3 }, G3: { p: 0, at: MORNING + 3600e3 } }, settings: {}, profile: null } } };
  store.importAllData(doc, CONFS, { replace: false });
  const saved = savedOf('all-other');
  eq([saved.picks.G1.p, saved.picks.G1.note, saved.picks.G2.p, saved.picks.G3.p], [2, 'mine', 3, 0], 'undated loses, newer wins, local notes stay');
  store.importAllData(doc, CONFS, { replace: true });
  eq(Object.keys(savedOf('all-other').picks).sort(), ['G1', 'G2', 'G3'], 'replace makes that conference match the backup: all three of its picks, the undated Skip included');
  eq(savedOf('all-other').picks.G1.p, 0, 'and the local Want gave way to it');
});

await test('should report a conference the device does not know and leave the live one untouched by it', async () => {
  store.load('all-live');
  const doc = { app: BACKUP, v: 1, kind: 'all', conferences: { other2027: { picks: { X: { p: 3, at: 2 } }, settings: {}, profile: null } } };
  const pv = store.previewImportAll(doc, CONFS, { replace: false });
  eq([Object.keys(pv.parts), pv.missing], [[], ['other2027']]);
  eq(store.importAllData(doc, CONFS, { replace: false }), {});
});

// Saved data that can't be read, or that a newer version wrote, is never lost to a backup or a restore.
const ALL_OTHER = 'ignite26.planner.v1:all-other', ALL_UNTOUCHED = 'ignite26.planner.v1:all-untouched';
const CORRUPT = '{"v":1,"picks":{"G1":{"p":2,';
const NEWER_RAW = JSON.stringify({ v: 99, picks: { G9: { p: 3, lock: null, note: '', at: 5 } }, prefs: {}, profile: null, future: 'kept' });
const gartnerDoc = picks => ({ app: BACKUP, v: 1, kind: 'all', conferences: { ignite2026: { picks: { S5: { p: 2, at: 9 } }, settings: {}, profile: null }, gartner2026: { picks, settings: {}, profile: null } } });

await test('should name a conference it cannot back up, and back up the rest', () => {
  localStorage.setItem(ALL_OTHER, CORRUPT);
  localStorage.setItem(ALL_UNTOUCHED, NEWER_RAW);
  store.load('all-live');
  store.mutatePicks(p => { p.S1 = { p: 3, lock: null, note: '', at: 7 }; });
  const report = {};
  const doc = store.exportAll(CONFS, new Date('2026-11-09T05:00:00Z'), report);
  eq([Object.keys(doc.conferences), report.skipped], [['ignite2026'], [{ id: 'gartner2026', reason: 'unreadable' }, { id: 'reinvent2026', reason: 'newer' }]]);
});

await test('should count a saved backup for every conference in the file, and only those', () => {
  const unbacked = { at: null, changes: 5, dismissed: null };
  localStorage.setItem(ALL_OTHER, JSON.stringify({ v: 1, picks: { G1: { p: 2, lock: null, note: '', at: 5 } }, prefs: {}, profile: null, backup: unbacked }));
  localStorage.setItem(ALL_UNTOUCHED, JSON.stringify({ v: 1, picks: { R1: { p: 1, lock: null, note: '', at: 5 } }, prefs: {}, profile: null, backup: unbacked }));
  store.load('all-live');
  store.markBackupFor(CONFS, ['ignite2026', 'gartner2026'], 1234);
  eq([store.get().backup.at, savedOf('all-other').backup, savedOf('all-other').picks.G1.p], [1234, { at: 1234, changes: 0, dismissed: null }, 2]);
  eq(savedOf('all-untouched').backup, unbacked, 'a conference not in the file still needs its backup');
});

await test('should keep unreadable saved data aside before restoring over it', () => {
  localStorage.setItem(ALL_OTHER, CORRUPT);
  localStorage.removeItem(`${ALL_OTHER}#unreadable`);
  store.load('all-live');
  const doc = gartnerDoc({ G1: { p: 3, at: 9 } });
  const pv = store.previewImportAll(doc, CONFS, { replace: false });
  eq([pv.parts.gartner2026?.added, pv.unreadable, pv.blocked], [['G1'], ['gartner2026'], []]);
  const report = {};
  eq(store.importAllData(doc, CONFS, { replace: false }, report), { ignite2026: 1, gartner2026: 1 });
  eq([localStorage.getItem(`${ALL_OTHER}#unreadable`), savedOf('all-other').picks.G1.p, report.failed], [CORRUPT, 3, []]);
});

await test('should not restore over unreadable data it could not keep a copy of', () => {
  localStorage.setItem(ALL_OTHER, CORRUPT);
  localStorage.removeItem(`${ALL_OTHER}#unreadable`);
  store.load('all-live');
  const report = {};
  globalThis.__quota = CORRUPT.length - 1;   // the copy (the unreadable text itself) doesn't fit
  let applied;
  try { applied = store.importAllData(gartnerDoc({ G1: { p: 3, at: 9 } }), CONFS, { replace: false }, report); } finally { globalThis.__quota = null; }
  eq([applied, report.failed, localStorage.getItem(ALL_OTHER), localStorage.getItem(`${ALL_OTHER}#unreadable`)],
    [{ ignite2026: 1 }, [{ id: 'gartner2026', reason: 'copy-failed' }], CORRUPT, null]);
});

await test('should leave a conference saved by a newer version untouched, and restore the rest', () => {
  localStorage.setItem(ALL_OTHER, NEWER_RAW);
  store.load('all-live');
  const doc = gartnerDoc({ G1: { p: 3, at: 9 } });
  const pv = store.previewImportAll(doc, CONFS, { replace: true });
  eq([Object.keys(pv.parts), pv.blocked], [['ignite2026'], [{ id: 'gartner2026', reason: 'newer' }]]);
  const report = {};
  eq(store.importAllData(doc, CONFS, { replace: true }, report), { ignite2026: 1 });
  eq([localStorage.getItem(ALL_OTHER), report.failed, store.pick('S5')?.p], [NEWER_RAW, [{ id: 'gartner2026', reason: 'newer' }], 2]);
});

await test('should name a conference whose restored picks could not be written, and keep what it had', async () => {
  const before = JSON.stringify({ v: 1, picks: { G1: { p: 1, lock: null, note: '', at: 5 } }, prefs: {}, profile: null });
  localStorage.setItem(ALL_OTHER, before);
  store.load('all-live');
  const report = {};
  globalThis.__quota = before.length + 20;   // the restored Gartner state is longer than this
  let applied;
  try { applied = store.importAllData(gartnerDoc({ G1: { p: 3, at: 9 }, G2: { p: 2, at: 9 }, G3: { p: 2, at: 9 } }), CONFS, { replace: false }, report); } finally { globalThis.__quota = null; }
  eq([applied, report.failed, localStorage.getItem(ALL_OTHER)], [{ ignite2026: 1 }, [{ id: 'gartner2026', reason: 'save-failed' }], before]);
  await sleep(SAVE);
});

await test('should refuse a file that calls itself a backup of everything but holds none', () => {
  eq(throws(() => store.previewImportAll({ app: BACKUP, kind: 'all', conferences: 'junk' }, CONFS, {})), 'Not an Ignite planner backup file');
  eq(throws(() => store.previewImportAll({ app: 'other', kind: 'all', conferences: {} }, CONFS, {})), 'Not an Ignite planner backup file');
});

// ---- a picks link sets the session's choice across all its runs (restoring-picks.feature; issue #130)
// siblings: the other saved records of the same repeat group, by record id (app.js passes them).
await test('should clear a lock held by another record of the same session, in the preview and when applied', async () => {
  seed('link-group', { A1: { p: 3, lock: 'RUN2', note: 'mine', at: 10 }, A2: { p: 2, lock: null, note: '', at: 10 } });
  const link = { A2: { p: 3, code: 'LAB1', at: 20 } }, siblings = { A2: ['A1'] };
  const pv = store.previewShared(link, siblings);
  eq([pv.changed.map(c => c.id).sort(), store.pick('A1').lock], [['A1', 'A2'], 'RUN2'], 'previewed, nothing changed yet');
  store.applyShared(link, siblings);
  eq([store.pick('A1').lock, store.pick('A1').note, store.pick('A1').p, store.pick('A2').p, store.pick('A2').lock], [null, 'mine', 3, 3, null]);
  await sleep(SAVE);
});
await test('should keep the lock a link sets on one record when the link also carries a sibling record, in either order', async () => {
  for (const order of [['A1', 'A2'], ['A2', 'A1']]) {
    seed('link-group-both', { A1: { p: 2, lock: null, note: '', at: 10 }, A2: { p: 2, lock: 'OLD', note: '', at: 10 }, A3: { p: 2, lock: 'OLD3', note: '', at: 10 } });
    const recs = { A1: { p: 3, code: 'LAB1', lock: 'RUN2', at: 20 }, A2: { p: 3, code: 'LAB1-R1', at: 20 } };
    const link = Object.fromEntries(order.map(id => [id, recs[id]]));
    store.applyShared(link, { A1: ['A2', 'A3'], A2: ['A1', 'A3'] });
    eq([store.pick('A1').lock, store.pick('A2').lock, store.pick('A3').lock], ['RUN2', null, null], `order ${order}: the link's lock stays, the old ones go`);
    await sleep(SAVE);
  }
});
await test('should keep a reserved seat held by another record of the session', async () => {
  seed('link-group-seat', { A1: { p: 3, lock: 'RUN2', reserved: 'RUN2', note: '', at: 10 }, A2: { p: 2, lock: null, note: '', at: 10 } });
  store.applyShared({ A2: { p: 3, code: 'LAB1', at: 20 } }, { A2: ['A1'] });
  eq([store.pick('A1').lock, store.pick('A1').reserved, store.pick('A2').p], ['RUN2', 'RUN2', 3]);
  await sleep(SAVE);
});
await test('should leave other sessions\' locks alone, and work as before without siblings', async () => {
  seed('link-group-none', { A1: { p: 3, lock: 'RUN2', note: '', at: 10 }, B1: { p: 3, lock: 'B1', note: '', at: 10 } });
  store.applyShared({ A2: { p: 3, code: 'LAB1', at: 20 } });
  eq([store.pick('A1').lock, store.pick('B1').lock, store.pick('A2').p], ['RUN2', 'B1', 3]);
  await sleep(SAVE);
});
await test('should keep a preview marker on a lock kept beside a reserved seat', async () => {
  seed('link-preview-seat', { A1: { p: 2, lock: 'RUN3', lockMode: 'preview', reserved: 'RUN2', note: '', at: 10 } });
  store.applyShared({ A1: { p: 3, code: 'LAB1', at: 20 } });
  eq([store.pick('A1').p, store.pick('A1').lock, store.pick('A1').lockMode, store.pick('A1').reserved], [3, 'RUN3', 'preview', 'RUN2']);
  seed('link-seat-only', { A1: { p: 2, lock: 'RUN2', reserved: 'RUN2', note: '', at: 10 } });
  store.applyShared({ A1: { p: 3, code: 'LAB1', lock: 'RUN4', lockMode: 'preview', at: 20 } });
  eq([store.pick('A1').lock, store.pick('A1').lockMode ?? null], ['RUN2', null], 'the reserved run itself is never a preview lock');
  await sleep(SAVE);
});
await test('should read a session the person added (MY-…) in a picks link, and write it in one', () => {
  const ids = { 'MY-mh5x2k3l': 'my-mh5x2k3l', BRK1: 'S1' };
  eq(Object.keys(store.parseShare('MY-mh5x2k3l.2~BRK1.3', c => ids[c] || null, () => null)), ['my-mh5x2k3l', 'S1']);
  store.load('share-custom');
  store.mutatePicks(p => { p['my-mh5x2k3l'] = { p: 2, lock: null, note: '', at: 1 }; });
  const link = store.shareString(id => (id === 'my-mh5x2k3l' ? 'MY-mh5x2k3l' : null), () => null);
  eq([link, Object.keys(store.parseShare(link, c => ids[c] || null, () => null))], ['MY-mh5x2k3l.2', ['my-mh5x2k3l']]);
  eq(Object.keys(store.parseShare('MY-.2~MY-a b.2~my-abc.2', c => c, () => null)), [], 'only MY- followed by the id characters');
});

await sleep(SAVE);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
