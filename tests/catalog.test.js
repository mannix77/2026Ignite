// An out-of-date catalog (specs/features/catalog-gaps.feature): its age is flagged, and
// sessions missing from it can be added to your own plan.  Run with: node tests/catalog.test.js
import { sleep } from './shim.js';

const { exportAge, customRecords, catalogMatch, buildModel } = await import('../assets/js/data.js');
const { toISO } = await import('../assets/js/time.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');
const { createVenue } = await import('../assets/js/venue.js');
const store = await import('../assets/js/store.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}`);
}

const gartner = CONFERENCES.gartner2026, ignite = CONFERENCES.ignite2026;
const H = 3600000;
const exported = '2026-10-05T14:29:32Z';
const at = hours => new Date(new Date(exported).getTime() + hours * H);

// ---- the catalog's age
await test('should flag an export that is more than a day old', () => {
  eq(exportAge(gartner, exported, at(25))?.days, 1);
});
await test('should not flag a fresh export', () => {
  eq(exportAge(gartner, exported, at(2)), null);
});
await test('should never flag the live Ignite catalog as an old export', () => {
  eq(exportAge(ignite, exported, at(72)), null);
});
await test('should name who can refresh the Gartner export', () => {
  eq(typeof gartner.export.maintainer, 'string');
});
await test('should not flag a catalog refreshed by a scheduled sync as an old export', () => {
  eq(exportAge(CONFERENCES.reinvent2026, exported, at(72)), null);
});

// ---- sessions missing from the catalog
await test('should convert conference-local time to UTC across the Eastern offset', () => {
  eq(toISO('2026-10-19', 18 * 60 + 15, 'America/New_York'), '2026-10-19T22:15:00.000Z');
});

const reception = { id: 'r1', title: 'Healthcare & Life Sciences Networking Reception', day: '2026-10-19', start: 1095, end: 1200, building: 'Y', room: 'Yacht & Beach Club' };
const venue = createVenue(gartner.venue);
const model = (sessions, custom, conf = gartner) => buildModel({ sessions: [...sessions, ...customRecords(custom, conf)] }, { overrides: {} }, null, conf, createVenue(conf.venue));

await test('should place an added session in the building you chose', () => {
  eq(model([], [reception]).sessions[0].loc.building, 'Y');
});
await test('should time an added session from the day and minutes you entered', () => {
  const s = model([], [reception]).sessions[0];
  eq([s.day, s.startMin, s.endMin], ['2026-10-19', 1095, 1200]);
});
await test('should not treat an added session as the published schedule', () => {
  eq(model([], [{ ...reception, day: '2026-11-18' }], ignite).mode, 'unscheduled');
});
await test('should find an added session that a fresh export now lists on the same day', () => {
  const official = { id: '99', inst: '99', code: 'HLR1', title: 'Healthcare and Life Sciences Networking Reception', type: 'Receptions and Special Event', start: '2026-10-19T22:15:00Z', end: '2026-10-20T00:00:00Z', delivery: ['In-person'] };
  eq(catalogMatch(reception, model([official], [])).code, 'HLR1');
});
await test('should not match a catalog session on another day', () => {
  const official = { id: '99', inst: '99', code: 'HLB2', title: 'Healthcare and Life Sciences Networking Reception', type: 'Meals', start: '2026-10-20T11:30:00Z', end: '2026-10-20T12:30:00Z', delivery: ['In-person'] };
  eq(catalogMatch(reception, model([official], [])), null);
});

await test('should keep an added session\'s code when an earlier one is removed', () => {
  const later = { ...reception, id: 'r2', title: 'Vendor dinner' };
  eq(customRecords([later], gartner)[0].code, customRecords([reception, later], gartner)[1].code);
});

// ---- added sessions are personal settings
await test('should keep an added session across a reload', async () => {
  localStorage.clear();
  store.configure({ defaults: { lunch: gartner.lunch }, buildingIds: venue.ids });
  store.load('gartner2026');
  store.setSetting('custom', [reception]);
  await sleep(200);
  store.load('gartner2026');
  eq(store.settings().custom.map(c => c.title), [reception.title]);
});
await test('should drop an added session whose end is before its start', async () => {
  localStorage.clear();
  store.load('gartner2026');
  store.setSetting('custom', [{ ...reception, end: 1000 }]);
  await sleep(200);
  store.load('gartner2026');
  eq(store.settings().custom, []);
});

// Minesh's main site must not pick up a session Gino added in his copy (/gino/). Under
// Node there is no planner-instance meta tag, so this file runs as the main site; the
// copy's side is tested in tests/instance.test.js.
await test("should keep a session added in a colleague's copy out of the main site", () => {
  localStorage.clear();
  const plan = title => JSON.stringify({ v: 1, picks: {}, prefs: { custom: [{ ...reception, title }] } });
  localStorage.setItem('ignite26.planner.v1@gino:gartner2026', plan('Gino reception'));
  localStorage.setItem('ignite26.planner.v1:gartner2026', plan('Minesh dinner'));
  store.load('gartner2026');
  eq(store.settings().custom.map(c => c.title), ['Minesh dinner']);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
