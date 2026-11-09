// An out-of-date catalog (specs/features/catalog-gaps.feature): its age is flagged, and
// sessions missing from it can be added to your own plan.  Run with: node tests/catalog.test.js
import { sleep } from './shim.js';

const { exportAge, customRecords, catalogMatch, buildModel } = await import('../assets/js/data.js');
const { toISO } = await import('../assets/js/time.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');
const { createVenue, walkMinutes, floorExtra, mergeWalk } = await import('../assets/js/venue.js');
const { transition, DEFAULT_PLANNER } = await import('../assets/js/planner.js');
const store = await import('../assets/js/store.js');
const { rsvpChip, rsvpOpensText, unknownRoomsNote, venueMapUrl, mapChip, sessionCard, occupancyLevel, occupancyOf, occupancyChip } = await import('../assets/js/ui.js');

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

// ---- the Metreon is a building of its own (specs/features/venue-model.feature)
// The AMC theaters are on level 3 and The Aviary is the rooftop on level 4 of the same
// building, a block from Moscone West. The Settings matrix is drawn from venue.ids and
// walk.pairs, so a Metreon row needs a pair with every other building.
const moscone = createVenue(CONFERENCES.ignite2026.venue);
const place = room => moscone.parseLocation(room);
await test('should place an AMC Metreon theater in the Metreon on level 3', () => {
  const loc = place('AMC Metreon | Level 3, Theater 9');
  eq([loc.building, loc.floor, loc.known], ['E', '3', true]);
});
await test('should place The Aviary in the Metreon on level 4', () => {
  const loc = place('The Aviary, Labs');
  eq([loc.building, loc.floor, loc.known], ['E', '4', true]);
});
await test('should still read the Hub and room numbers as Moscone floors', () => {
  eq([place('Moscone South, The Hub, Theater A').floor, place('Moscone South, Room 156').floor], ['Hub', '1']);
});
await test('should keep the other off-site hotels apart from the Metreon', () => {
  eq(place('InterContinental, Grand Ballroom').building, 'H');
});
await test('should walk 8 minutes between the Metreon and Moscone West and 9 to a South meeting room', () => {
  const metreon = place('AMC Metreon | Level 3, Theater 9');
  const west = place('Moscone West | Level 3, Room 3001');
  const south = place('Moscone South | Level 2, Room 201');
  eq([walkMinutes(metreon, west, moscone.walk), walkMinutes(west, metreon, moscone.walk), walkMinutes(metreon, south, moscone.walk)], [8, 8, 9]);
});

// ---- walking times follow the routes the official map draws (2026-11-07), plus the badge check
// Map: South Level 2 -> West Level 3 4 min 9 s; the Hub -> West 7 min 57 s; Esplanade tables ->
// Metreon 7 min 31 s; South Level 2 -> Metreon 6 min 12 s. The Hub and the Upper Mezzanine sit
// further in than a Level 2 room, so they add minutes to every walk that leaves South.
const hub = place('Moscone South | The Hub, Theater G');
const table = place('Moscone South | Upper Mezzanine, Esplanade Ballroom, Table 1');
const south2 = place('Moscone South | Level 2, Room 209');
const west3 = place('Moscone West | Level 3, Room 3014');
const theater9 = place('AMC Metreon | Level 3, Theater 9');
await test('should read the Hub and the Upper Mezzanine as floors of Moscone South', () => {
  eq([hub.building, hub.floor, table.building, table.floor, south2.floor], ['S', 'Hub', 'S', 'UM', '2']);
});
await test('should walk 7 minutes from a South meeting room to a West meeting room, either way', () => {
  eq([walkMinutes(south2, west3, moscone.walk), walkMinutes(west3, south2, moscone.walk)], [7, 7]);
});
await test('should add the Hub\'s extra minutes to a walk that leaves South', () => {
  eq([walkMinutes(hub, west3, moscone.walk), walkMinutes(west3, hub, moscone.walk), walkMinutes(hub, theater9, moscone.walk)], [11, 11, 13]);
});
await test('should add the Upper Mezzanine\'s extra minute to a walk that leaves South', () => {
  eq([walkMinutes(table, theater9, moscone.walk), walkMinutes(table, west3, moscone.walk)], [10, 8]);
});
await test('should treat the Hub to a South meeting room as a floor change, not a building change', () => {
  eq(walkMinutes(hub, south2, moscone.walk), moscone.walk.diffFloor);
});
await test('should keep the floor extra when a pair is tuned in Settings, and ignore a junk extra', () => {
  const tuned = { ...moscone.walk, pairs: { ...moscone.walk.pairs, 'S|W': 10 } };
  const junk = { ...moscone.walk, floorExtra: { S: { Hub: 'four' } } };
  const none = { ...moscone.walk, floorExtra: undefined };
  eq([walkMinutes(hub, west3, tuned), walkMinutes(hub, west3, junk), walkMinutes(hub, west3, none)], [14, 7, 7]);
});
// The walk in from a GPS position outside the venue has no building pair; app.js adds the
// destination floor's extra directly.
await test('should give the Hub its extra minutes on their own, and nothing for a typical floor or a junk walk', () => {
  eq([floorExtra(hub, moscone.walk), floorExtra(table, moscone.walk), floorExtra(south2, moscone.walk), floorExtra(west3, moscone.walk), floorExtra(hub, {}), floorExtra(null, moscone.walk)], [4, 1, 0, 0, 0, 0]);
});

// ---- a saved walking matrix keeps what was tuned and takes the recalibration for the rest
// Settings saves every pair, so a saved pair still equal to the default it was saved with (the
// matrix before 2026-11-07) was never tuned and follows the new default.
await test('should take the recalibrated default for a saved pair that still equals the old one', () => {
  const saved = { pairs: { ...moscone.walk.previous.pairs, 'N|S': 7 } };   // a whole matrix saved before the recalibration
  const merged = mergeWalk(moscone.walk, saved);
  eq([merged.pairs['S|W'], merged.pairs['E|W'], merged.pairs['E|S'], merged.pairs['E|N'], merged.pairs['N|S']], [7, 8, 9, 9, 7]);
});
await test('should keep a saved pair that was tuned away from the old default, and the scalars', () => {
  const merged = mergeWalk(moscone.walk, { pairs: { 'S|W': 9, 'E|W': 5, 'D|S': 6 }, sameFloor: 4 });
  eq([merged.pairs['S|W'], merged.pairs['E|W'], merged.pairs['D|S'], merged.sameFloor, merged.diffFloor], [9, 8, 6, 4, moscone.walk.diffFloor]);
});
await test('should always take the floor extras and the previous map from the venue, and cope with junk', () => {
  const merged = mergeWalk(moscone.walk, { pairs: { 'S|W': 'nine', 'E|S': null }, floorExtra: { S: { Hub: 99 } }, previous: { pairs: { 'S|W': 1 } } });
  eq([merged.pairs['S|W'], merged.pairs['E|S'], merged.floorExtra, merged.previous, mergeWalk(moscone.walk, null), mergeWalk(moscone.walk, { pairs: 'junk' }).pairs['S|W']],
    [7, 9, moscone.walk.floorExtra, moscone.walk.previous, moscone.walk, 7]);
});
await test('should list every recalibrated pair in the previous map, and nothing else', () => {
  const changed = ['S|W', 'E|W', 'E|S', 'E|N'];
  eq(Object.keys(moscone.walk.previous.pairs).sort(), changed.sort());
  eq(changed.every(k => moscone.walk.previous.pairs[k] !== moscone.walk.pairs[k]), true);
});
await test('should count a theater and the roof as different floors of one building', () => {
  eq(walkMinutes(place('AMC Metreon | Level 3, Theater 11'), place('The Aviary, Breakouts'), moscone.walk), moscone.walk.diffFloor);
});
await test('should give the Settings matrix a Metreon row with a walk to every other building', () => {
  eq(moscone.ids.includes('E'), true);
  const others = moscone.ids.filter(id => id !== 'E' && id !== 'O');
  eq(others.filter(id => moscone.walk.pairs[['E', id].sort().join('|')] == null), []);
  eq(others.length > 0, true);
});

// ---- Dimes Gallery (667 Howard St, across from Moscone South) is a building of its own
await test('should place Dimes Gallery in its own building', () => {
  const loc = place('Dimes Gallery');
  eq([loc.building, loc.known, moscone.BUILDING.D.name], ['D', true, 'Dimes Gallery']);
});
await test('should walk 5 minutes between Dimes Gallery and Moscone South and 8 to West', () => {
  const dimes = place('Dimes Gallery');
  const south = place('Moscone South | Level 2, Room 201');
  const west = place('Moscone West | Level 3, Room 3001');
  eq([walkMinutes(dimes, south, moscone.walk), walkMinutes(south, dimes, moscone.walk), walkMinutes(dimes, west, moscone.walk)], [5, 5, 8]);
});
await test('should give the Settings matrix a Dimes Gallery row with a walk to every other building', () => {
  const others = moscone.ids.filter(id => id !== 'D' && id !== 'O');
  eq([moscone.ids.includes('D'), others.length > 0, others.filter(id => moscone.walk.pairs[['D', id].sort().join('|')] == null)], [true, true, []]);
});

// ---- a room being rescheduled is not a room yet (a placeholder, like zTest)
await test('should treat a rescheduling room as a placeholder, not an unknown building', () => {
  const parked = place('Rescheduling 3');
  const room = place('Rescheduling Room');
  eq([parked.building, parked.known, parked.placeholder, room.placeholder], ['U', false, true, true]);
  eq(place('Moscone South | Level 2, Room 201').placeholder, undefined);
  eq(walkMinutes(parked, place('Moscone West | Level 3, Room 3001'), moscone.walk), moscone.walk.unknown);
});

// ---- the Map link opens the room on the official indoor map (specs/features/venue-map-link.feature)
// The expected URL shape is the one the Ignite event guide's own "View map" button opens.
const roomed = { code: 'BRK360', room: 'Moscone West | Level 3, Room 3014', roomTbd: false, onlineOnly: false };
await test('should link a roomed session to its room on the official map', () => {
  eq(venueMapUrl(roomed, ignite), 'https://wayfinding.event.microsoft.com/ignite?nto=Moscone%20West%20%7C%20Level%203%2C%20Room%203014&sc=BRK360');
});
await test('should carry a room name with commas and symbols unchanged', () => {
  const u = new URL(venueMapUrl({ ...roomed, code: 'TT1706', room: ' Moscone South | Upper Mezzanine, Esplanade Ballroom, Table 9 ' }, ignite));
  eq([u.origin + u.pathname, u.searchParams.get('nto'), u.searchParams.get('sc')],
    ['https://wayfinding.event.microsoft.com/ignite', 'Moscone South | Upper Mezzanine, Esplanade Ballroom, Table 9', 'TT1706']);
});
await test('should give no link for a placeholder room, an online-only session, a blank room, a preview room, or a conference without a map', () => {
  eq([venueMapUrl({ ...roomed, room: 'Rescheduling 3', roomTbd: true }, ignite), venueMapUrl({ ...roomed, onlineOnly: true }, ignite),
    venueMapUrl({ ...roomed, room: '  ' }, ignite), venueMapUrl({ ...roomed, timeSource: 'preview' }, ignite),
    venueMapUrl({ ...roomed, room: 'Lark 1, WDW Swan Hotel' }, gartner), venueMapUrl(roomed, null)],
  [null, null, null, null, null, null]);
  eq(mapChip(null), '');
});
await test('should render the Map chip as an escaped link that opens in a new tab', () => {
  const html = mapChip(venueMapUrl({ ...roomed, code: 'A&B' }, ignite));
  eq(html.includes('href="https://wayfinding.event.microsoft.com/ignite?nto=Moscone%20West%20%7C%20Level%203%2C%20Room%203014&amp;sc=A%26B"'), true);
  eq([html.includes('target="_blank"'), html.includes('rel="noopener"'), /Map<\/a>$/.test(html)], [true, true, true]);
});
await test('should put the Map chip on a session card next to the room, and leave it off without a map', () => {
  const s = { key: 'k1', code: 'BRK360', type: 'Breakout', title: 'T', onlineOnly: false, loc: { known: false }, roomLabel: 'Moscone West | Level 3, Room 3014', speakers: [] };
  const withMap = sessionCard(s, { mapUrl: venueMapUrl({ ...s, ...roomed }, ignite) });
  const without = sessionCard(s, {});
  eq([withMap.includes('class="chip map"'), withMap.indexOf('Room 3014') < withMap.indexOf('class="chip map"'), without.includes('chip map'), without.includes('Room 3014')], [true, true, false, true]);
});

// ---- room occupancy from the official map's feed (specs/features/room-occupancy.feature)
// The feed's per-room shape is not published; readings come from whatever is recognisable.
const readAt = '2026-11-18T17:10:00Z';
const tenMinLater = Date.parse(readAt) + 10 * 60000;
const feed = rooms => ({ fetchedAt: readAt, enabled: true, rooms });
const room3014 = 'Moscone West | Level 3, Room 3014';
await test('should read a full room from a status word, a percentage, or a count against a capacity', () => {
  eq([occupancyLevel('Full'), occupancyLevel({ status: 'At capacity' }), occupancyLevel(100), occupancyLevel({ percentage: 96 }), occupancyLevel({ count: 190, capacity: 200 })],
    ['full', 'full', 'full', 'full', 'full']);
});
await test('should read a filling room at four fifths and an open room at a third, on both sides of the lines', () => {
  eq([occupancyLevel(80), occupancyLevel(75), occupancyLevel(74), occupancyLevel(33), occupancyLevel(94), occupancyLevel(95), occupancyLevel({ status: 'Moderate' }), occupancyLevel('Available')],
    ['filling', 'filling', 'open', 'open', 'filling', 'full', 'filling', 'open']);
});
await test('should read a negated status as open, not as the word it negates', () => {
  eq([occupancyLevel('Not full'), occupancyLevel({ status: 'No longer busy' }), occupancyLevel('Room is not at capacity'), occupancyLevel('Full')], ['open', 'open', 'open', 'full']);
});
await test('should give no reading for a status that denies the room has space, rather than calling it open', () => {
  eq([occupancyLevel('Not available'), occupancyLevel({ status: 'not open' }), occupancyLevel("isn't empty"), occupancyLevel('No longer low'), occupancyLevel({ status: 'No longer low', percentage: 20 }), occupancyLevel('Available')],
    [null, null, null, null, 'open', 'open']);
});
await test('should give no reading for a value it does not understand', () => {
  eq([occupancyLevel(null), occupancyLevel(undefined), occupancyLevel(true), occupancyLevel('Purple'), occupancyLevel({ status: 'Purple' }), occupancyLevel([95]), occupancyLevel({ count: 5 }), occupancyLevel({ count: 5, capacity: 0 }), occupancyLevel(NaN)],
    [null, null, null, null, null, null, null, null, null]);
});
await test('should show a full room next to its room while the reading is fresh', () => {
  eq(occupancyOf(feed({ [room3014]: { status: 'Full' } }), room3014, tenMinLater), 'full');
  eq(occupancyChip('full').includes('Room full') && occupancyChip('filling').includes('Filling'), true);
  eq([occupancyChip('open'), occupancyChip(null)], ['', '']);
});
await test('should show nothing for a reading too old to trust, or from more than a minute ahead of the clock, on both sides of each limit', () => {
  const at = Date.parse(readAt);
  eq([occupancyOf(feed({ [room3014]: 100 }), room3014, at + 30 * 60000), occupancyOf(feed({ [room3014]: 100 }), room3014, at + 30 * 60000 + 1),
    occupancyOf(feed({ [room3014]: 100 }), room3014, at + 40 * 60000),
    occupancyOf(feed({ [room3014]: 100 }), room3014, at - 60000), occupancyOf(feed({ [room3014]: 100 }), room3014, at - 60001)], ['full', null, null, 'full', null]);
});
await test('should show nothing without a file, a readable time, the room, or a room name', () => {
  eq([occupancyOf(null, room3014, tenMinLater), occupancyOf({ rooms: { [room3014]: 100 } }, room3014, tenMinLater), occupancyOf({ fetchedAt: 'soon', rooms: { [room3014]: 100 } }, room3014, tenMinLater),
    occupancyOf(feed({ 'Moscone West | Level 2, Room 2006': 100 }), room3014, tenMinLater), occupancyOf(feed({ [room3014]: 100 }), '', tenMinLater), occupancyOf(feed('junk'), room3014, tenMinLater)],
  [null, null, null, null, null, null]);
});
await test('should put the fullness chip on a session card next to the room, and leave it off when there is none', () => {
  const s = { key: 'k1', code: 'BRK360', type: 'Breakout', title: 'T', onlineOnly: false, loc: { known: false }, roomLabel: room3014, speakers: [] };
  const withChip = sessionCard(s, { occupancy: 'full' });
  const without = sessionCard(s, {});
  eq([withChip.includes('Room full'), withChip.indexOf('Room 3014') < withChip.indexOf('Room full'), without.includes('Room full'), without.includes('Room 3014')], [true, true, false, true]);
});

// ---- the Changes tab shows the unknown-building notice the scripts wrote into the batch
const batchWith = unknownRooms => ({ at: '2026-10-26T01:37:47Z', milestones: [], added: [], removed: [], changed: [], ...(unknownRooms === undefined ? {} : { unknownRooms }) });
await test('should word the Changes tab notice like the sync summary', () => {
  eq(unknownRoomsNote(batchWith(['Sponsor Pavilion, Stage 2'])), '1 room in an unknown building: Sponsor Pavilion, Stage 2');
  eq(unknownRoomsNote(batchWith(['Sponsor Pavilion, Stage 2', 'Zephyr Hall'])), '2 rooms in an unknown building: Sponsor Pavilion, Stage 2, Zephyr Hall');
});
await test('should show a padded label trimmed and skip junk entries', () => {
  eq(unknownRoomsNote(batchWith(['  Sponsor Pavilion, Stage 2  ', 42, ' ', 'Zephyr Hall'])), '2 rooms in an unknown building: Sponsor Pavilion, Stage 2, Zephyr Hall');
});
await test('should show no notice for a batch with every room known or one logged before rooms were checked', () => {
  eq([unknownRoomsNote(batchWith([])), unknownRoomsNote(batchWith()), unknownRoomsNote(batchWith('not a list')), unknownRoomsNote(batchWith([42, ' ']))], ['', '', '', '']);
});

// ---- reservation times (specs/features/reservation-times.feature)
// Stored as an instant; shown in the viewer's own zone, labelled by Intl.
const { execFileSync } = await import('node:child_process');
const chipTitle = html => (/title="([^"]*)"/.exec(html) || [])[1];
await test('should show 13:00 UTC as 9:00 AM EDT on a device in Eastern time', () => {
  eq(rsvpOpensText('2026-10-20T13:00:00Z', 'America/New_York'), 'Oct 20, 9:00 AM EDT');
});
await test('should show 16:00 UTC as 9:00 AM PDT on a device in Pacific time', () => {
  eq(rsvpOpensText('2026-10-20T16:00:00Z', 'America/Los_Angeles'), 'Oct 20, 9:00 AM PDT');
});
await test('should read an offset time as the same instant (08:00+08:00 is midnight UTC)', () => {
  eq(rsvpOpensText('2026-10-26T08:00:00+08:00', 'UTC'), 'Oct 26, 12:00 AM UTC');
});
await test('should label the zone by its real name on each side of a daylight-saving change', () => {
  eq(rsvpOpensText('2026-11-02T17:00:00Z', 'America/New_York'), 'Nov 2, 12:00 PM EST');
  eq(rsvpOpensText('2026-11-01T04:00:00Z', 'America/New_York'), 'Nov 1, 12:00 AM EDT');
});
await test('should put the time in the chip tooltip, not the label', () => {
  const html = rsvpChip({ rsvp: '2026-10-20T13:00:00Z' });
  eq(html.includes('>RSVP<'), true);
  // The tooltip carries the opening time in the device's zone: run under a pinned zone.
  const title = tz => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "const { rsvpChip } = await import('./assets/js/ui.js'); console.log(JSON.stringify(rsvpChip({ rsvp: '2026-10-20T13:00:00Z' })));"],
  { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 20000 }));
  eq(chipTitle(title('America/New_York')), 'Reservation required. Seats are limited; reservations open Oct 20, 9:00 AM EDT');
  eq(chipTitle(title('America/Los_Angeles')), 'Reservation required. Seats are limited; reservations open Oct 20, 6:00 AM PDT');
});
await test('should convert to the device zone when none is given (Tokyo, Eastern)', () => {
  // The browser's zone, not the conference's: run under two machine zones.
  const run = tz => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "const { rsvpOpensText } = await import('./assets/js/ui.js'); console.log(JSON.stringify(rsvpOpensText('2026-10-20T15:00:00Z')));"],
  { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 20000 }));
  eq(run('Asia/Tokyo'), 'Oct 21, 12:00 AM GMT+9');
  eq(run('America/New_York'), 'Oct 20, 11:00 AM EDT');
});
await test('should say only that a reservation is required when the time is missing or unreadable', () => {
  const plain = 'Reservation required. Seats are limited';
  eq(chipTitle(rsvpChip({ rsvp: true })), plain);
  eq(chipTitle(rsvpChip({ rsvp: 'not a date' })), plain);
  eq(rsvpOpensText('not a date', 'UTC'), '');
  eq(rsvpChip({ rsvp: null }), '');
});

// ---- seat availability from the attendee's portal export (specs/features/seat-availability.feature)
const { seatInfo, seatsSig } = await import('../assets/js/data.js');
const { availChip, seatsDetail } = await import('../assets/js/ui.js');
const reinvent = CONFERENCES.reinvent2026;
const seatRec = (id, code) => ({ id, inst: id, code, title: code, type: 'Workshop', delivery: ['In-person'], rsvp: true, rsvpOpens: '2026-10-06T16:00:00Z',
  start: '2026-12-02T16:30:00Z', end: '2026-12-02T18:30:00Z', dur: 120, room: 'Wynn/Encore | Level 1 | Encore Ballroom 1', group: code, repeats: [], capacity: 84 });
const seatDoc = { generatedAt: '2026-10-07T13:00:04Z', sessions: [seatRec('i1', 'IND327-R'), seatRec('s2', 'SVS350'), seatRec('a1', 'ARC320-R'), seatRec('x1', 'XYZ100')] };
const seatFile = { kind: 'seats', conference: 'reinvent2026', exportedAt: '2026-10-07T13:53:05.967Z', seats: {
  i1: { availability: 'session_full', capacity: 140, seatsRemaining: 0, fewSeatsLeft: false },
  s2: { availability: 'reserve_a_seat', capacity: 84, seatsRemaining: 3, fewSeatsLeft: true },
  a1: { availability: 'walk_up_only', fewSeatsLeft: false },
  ghost: { availability: 'session_full' },
  x1: { availability: 'bogus', capacity: -5, seatsRemaining: 'many', fewSeatsLeft: 'yes' },
} };
const seatModel = seats => buildModel(seatDoc, store.settings(), null, reinvent, createVenue(reinvent.venue), seats);
const sess = (m, id) => m.sessions.find(x => x.id === id);

await test('should mark a full favorite "Session full" and stop asking for a reservation', () => {
  const before = sess(seatModel(null), 'i1');
  eq([before.rsvp, before.availability, availChip(before)], ['2026-10-06T16:00:00Z', undefined, '']); // the catalog alone asks for a seat
  const s = sess(seatModel(seatFile), 'i1');
  eq([s.availability, s.rsvp, s.capacity, s.seatsRemaining, s.fewSeatsLeft], ['session_full', null, 140, 0, false]);
  eq(availChip(s).includes('>Session full<'), true);
});

await test('should keep asking for a reservation while seats remain, and flag few seats left', () => {
  const s = sess(seatModel(seatFile), 's2');
  eq([s.availability, s.rsvp, s.seatsRemaining, s.fewSeatsLeft], ['reserve_a_seat', '2026-10-06T16:00:00Z', 3, true]);
  eq(availChip(s).includes('>Few seats left<'), true);
});

await test('should mark a walk-up-only session and ask for no reservation', () => {
  const s = sess(seatModel(seatFile), 'a1');
  eq([s.availability, s.rsvp, s.capacity], ['walk_up_only', null, 84]); // the catalog's capacity stays when the export has none
  eq(availChip(s).includes('>Walk-up<'), true);
});

await test('should ignore seat records for unknown sessions and junk values', () => {
  const m = seatModel(seatFile);
  eq(m.sessions.map(x => x.id).includes('ghost'), false);
  const x = sess(m, 'x1');
  eq([x.availability, x.rsvp, x.capacity, x.seatsRemaining, x.fewSeatsLeft, availChip(x)], [undefined, '2026-10-06T16:00:00Z', 84, undefined, undefined, '']);
  eq([seatInfo(seatFile, 'x1'), seatInfo(seatFile, 'ghost')?.availability, seatInfo(null, 'i1'), seatInfo({ seats: [] }, 'i1'), seatInfo(seatFile, '')], [null, 'session_full', null, null, null]);
  eq(seatInfo({ seats: { toString: { availability: 'session_full' } } }, 'constructor'), null); // only own keys count
});

await test('should keep a usable availability and drop only the invalid counts', () => {
  const bad = { seats: { y1: { availability: 'reserve_a_seat', capacity: -5, seatsRemaining: 'many', fewSeatsLeft: true } } };
  eq(seatInfo(bad, 'y1'), { availability: 'reserve_a_seat', capacity: null, seatsRemaining: null, fewSeatsLeft: true });
  const doc = { generatedAt: 'x', sessions: [seatRec('y1', 'YYY100')] };
  const y = buildModel(doc, store.settings(), null, reinvent, createVenue(reinvent.venue), bad).sessions[0];
  eq([y.availability, y.capacity, y.seatsRemaining, y.fewSeatsLeft], ['reserve_a_seat', 84, undefined, true]); // the catalog's capacity stays
});

await test('should not apply seat data to a blank session id', () => {
  const blank = { seats: { ' ': { availability: 'session_full', capacity: 10, seatsRemaining: 0 } } };
  eq([seatInfo(blank, ' '), seatInfo(blank, '\t')], [null, null]);
  const doc = { generatedAt: 'x', sessions: [seatRec(' ', 'BLANK1')] };
  const b = buildModel(doc, store.settings(), null, reinvent, createVenue(reinvent.venue), blank).sessions[0];
  eq([b?.availability, b?.rsvp], [undefined, '2026-10-06T16:00:00Z']); // not cleared by a record under a blank key
});

await test('should change the seat signature when seat values change even if exportedAt does not', () => {
  const a = { exportedAt: 'T', seats: { s1: { availability: 'reserve_a_seat', seatsRemaining: 3 } } };
  const sameAgain = { exportedAt: 'T', seats: { s1: { availability: 'reserve_a_seat', seatsRemaining: 3 } } };
  const fewer = { exportedAt: 'T', seats: { s1: { availability: 'reserve_a_seat', seatsRemaining: 2 } } };
  const noStamp = { seats: { s1: { availability: 'session_full' } } };
  eq(seatsSig(a) === seatsSig(sameAgain), true);
  eq(seatsSig(a) === seatsSig(fewer), false);
  eq(seatsSig(noStamp) === seatsSig({ seats: { s1: { availability: 'waitlist' } } }), false);
  eq([seatsSig(null), seatsSig(undefined), seatsSig('junk')], ['', '', '']);
});

await test('should show seats left in the detail even when the capacity is missing', () => {
  const detail = o => seatsDetail({ availability: 'reserve_a_seat', ...o });
  eq(detail({ capacity: 84, seatsRemaining: 3 }), 'Seats to reserve · 84 seats, 3 left at export');
  eq(detail({ seatsRemaining: 3 }), 'Seats to reserve · 3 left at export');
  eq(detail({ capacity: 84 }), 'Seats to reserve · 84 seats');
  eq(detail({}), 'Seats to reserve');
  eq(detail({ fewSeatsLeft: true, seatsRemaining: 0 }), 'Seats to reserve, few left · 0 left at export');
  eq(seatsDetail({}), '');
});

// A reserved seat belongs to one run; the seat file is keyed by session, so the UI is told
// whether this run holds it (true), another run does (false), or nothing is known (undefined).
await test('should say the seat is held only on the run that holds it, and point the other runs elsewhere', () => {
  const held = { availability: 'reserved', capacity: 64 };
  eq(seatsDetail(held, true), 'You hold a reserved seat · 64 seats');
  eq(seatsDetail(held, false), 'Your reserved seat is in another run of this session · 64 seats');
  eq(seatsDetail(held), 'You hold a reserved seat · 64 seats', 'with no pick to go by, the exported status stands');
  eq([seatsDetail({ availability: 'reserve_a_seat' }, false), seatsDetail({ availability: 'session_full' }, true)],
    ['Seats to reserve', 'Full: reservations are gone; a walk-up line forms before the start (arrive 15 min early)'], 'other statuses ignore the flag');
});

await test('should leave a catalog without a seat file exactly as it is', () => {
  const a = seatModel(null).sessions.map(x => [x.id, x.rsvp, x.availability, x.capacity]);
  const b = seatModel({ kind: 'seats', seats: {} }).sessions.map(x => [x.id, x.rsvp, x.availability, x.capacity]);
  eq(a, b);
  eq(a, [['i1', '2026-10-06T16:00:00Z', undefined, 84], ['s2', '2026-10-06T16:00:00Z', undefined, 84], ['a1', '2026-10-06T16:00:00Z', undefined, 84], ['x1', '2026-10-06T16:00:00Z', undefined, 84]]);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
