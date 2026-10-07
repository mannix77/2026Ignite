// An out-of-date catalog (specs/features/catalog-gaps.feature): its age is flagged, and
// sessions missing from it can be added to your own plan.  Run with: node tests/catalog.test.js
import { sleep } from './shim.js';

const { exportAge, customRecords, catalogMatch, buildModel } = await import('../assets/js/data.js');
const { toISO } = await import('../assets/js/time.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');
const { createVenue } = await import('../assets/js/venue.js');
const { transition, DEFAULT_PLANNER } = await import('../assets/js/planner.js');
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
await test('should flag an export exactly a day old', () => {
  eq(exportAge(gartner, exported, at(24))?.days, 1);
});
await test('should not flag an export a minute short of a day old', () => {
  eq(exportAge(gartner, exported, at(24 - 1 / 60)), null);
});
await test('should not flag a fresh export', () => {
  eq(exportAge(gartner, exported, at(2)), null);
});
await test('should never flag the live Ignite catalog as an old export', () => {
  eq(exportAge(ignite, exported, at(72)), null);
});
await test('should name who can refresh the Gartner export', () => {
  eq((gartner.export.maintainer || '').trim().length > 0, true); // shown by app.js next to the age warning
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
// catalog-gaps.feature: "the walk to the Yacht & Beach Club is counted before it"
await test('should count the walk from a Dolphin session to an added Yacht & Beach Club reception', () => {
  const talk = { id: 'T1', inst: 'T1', code: 'T1', title: 'Talk', type: 'Track Sessions', start: '2026-10-19T21:00:00Z', end: '2026-10-19T22:00:00Z', room: 'Upper Peninsula 4, WDW Dolphin Hotel', delivery: ['In-person'] };
  const m = model([talk], [reception]);
  const [a, b] = ['T1', 'my-r1'].map(id => m.sessions.find(x => x.id === id));
  eq(transition(a, b, { ...DEFAULT_PLANNER, walk: venue.walk, keynoteBuildings: [] }).walk, venue.walk.pairs['D|Y']);
});
await test('should find an added session that a fresh export now lists on the same day', () => {
  const official = { id: '99', inst: '99', code: 'HLR1', title: 'Healthcare and Life Sciences Networking Reception', type: 'Receptions and Special Event', start: '2026-10-19T22:15:00Z', end: '2026-10-20T00:00:00Z', delivery: ['In-person'] };
  eq(catalogMatch(reception, model([official], [])).code, 'HLR1');
});
await test('should not match an unrelated catalog session on the same day', () => {
  const roundtable = { id: '98', inst: '98', code: 'CIO7', title: 'Healthcare Provider CIO Roundtable', type: 'Roundtable', start: '2026-10-19T22:15:00Z', end: '2026-10-20T00:00:00Z', delivery: ['In-person'] };
  eq(catalogMatch(reception, model([roundtable], [])), null);
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

// ---- Preview: simulated Ignite times only while nothing official is published
const unscheduled = { id: 'P1', inst: 'P1', code: 'BRK201', title: 'Unscheduled', type: 'Breakout', delivery: ['In-person'], speakers: [], dur: 45, roomTbd: true };
const scheduled = { ...unscheduled, id: 'P2', inst: 'P2', code: 'BRK202', title: 'Scheduled', start: '2026-11-18T17:00:00Z', end: '2026-11-18T17:45:00Z', roomTbd: false, room: 'Moscone West, Level 2, Room 2001' };
const previewModel = (sessions, custom = []) => buildModel({ sessions: [...sessions, ...customRecords(custom, ignite)] }, { overrides: {}, preview: true }, null, ignite, createVenue(ignite.venue));
const timing = (sessions, custom) => previewModel(sessions, custom).sessions.find(x => x.id === 'P1').timeSource;

await test('should preview a time for an unscheduled session while nothing is scheduled', () => {
  eq(timing([unscheduled]), 'preview');
});

await test('should not invent a time once any official time is published', () => {
  eq(timing([unscheduled, scheduled]), null);
});

await test('should keep previewing when the only timed session is one the user added', () => {
  const m = previewModel([unscheduled], [{ id: 'c1', title: 'Team dinner', day: '2026-11-18', start: 1140, end: 1260, building: 'W' }]);
  const source = id => m.sessions.find(x => x.id === id)?.timeSource;
  eq([source('my-c1'), source('P1')], ['custom', 'preview']); // the added session is timed, and preview still runs
});

// ---- every real room maps to a building, or walking times fall back to a guess
// A snapshot (tests/data/real_rooms.json), not the live catalog: CI runs these tests before
// each sync, and a new room the parser doesn't know must not block catalog updates.
const { readFileSync } = await import('node:fs');
const realRooms = JSON.parse(readFileSync(new URL('./data/real_rooms.json', import.meta.url), 'utf8')).rooms;
for (const [id, rooms] of Object.entries(realRooms)) {
  await test(`should place every ${CONFERENCES[id].short || id} room in a known building`, () => {
    const venue = createVenue(CONFERENCES[id].venue);
    eq(rooms.filter(r => !venue.parseLocation(r).known), []);
  });
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
