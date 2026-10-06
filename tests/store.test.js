// Saved user data: picks, backups and resets must never lose a user's plan.
// Run with: node tests/store.test.js
// Each test uses its own storage namespace and waits out the 150 ms save delay, so one
// test's pending save can't land in the next test's storage.
import { sleep } from './shim.js';

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
await sleep(SAVE);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
