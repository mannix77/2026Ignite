// Saved user data: picks, backups and resets must never lose a user's plan.
// Run with: node tests/store.test.js
// Each test uses its own storage namespace and waits out the 150 ms save delay, so one
// test's pending save can't land in the next test's storage.
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
await sleep(SAVE);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
