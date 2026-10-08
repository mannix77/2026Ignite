// Keeping picks safe on the device (specs/features/keeping-picks-safe.feature).
// Run with: node tests/health.test.js
import { sleep } from './shim.js';

const { storageStatus, backupReminder, backupAge } = await import('../assets/js/health.js');
const store = await import('../assets/js/store.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}`);
}

const DAY = 86400000;
const now = new Date('2026-10-10T15:00:00Z').getTime();

// ---- how picks are being kept
await test('should report picks saved in the installed app', () => {
  eq(storageStatus({ standalone: true, persisted: false, saveFailing: false }).level, 'installed');
});
await test('should report picks protected from cleanup in a tab with persistent storage', () => {
  eq(storageStatus({ standalone: false, persisted: true, saveFailing: false }).level, 'protected');
});
await test('should warn that a browser tab may clear picks', () => {
  eq(storageStatus({ standalone: false, persisted: false, saveFailing: false }).level, 'at-risk');
});
await test('should report that changes are not being saved when storage refuses writes', () => {
  eq(storageStatus({ standalone: true, persisted: true, saveFailing: true }).level, 'not-saved');
});

// ---- backup reminders
const base = { hasPicks: true, at: now - DAY, changes: 0, dismissed: null, now, conferenceStart: '2026-10-18', today: '2026-10-10' };
await test('should remind after 20 changes since the last backup', () => {
  eq(backupReminder({ ...base, changes: 20 })?.reason, 'changes');
});
await test('should not remind after a few changes to a recent backup', () => {
  eq(backupReminder({ ...base, changes: 3 }), null);
});
await test('should remind when the last backup is more than a week old', () => {
  eq(backupReminder({ ...base, at: now - 8 * DAY, changes: 1 })?.reason, 'age');
});
await test('should remind when picks exist but no backup was ever saved', () => {
  eq(backupReminder({ ...base, at: null, changes: 5 })?.reason, 'never');
});
await test('should remind the day before the conference when something changed', () => {
  eq(backupReminder({ ...base, changes: 1, today: '2026-10-17' })?.reason, 'conference');
});
await test('should not remind someone without picks', () => {
  eq(backupReminder({ ...base, hasPicks: false, at: null, changes: 0 }), null);
});
await test('should stay quiet after a dismissal until 20 more changes', () => {
  eq(backupReminder({ ...base, changes: 25, dismissed: { at: now - DAY, changes: 20 } }), null);
});
await test('should describe a backup saved today', () => {
  eq(backupAge(now - 3600000, now), 'today');
});
await test('should call a backup from before midnight yesterday', () => {
  const late = new Date(2026, 9, 9, 23, 50).getTime(), early = new Date(2026, 9, 10, 0, 10).getTime();
  eq(backupAge(late, early), 'yesterday');
});
await test('should not remind about an old backup when nothing changed since', () => {
  eq(backupReminder({ ...base, at: now - 8 * DAY, changes: 0 }), null);
});
await test('should let the conference-eve reminder be dismissed for that day', () => {
  eq(backupReminder({ ...base, changes: 1, today: '2026-10-17', dismissed: { at: now, changes: 1, day: '2026-10-17' } }), null);
});
await test('should show the conference-eve reminder despite an earlier dismissal', () => {
  eq(backupReminder({ ...base, changes: 1, today: '2026-10-17', dismissed: { at: now - DAY, changes: 1, day: '2026-10-16' } })?.reason, 'conference');
});
await test('should mention private windows when a browser tab may clear picks', () => {
  eq(/private/i.test(storageStatus({ standalone: false, persisted: false, saveFailing: false }).text), true);
});

// ---- the store keeps track
await test('should count pick changes since the last backup', async () => {
  localStorage.clear();
  store.load('health');
  store.mutatePicks(p => { p.A = { p: 3, lock: null, note: '', at: 1 }; });
  store.mutatePicks(p => { p.B = { p: 2, lock: null, note: '', at: 1 }; });
  eq(store.backupState().changes, 2);
});
await test('should reset the change count when a backup is saved', async () => {
  localStorage.clear();
  store.load('health');
  store.mutatePicks(p => { p.A = { p: 3, lock: null, note: '', at: 1 }; });
  store.markBackup(now);
  await sleep(200);
  store.load('health');
  eq([store.backupState().changes, store.backupState().at], [0, now]);
});

await test('should forget the last backup when all ratings are erased', async () => {
  localStorage.clear();
  store.load('health-erase');
  store.mutatePicks(p => { p.A = { p: 3, lock: null, note: '', at: 1 }; });
  store.markBackup(now);
  store.resetAll();
  store.mutatePicks(p => { p.B = { p: 2, lock: null, note: '', at: 1 }; });
  eq([store.backupState().at, store.backupState().changes], [null, 1]);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
