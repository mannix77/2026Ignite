// The My plan calendar grid (specs/features/plan-grid-view.feature, issue #155): the saved
// List / Grid choice, which of a day's entries go on the grid, and where each one is drawn.
// Run with: node tests/grid.test.js
//
// A test's name starts with the title of the scenario it covers. Fixture times are built with
// hm(hour, minute) on a 24-hour clock; every expected number is written out, and the ones the
// feature file prints (45, 120, 164, 239, 119, 60, 104, 224, 538, 180) are copied from it.
// "beyond the feature file" marks a test of something the feature leaves open and the header of
// assets/js/grid.js decides. What only a browser can show (the switch, the page's other
// sections, taps) is in the Playwright suite; here is the pure part of those scenarios.
//
// The store tests wait out the 150 ms save delay, so one test's pending save can't land in the
// next test's storage. The conference tests have to use the real namespaces, so they start from
// empty storage; the others use a namespace of their own.
import { sleep } from './shim.js';

const { planView, gridEntries, gridLayout, PILL_HEADER, PILL_ROW, BAND_LABEL } = await import('../assets/js/grid.js');
const store = await import('../assets/js/store.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ? `${msg}: ` : ''}expected ${B}, got ${A}`);
}
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }

const TUE = '2026-11-17', WED = '2026-11-18';
const MUST = 3, WANT = 2, MAYBE = 1;
const hm = (h, m = 0) => h * 60 + m; // fixtures only

// A timed run of a pick, shaped like computePlan().items. key, id and code all differ, so a
// test of the key can't pass on the code or the group id.
function session(code, start, end, extra = {}) {
  return { key: `key:${code}`, id: `group:${code}`, code, title: `${code} title`, type: 'Breakout', day: TUE, startMin: start, endMin: end,
    loc: { label: `Room ${code}`, building: 'W', floor: '2', known: true }, recorded: null, priority: WANT, locked: false, reserved: false, ...extra };
}
// Blocked time as app.js hands it to the planner.
function blockedTime(id, label, day, start, end) {
  return { key: `block:${id}`, id: `block:${id}`, code: label, title: label, pseudo: 'block', weight: 1e7, locked: true, priority: 0, day, startMin: start, endMin: end,
    loc: { label: '', building: null, floor: null, known: false } };
}
const band = (kind, key, title, start, end) => ({ kind, key, title, startMin: start, endMin: end });

// What a layout says, as plain rows. Two half-width blocks that start together have no order
// of their own in "time order", so blocks are read left column first.
const hoursOf = l => l.hours.map(h => [h.min, h.label, h.top]);
const blocksOf = l => l.blocks.map(b => [b.item.code, b.startMin, b.endMin, b.top, b.height, b.col, b.cols]).sort((a, b) => a[1] - b[1] || a[5] - b[5]);
const pillsOf = l => l.pills.map(p => [p.id, p.startMin, p.endMin, p.top, p.height, p.open, p.count, p.label, p.dots, p.rows.map(r => r.code)]);
const bandsOf = l => l.bands.map(b => [b.kind, b.key, b.title, b.startMin, b.endMin, b.top, b.height]);
const everything = l => ({ startMin: l.startMin, endMin: l.endMin, height: l.height, hours: hoursOf(l), blocks: blocksOf(l), pills: pillsOf(l), bands: bandsOf(l) });
function find(list, match, what) {
  const hit = list.find(match);
  if (!hit) throw new Error(`the layout has no ${what}`);
  return hit;
}
const hourLine = (l, label) => find(l.hours, h => h.label === label, `${label} hour line`);
const blockOf = (l, code) => find(l.blocks, b => b.item.code === code, `block for ${code}`);
const pillAt = (l, id) => find(l.pills, p => p.id === id, `pill ${id}`);
// The very items given, not copies: the page reads a session's key, title and room from them.
function same(actual, expected, what) {
  eq(actual.map(x => x?.key), expected.map(x => x.key), what);
  ok(actual.every((x, i) => x === expected[i]), `${what}: the keys match but these are not the items that were given`);
}
// Both lists gridEntries returns, so a stray band beside the right sessions (or a stray session
// beside the right bands) cannot pass. Bands are named by key.
function entriesAre(entries, sessions, bandKeys, what) {
  same(entries.sessions, sessions, `${what}: sessions`);
  eq(entries.bands.map(b => b.key), bandKeys, `${what}: bands`);
}

// ================================================================ the List / Grid choice

const SAVE = 200; // longer than the store's save delay
const IGNITE = CONFERENCES.ignite2026.namespace, REINVENT = CONFERENCES.reinvent2026.namespace;
const savedView = () => planView(store.get().ui.planView);
// "Opens the planner": what app.js does at startup for a conference.
const openPlanner = namespace => { store.load(namespace); return savedView(); };

await test('First visit: with nothing saved the day is shown as the list', () => {
  eq([planView(undefined), planView()], ['list', 'list']);
  eq(planView('grid'), 'grid', 'and a saved "grid" is not the list, so "list" is an answer and not the only one');
});

await test('First visit: a planner that has never saved anything opens on the list', async () => {
  eq(localStorage.getItem('ignite26.planner.v1:grid-first-visit'), null, 'precondition: nothing is saved for this planner');
  eq(openPlanner('grid-first-visit'), 'list');
  store.setUI({ planView: 'grid' });
  eq(savedView(), 'grid', 'the same planner does show the grid once it is chosen');
  await sleep(SAVE);
});

await test('Switching to the grid: choosing Grid reads as the grid and choosing List as the list', () => {
  eq([planView('grid'), planView('list')], ['grid', 'list']);
});

await test('Switching to the grid: the choice is saved beside the open tab and day without changing them', async () => {
  store.load('grid-switch');
  store.setUI({ tab: 'plan', day: TUE });
  eq(savedView(), 'list', 'precondition: My plan shows Tuesday as the list');
  store.setUI({ planView: 'grid' });
  eq([savedView(), store.get().ui.tab, store.get().ui.day], ['grid', 'plan', TUE]);
  store.setUI({ planView: 'list' });
  eq([savedView(), store.get().ui.tab, store.get().ui.day], ['list', 'plan', TUE], 'and back');
  await sleep(SAVE);
});

await test('The grid follows the day tabs: changing the day leaves the choice on Grid', async () => {
  store.load('grid-day-tabs');
  store.setUI({ tab: 'plan', day: TUE, planView: 'grid' });
  eq([savedView(), store.get().ui.day], ['grid', TUE], 'precondition: My plan shows Tuesday as the grid');
  store.setUI({ day: WED });
  eq([savedView(), store.get().ui.day], ['grid', WED]);
  // The other side: a day change does not turn the list into the grid either.
  store.setUI({ planView: 'list' });
  store.setUI({ day: TUE });
  eq([savedView(), store.get().ui.day], ['list', TUE]);
  await sleep(SAVE);
});

await test('The choice survives a reload: Grid chosen in the Ignite planner is the grid when it is reopened', async () => {
  localStorage.clear();
  eq(openPlanner(IGNITE), 'list', 'precondition: the Ignite planner starts on the list');
  store.setUI({ planView: 'grid' });
  await sleep(SAVE);
  eq(openPlanner(IGNITE), 'grid');
  store.setUI({ planView: 'list' });
  await sleep(SAVE);
  eq(openPlanner(IGNITE), 'list', 'and a later choice of List survives one too');
});

await test('The choice does not leak to another conference: Grid chosen in Ignite leaves re:Invent on the list', async () => {
  localStorage.clear();
  ok(typeof IGNITE === 'string' && typeof REINVENT === 'string' && IGNITE !== REINVENT, 'precondition: the two conferences save under different namespaces');
  eq([openPlanner(IGNITE), openPlanner(REINVENT)], ['list', 'list'], 'precondition: both start on the list');
  store.load(IGNITE);
  store.setUI({ planView: 'grid' });
  await sleep(SAVE);
  eq(openPlanner(REINVENT), 'list');
  eq(openPlanner(IGNITE), 'grid', 'the choice was saved: it is still there for Ignite');
});

await test('The choice does not leak to another conference: Grid chosen in re:Invent leaves Ignite on the list', async () => {
  localStorage.clear();
  eq([openPlanner(REINVENT), openPlanner(IGNITE)], ['list', 'list'], 'precondition: both start on the list');
  store.load(REINVENT);
  store.setUI({ planView: 'grid' });
  await sleep(SAVE);
  eq(openPlanner(IGNITE), 'list');
  eq(openPlanner(REINVENT), 'grid', 'the choice was saved: it is still there for re:Invent');
});

await test('A saved choice that is neither list nor grid: "week" is shown as the list', () => {
  eq([planView('week'), planView('grid')], ['list', 'grid']);
});

await test('A saved choice that is neither list nor grid: only exactly "grid" is the grid', () => {
  const junk = {
    'an empty string': '', 'Grid': 'Grid', 'GRID': 'GRID', 'grid with a space before': ' grid', 'grid with a space after': 'grid ', 'gridx': 'gridx',
    'null': null, 'zero': 0, 'one': 1, 'true': true, 'NaN': NaN, 'an object': {}, 'an empty list': [],
    'a list holding "grid"': ['grid'], 'an object that prints as "grid"': { toString: () => 'grid' },
  };
  for (const [what, saved] of Object.entries(junk)) eq(planView(saved), 'list', what);
  eq(planView('grid'), 'grid');
});

await test('A saved choice that is neither list nor grid: a saved "week" opens on the list', async () => {
  const save = (ns, view) => localStorage.setItem(`ignite26.planner.v1:${ns}`, JSON.stringify({ v: 1, picks: {}, ui: { tab: 'plan', planView: view } }));
  const cases = { week: 'week', number: 1, flag: true, list: ['grid'] };
  for (const [name, view] of Object.entries(cases)) {
    save(`grid-saved-${name}`, view);
    const shown = openPlanner(`grid-saved-${name}`);
    eq(store.get().ui.tab, 'plan', `precondition (${name}): the saved state was read, not replaced by a blank one`);
    eq(shown, 'list', name);
  }
  save('grid-saved-grid', 'grid');
  eq([openPlanner('grid-saved-grid'), store.get().ui.tab], ['grid', 'plan'], 'a saved "grid" read the same way is the grid');
  await sleep(SAVE);
});

// ================================================================ what is on the grid

await test('A pick the plan dropped is still on the grid: the Must and the dropped Maybe are both there, side by side', () => {
  const must = session('MUST', hm(10), hm(10, 45), { priority: MUST }), maybe = session('MAYBE', hm(10), hm(10, 45), { priority: MAYBE });
  const dropped = [{ item: maybe, reason: { kind: 'overlap', other: must, text: 'Same time as MUST (Must)' } }];
  const entries = gridEntries({ items: [must, maybe], dropped, day: TUE });
  same(entries.sessions, [must, maybe], 'sessions');
  eq(entries.bands, []);
  const l = gridLayout(entries);
  eq(blocksOf(l), [['MUST', 600, 645, 0, 45, 0, 2], ['MAYBE', 600, 645, 0, 45, 1, 2]]);
  eq(l.pills, []);
  // "Still listed under What you'll miss" is the page's list of dropped picks: it is left as it was.
  eq(dropped.map(d => [d.item.key, d.reason.kind]), [['key:MAYBE', 'overlap']]);
});

// beyond the feature file: a run given up for another run of the same session (reason.kind
// 'repeat') is not on the grid; a pick dropped for any other reason is.
await test('A pick the plan dropped is still on the grid: for every reason except giving it up for another run of the same session', () => {
  const entriesFor = kind => {
    const chosen = session('CHOSEN', hm(10), hm(10, 45), { priority: MUST }), lost = session('LOST', hm(10), hm(10, 45), { priority: MAYBE });
    return { chosen, lost, entries: gridEntries({ items: [chosen, lost], dropped: [{ item: lost, reason: { kind, text: '' } }], day: TUE }) };
  };
  for (const kind of ['overlap', 'walk', 'block', 'other']) {
    const { chosen, lost, entries } = entriesFor(kind);
    entriesAre(entries, [chosen, lost], [], `dropped for "${kind}"`);
  }
  const { chosen, entries } = entriesFor('repeat');
  entriesAre(entries, [chosen], [], 'dropped for "repeat"');
});

// beyond the feature file: the same decision, with the runs of one session (they share an id).
await test('A pick the plan dropped is still on the grid: a run given up for another run is left out, the run attended and the other dropped picks stay', () => {
  const lab = session('LAB', hm(10), hm(11, 15), { id: 'group:LAB', priority: MUST });
  const labLater = session('LAB-R1', hm(15), hm(16, 15), { id: 'group:LAB', priority: MUST });
  const labWed = session('LAB-R2', hm(13), hm(14, 15), { id: 'group:LAB', priority: MUST, day: WED });
  const keynote = session('KEY', hm(10), hm(11), { priority: MUST });
  const side = session('SIDE', hm(10, 30), hm(11, 15), { priority: MAYBE });
  const wed = session('WED', hm(9), hm(9, 45), { day: WED });
  const items = [lab, keynote, side, labLater, labWed, wed];
  const dropped = [
    { item: lab, reason: { kind: 'repeat', clash: true, other: keynote } },
    { item: side, reason: { kind: 'overlap', other: keynote } },
    { item: labWed, reason: { kind: 'repeat', clash: false } },
  ];
  entriesAre(gridEntries({ items, dropped, day: TUE }), [keynote, side, labLater], [], 'Tuesday');
  entriesAre(gridEntries({ items, dropped, day: WED }), [wed], [], 'Wednesday');
  entriesAre(gridEntries({ items, dropped: [], day: TUE }), [lab, keynote, side, labLater], [], 'precondition: with nothing dropped every Tuesday run is there');
});

await test('Blocked time and lunch are on the grid: each is a block at its own time', () => {
  const entries = gridEntries({ items: [], blocks: [blockedTime('b1', 'Customer meeting', TUE, hm(9), hm(10))], lunch: { start: hm(12), end: hm(12, 45) }, day: TUE });
  eq(entries.sessions, [], 'neither is a session');
  eq(entries.bands.map(b => [b.kind, b.key, b.title, b.startMin, b.endMin]),
    [['block', 'block:b1', 'Customer meeting', 540, 600], ['lunch', 'lunch', 'Lunch', 720, 765]]);
  const l = gridLayout(entries);
  eq([l.startMin, l.endMin], [540, 780]);
  eq(bandsOf(l), [['block', 'block:b1', 'Customer meeting', 540, 600, 0, 60], ['lunch', 'lunch', 'Lunch', 720, 765, 180, 45]]);
  eq(hoursOf(l), [[540, '9 AM', 0], [600, '10 AM', 60], [660, '11 AM', 120], [720, '12 PM', 180], [780, '1 PM', 240]]);
  eq([l.blocks, l.pills, l.height], [[], [], 240]);
});

await test('Blocked time and lunch are on the grid: in time order, and only this day\'s and only with a time', () => {
  const blocks = [
    blockedTime('late', 'Booth duty', TUE, hm(15), hm(16)),
    blockedTime('wed', 'Customer dinner', WED, hm(18), hm(20)),
    blockedTime('early', 'Breakfast meeting', TUE, hm(8), hm(8, 30)),
    blockedTime('untimed', 'No time', TUE, null, null),
    blockedTime('empty', 'Zero minutes', TUE, hm(14), hm(14)),
    blockedTime('backwards', 'Ends before it starts', TUE, hm(14), hm(13)),
    blockedTime('minute', 'One minute', TUE, hm(14), hm(14, 1)),
  ];
  const bands = (lunch, day) => {
    const entries = gridEntries({ items: [], blocks, lunch, day });
    eq(entries.sessions, [], 'blocked time and lunch are never sessions');
    return entries.bands.map(b => [b.kind, b.key, b.startMin, b.endMin]);
  };
  eq(bands({ start: hm(12), end: hm(12, 30) }, TUE),
    [['block', 'block:early', 480, 510], ['lunch', 'lunch', 720, 750], ['block', 'block:minute', 840, 841], ['block', 'block:late', 900, 960]]);
  eq(bands(null, WED), [['block', 'block:wed', 1080, 1200]], 'Wednesday has its own blocked time, and no lunch when none is protected');
  eq(bands({ start: null, end: null }, WED), [['block', 'block:wed', 1080, 1200]], 'a lunch without a time is left out');
  eq(bands({ start: hm(12), end: hm(12) }, WED), [['block', 'block:wed', 1080, 1200]], 'a lunch of no minutes is left out');
  eq(bands({ start: hm(12), end: hm(12, 1) }, WED), [['lunch', 'lunch', 720, 721], ['block', 'block:wed', 1080, 1200]], 'a lunch of one minute is not');
});

await test('A pick without a time is not on the grid: the Want with no time yet is left out, the timed pick is there', () => {
  const must = session('MUST', hm(10), hm(10, 45), { priority: MUST });
  const noTime = session('NO-TIME', null, null), noDay = session('NO-DAY', null, null, { day: null });
  const entries = gridEntries({ items: [noTime, must, noDay], day: TUE });
  entriesAre(entries, [must], [], 'what is on the grid');
  eq(blocksOf(gridLayout(entries)), [['MUST', 600, 645, 0, 45, 0, 1]], 'and the grid is laid out without it');
});

await test('A pick without a time is not on the grid: a time is two finite numbers, the end after the start', () => {
  const good = session('GOOD', hm(10), hm(10, 45)), oneMinute = session('ONE-MINUTE', hm(11), hm(11, 1));
  const times = {
    'no end': [600, null], 'no start': [null, 645], 'undefined': [undefined, undefined], 'not a number': [NaN, NaN],
    'zero minutes': [600, 600], 'ends before it starts': [645, 600], 'never ends': [600, Infinity], 'always started': [-Infinity, 645],
  };
  for (const [what, [start, end]] of Object.entries(times)) {
    const odd = session('ODD', start, end);
    entriesAre(gridEntries({ items: [good, odd, oneMinute], day: TUE }), [good, oneMinute], [], what);
  }
});

await test('The grid follows the day tabs: each day\'s grid holds that day\'s sessions and blocked time, in the order given', () => {
  const tueLate = session('TUE-LATE', hm(14), hm(14, 45)), tueEarly = session('TUE-EARLY', hm(10), hm(10, 45));
  const wed = session('WED', hm(10), hm(10, 45), { day: WED });
  const items = [tueLate, wed, tueEarly];
  const blocks = [blockedTime('t', 'Tuesday meeting', TUE, hm(9), hm(9, 30)), blockedTime('w', 'Wednesday meeting', WED, hm(16), hm(17))];
  const tuesday = gridEntries({ items, blocks, day: TUE }), wednesday = gridEntries({ items, blocks, day: WED });
  same(tuesday.sessions, [tueLate, tueEarly], 'Tuesday');
  eq(tuesday.bands.map(b => b.key), ['block:t']);
  same(wednesday.sessions, [wed], 'Wednesday');
  eq(wednesday.bands.map(b => b.key), ['block:w']);
});

// ================================================================ the hours

const NINE_TO_FIVE = [[540, '9 AM', 0], [600, '10 AM', 60], [660, '11 AM', 120], [720, '12 PM', 180], [780, '1 PM', 240],
  [840, '2 PM', 300], [900, '3 PM', 360], [960, '4 PM', 420], [1020, '5 PM', 480]];

await test('Picks that start and end between hours: 9:14 AM to 4:40 PM gives hour lines from 9 AM to 5 PM', () => {
  const l = gridLayout({ sessions: [session('LAST', hm(15, 55), hm(16, 40)), session('FIRST', hm(9, 14), hm(10))], bands: [] });
  eq([l.startMin, l.endMin, l.height], [540, 1020, 480]);
  eq(hoursOf(l), NINE_TO_FIVE);
});

await test('Picks that start and end on the hour: 9:00 AM to 5:00 PM gives hour lines from 9 AM to 5 PM', () => {
  const l = gridLayout({ sessions: [session('FIRST', hm(9), hm(10)), session('LAST', hm(16), hm(17))], bands: [] });
  eq([l.startMin, l.endMin, l.height], [540, 1020, 480]);
  eq(hoursOf(l), NINE_TO_FIVE);
});

await test('Picks that start and end on the hour: a minute either side of the hour', () => {
  const range = (start, end) => { const l = gridLayout({ sessions: [session('ONLY', start, end)], bands: [] }); return [l.startMin, l.endMin, l.hours[0].label, l.hours.at(-1).label, l.hours.length]; };
  eq(range(hm(9), hm(17)), [540, 1020, '9 AM', '5 PM', 9], 'on the hour at both ends');
  eq(range(hm(8, 59), hm(17)), [480, 1020, '8 AM', '5 PM', 10], 'starting a minute before 9');
  eq(range(hm(9, 1), hm(17)), [540, 1020, '9 AM', '5 PM', 9], 'starting a minute after 9');
  eq(range(hm(9), hm(16, 59)), [540, 1020, '9 AM', '5 PM', 9], 'ending a minute before 5');
  eq(range(hm(9), hm(17, 1)), [540, 1080, '9 AM', '6 PM', 10], 'ending a minute after 5');
});

await test('Picks that start and end between hours: the last hour comes from the latest end, not the latest start', () => {
  const l = gridLayout({ sessions: [session('LONG', hm(9, 14), hm(15, 10)), session('SHORT', hm(13), hm(13, 30))], bands: [] });
  eq([l.startMin, l.endMin, l.hours.at(-1).label], [540, 960, '4 PM']);
});

await test('Blocked time and lunch are on the grid: the hours stretch to cover them as they do for sessions', () => {
  const only = session('ONLY', hm(10), hm(10, 45));
  const alone = gridLayout({ sessions: [only], bands: [] });
  eq([alone.startMin, alone.endMin], [600, 660], 'precondition: the session alone runs from 10 AM to 11 AM');
  const l = gridLayout({ sessions: [only], bands: [band('block', 'block:b', 'Breakfast meeting', hm(8, 30), hm(9, 15)), band('lunch', 'lunch', 'Lunch', hm(12), hm(12, 45))] });
  eq([l.startMin, l.endMin, l.height], [480, 780, 300]);
  eq(hoursOf(l), [[480, '8 AM', 0], [540, '9 AM', 60], [600, '10 AM', 120], [660, '11 AM', 180], [720, '12 PM', 240], [780, '1 PM', 300]]);
  eq(blocksOf(l), [['ONLY', 600, 645, 120, 45, 0, 1]]);
  eq(bandsOf(l), [['block', 'block:b', 'Breakfast meeting', 510, 555, 30, 45], ['lunch', 'lunch', 'Lunch', 720, 765, 240, 45]]);
});

await test('A day with no timed picks: there is no grid to draw and no hour lines', () => {
  const items = [session('WED', hm(10), hm(10, 45), { day: WED }), session('NO-TIME', null, null)];
  const blocks = [blockedTime('w', 'Wednesday meeting', WED, hm(9), hm(10))];
  const tuesday = gridEntries({ items, blocks, lunch: null, day: TUE });
  eq([tuesday.sessions, tuesday.bands], [[], []]);
  ok(gridLayout(tuesday) === null, 'Tuesday: expected null (the page then says "Nothing planned")');
  ok(gridLayout({ sessions: [], bands: [] }) === null && gridLayout({}) === null && gridLayout() === null, 'expected null for nothing at all');
  const wednesday = gridLayout(gridEntries({ items, blocks, lunch: null, day: WED }));
  eq(hoursOf(wednesday), [[540, '9 AM', 0], [600, '10 AM', 60], [660, '11 AM', 120]], 'the same picks do give Wednesday a grid');
});

// ================================================================ one block

await test('A 50-minute session on a grid that starts at 9 AM: its block starts 60 units down, is 50 units tall and full width', () => {
  const opening = session('OPENING', hm(9), hm(9, 30)), must = session('MUST', hm(10), hm(10, 50), { priority: MUST });
  const l = gridLayout({ sessions: [opening, must], bands: [] });
  eq(l.startMin, 540, 'the grid starts at 9 AM');
  eq(blocksOf(l), [['OPENING', 540, 570, 0, 30, 0, 1], ['MUST', 600, 650, 60, 50, 0, 1]]);
  eq(l.pills, []);
  const block = blockOf(l, 'MUST');
  ok(block.item === must, 'the block carries the session itself, for its time, title and room');
  eq([block.item.title, block.item.loc.label], ['MUST title', 'Room MUST']);
});

// ================================================================ singles, pairs and pills

await test('Two sessions that overlap: the two are side by side, each half width, each at its own start time', () => {
  const l = gridLayout({ sessions: [session('MUST', hm(13, 30), hm(14, 30), { priority: MUST }), session('WANT', hm(14), hm(15))], bands: [] });
  eq(l.startMin, 780, 'the grid starts at 1 PM');
  eq(blocksOf(l), [['MUST', 810, 870, 30, 60, 0, 2], ['WANT', 840, 900, 60, 60, 1, 2]]);
  eq(l.pills, []);
});

await test('Two sessions that overlap: the earlier start is on the left; on a tie the higher priority, then the code', () => {
  const cols = sessions => blocksOf(gridLayout({ sessions, bands: [] })).map(b => [b[0], b[5], b[6]]);
  eq(cols([session('MUST', hm(14), hm(15), { priority: MUST }), session('MAYBE', hm(13, 30), hm(14, 30), { priority: MAYBE })]),
    [['MAYBE', 0, 2], ['MUST', 1, 2]], 'an earlier Maybe is left of a later Must');
  eq(cols([session('A-MAYBE', hm(14), hm(15), { priority: MAYBE }), session('Z-MUST', hm(14), hm(15), { priority: MUST })]),
    [['Z-MUST', 0, 2], ['A-MAYBE', 1, 2]], 'same start: the Must is on the left whatever the codes');
  eq(cols([session('BRK202', hm(14), hm(15)), session('BRK101', hm(14), hm(15))]),
    [['BRK101', 0, 2], ['BRK202', 1, 2]], 'same start and priority: by code');
});

await test('Two sessions that only touch: each is a full-width block', () => {
  const l = gridLayout({ sessions: [session('MUST', hm(13, 30), hm(14, 30), { priority: MUST }), session('WANT', hm(14, 30), hm(15, 30))], bands: [] });
  eq(blocksOf(l), [['MUST', 810, 870, 30, 60, 0, 1], ['WANT', 870, 930, 90, 60, 0, 1]]);
  eq(l.pills, []);
});

await test('Two sessions that only touch: one minute of overlap puts them side by side', () => {
  const l = gridLayout({ sessions: [session('MUST', hm(13, 30), hm(14, 30), { priority: MUST }), session('WANT', hm(14, 29), hm(15, 29))], bands: [] });
  eq(blocksOf(l), [['MUST', 810, 870, 30, 60, 0, 2], ['WANT', 869, 929, 89, 60, 1, 2]]);
  eq(l.pills, []);
});

await test('Three sessions at the same time: one pill at 10:00 with three dots, and no block for any of them', () => {
  const l = gridLayout({ sessions: [session('MUST', hm(10), hm(10, 45), { priority: MUST }), session('MAYBE', hm(10), hm(10, 45), { priority: MAYBE }), session('WANT', hm(10), hm(10, 45))], bands: [] });
  eq(pillsOf(l), [['600', 600, 645, 0, 45, false, 3, '3 sessions at this time', [3, 2, 1], ['MUST', 'WANT', 'MAYBE']]]);
  eq(l.blocks, [], 'none of the three is a block of its own');
});

await test('Three sessions linked by overlaps: one pill from 9:00 to 11:00', () => {
  // Handed in out of order; the first and the third do not overlap each other.
  const l = gridLayout({ sessions: [session('C', hm(10, 15), hm(11)), session('A', hm(9), hm(10)), session('B', hm(9, 30), hm(10, 30))], bands: [] });
  eq(pillsOf(l), [['540', 540, 660, 0, 120, false, 3, '3 sessions at this time', [2, 2, 2], ['A', 'B', 'C']]]);
  eq(l.blocks, []);
});

await test('Three sessions linked by overlaps: two short sessions inside a long one are linked through it', () => {
  const l = gridLayout({ sessions: [session('LONG', hm(9), hm(12)), session('EARLY', hm(9, 30), hm(10)), session('LATE', hm(11), hm(11, 30))], bands: [] });
  eq(pillsOf(l), [['540', 540, 720, 0, 180, false, 3, '3 sessions at this time', [2, 2, 2], ['LONG', 'EARLY', 'LATE']]]);
  eq(l.blocks, []);
});

await test('Three sessions linked by overlaps: a third that only touches the second is not linked', () => {
  const l = gridLayout({ sessions: [session('A', hm(9), hm(10)), session('B', hm(9, 30), hm(10, 30)), session('C', hm(10, 30), hm(11))], bands: [] });
  eq(blocksOf(l), [['A', 540, 600, 0, 60, 0, 2], ['B', 570, 630, 30, 60, 1, 2], ['C', 630, 660, 90, 30, 0, 1]]);
  eq(l.pills, []);
});

await test('A pair and a later single are separate: the first two are side by side and the third is full width', () => {
  const l = gridLayout({ sessions: [session('A', hm(10), hm(10, 45)), session('B', hm(10), hm(10, 45)), session('C', hm(11), hm(11, 45))], bands: [] });
  eq(blocksOf(l), [['A', 600, 645, 0, 45, 0, 2], ['B', 600, 645, 0, 45, 1, 2], ['C', 660, 705, 60, 45, 0, 1]]);
  eq(l.pills, []);
});

await test('Three sessions at the same time: four or five are still one pill, labelled with their number, rows Must first, then by start, then by code', () => {
  // The row order past "Must first" is from the grid.js contract.
  const sessions = [session('B', hm(10, 15), hm(11)), session('Z', hm(10), hm(10, 45)), session('LATE-MUST', hm(10, 30), hm(11, 15), { priority: MUST }), session('A', hm(10), hm(10, 45)), session('MAYBE', hm(10), hm(10, 30), { priority: MAYBE })];
  const l = gridLayout({ sessions, bands: [] });
  eq(pillsOf(l), [['600', 600, 675, 0, 75, false, 5, '5 sessions at this time', [3, 2, 2, 2, 1], ['LATE-MUST', 'A', 'Z', 'B', 'MAYBE']]]);
  eq(l.blocks, []);
  const four = gridLayout({ sessions: sessions.slice(0, 4), bands: [] });
  eq(pillsOf(four), [['600', 600, 675, 0, 75, false, 4, '4 sessions at this time', [3, 2, 2, 2], ['LATE-MUST', 'A', 'Z', 'B']]]);
});

await test('should give blocks, pills and bands each in time order, whatever order they were handed in, and leave that list as it was', () => {
  const sessions = [
    session('SINGLE-4PM', hm(16), hm(16, 45)),
    session('PILL-2PM-A', hm(14), hm(14, 45)), session('PILL-2PM-B', hm(14), hm(14, 45)), session('PILL-2PM-C', hm(14), hm(14, 45)),
    session('PAIR-11-LATE', hm(11, 15), hm(12)),
    session('PILL-9AM-A', hm(9), hm(9, 45)), session('PILL-9AM-B', hm(9), hm(9, 45)), session('PILL-9AM-C', hm(9), hm(9, 45)),
    session('PAIR-11', hm(11), hm(11, 45)),
  ];
  const given = sessions.map(s => s.code);
  const bands = [band('block', 'block:late', 'Booth duty', hm(17), hm(18)), band('lunch', 'lunch', 'Lunch', hm(12, 15), hm(12, 45)), band('block', 'block:early', 'Breakfast', hm(8), hm(8, 30))];
  const l = gridLayout({ sessions, bands });
  eq(l.blocks.map(b => b.item.code), ['PAIR-11', 'PAIR-11-LATE', 'SINGLE-4PM']);
  eq(l.pills.map(p => p.id), ['540', '840']);
  eq(l.bands.map(b => b.key), ['block:early', 'lunch', 'block:late']);
  eq(sessions.map(s => s.code), given, 'the list handed in is as it was');
});

// beyond the feature file: blocked time and lunch are bands. Each is drawn at its own time and
// never makes a pair or a pill, so "N sessions at this time" only counts sessions.
await test('Blocked time and lunch are on the grid: a session at the same time as both stays full width', () => {
  const bands = [band('block', 'block:b', 'Booth duty', hm(11, 45), hm(13)), band('lunch', 'lunch', 'Lunch', hm(12), hm(12, 45))];
  const l = gridLayout({ sessions: [session('ONLY', hm(12), hm(12, 45))], bands });
  eq(l.startMin, 660, 'the grid starts at 11 AM');
  eq(blocksOf(l), [['ONLY', 720, 765, 60, 45, 0, 1]]);
  eq(l.pills, [], 'one session and two bands are not "3 sessions at this time"');
  eq(bandsOf(l), [['block', 'block:b', 'Booth duty', 705, 780, 45, 75], ['lunch', 'lunch', 'Lunch', 720, 765, 60, 45]]);
});

// beyond the feature file: see above.
await test('Blocked time and lunch are on the grid: two sessions over lunch are a pair and three are a pill of three', () => {
  const bands = [band('block', 'block:b', 'Booth duty', hm(11, 45), hm(13)), band('lunch', 'lunch', 'Lunch', hm(12), hm(12, 45))];
  const drawn = [['block', 'block:b', 'Booth duty', 705, 780, 45, 75], ['lunch', 'lunch', 'Lunch', 720, 765, 60, 45]];
  const three = [session('A', hm(12), hm(12, 45)), session('B', hm(12), hm(12, 45)), session('C', hm(12), hm(12, 45))];
  const pair = gridLayout({ sessions: three.slice(0, 2), bands });
  eq(blocksOf(pair), [['A', 720, 765, 60, 45, 0, 2], ['B', 720, 765, 60, 45, 1, 2]]);
  eq(pair.pills, [], 'two sessions and two bands are not a pill');
  eq(bandsOf(pair), drawn, 'both bands are drawn at their own times');
  const pill = gridLayout({ sessions: three, bands });
  eq(pillsOf(pill), [['720', 720, 765, 60, 45, false, 3, '3 sessions at this time', [2, 2, 2], ['A', 'B', 'C']]], 'the pill counts three and runs over its sessions, not the blocked time');
  eq(pill.blocks, []);
  eq(bandsOf(pill), drawn);
});

// ================================================================ opening and closing a pill

// A session at 9:00 so the grid starts at 9 AM, a pill of a Must, a Want and a Maybe from 10:00
// to 10:45, and a Must from 11:00 to 11:45: the Background of "An open pill pushes everything
// after it down".
function background(more = []) {
  return { bands: [], sessions: [
    session('OPENING', hm(9), hm(9, 30)),
    session('P-MAYBE', hm(10), hm(10, 45), { priority: MAYBE }), session('P-MUST', hm(10), hm(10, 45), { priority: MUST }), session('P-WANT', hm(10), hm(10, 45)),
    session('MUST', hm(11), hm(11, 45), { priority: MUST }),
    ...more,
  ] };
}
const PILL_10 = '600';
const ROWS = ['P-MUST', 'P-WANT', 'P-MAYBE'];

await test('Opening a pill: it shows three rows, Must first, then Want, then Maybe, each with its title and room', () => {
  const entries = background();
  const [maybe, must, want] = entries.sessions.slice(1, 4);
  const collapsed = pillAt(gridLayout(entries), PILL_10);
  eq([collapsed.open, collapsed.count, collapsed.height], [false, 3, 45], 'precondition: a collapsed pill of three');
  const opened = pillAt(gridLayout(entries, [PILL_10]), PILL_10);
  eq([opened.open, opened.count, opened.dots], [true, 3, [3, 2, 1]]);
  same(opened.rows, [must, want, maybe], 'rows');
  eq(opened.rows.map(r => [r.title, r.loc.label]), [['P-MUST title', 'Room P-MUST'], ['P-WANT title', 'Room P-WANT'], ['P-MAYBE title', 'Room P-MAYBE']]);
});

await test('Opening a pill: the open pills can be given as a list or a set, and an id with no pill changes nothing', () => {
  const collapsed = gridLayout(background());
  eq(pillsOf(collapsed), [[PILL_10, 600, 645, 60, 45, false, 3, '3 sessions at this time', [3, 2, 1], ROWS]], 'precondition: one collapsed pill at 10:00');
  const opened = [[PILL_10, 600, 645, 60, 164, true, 3, '3 sessions at this time', [3, 2, 1], ROWS]];
  eq(pillsOf(gridLayout(background(), [PILL_10])), opened, 'a list');
  eq(pillsOf(gridLayout(background(), new Set([PILL_10]))), opened, 'a set');
  eq(pillsOf(gridLayout(background(), ['660', PILL_10, 'nonsense'])), opened, 'beside ids that are not pills');
  // 660 is the start of the single Must, 540 of the opening session: neither is a pill.
  eq(everything(gridLayout(background(), ['660', '540', 'nonsense'])), everything(collapsed), 'only ids that are not pills');
  eq(collapsed.height, 180, 'and that unchanged layout is the collapsed one');
});

await test('Closing a pill: it is one pill that says "3 sessions at this time" again', () => {
  const opened = gridLayout(background(), [PILL_10]);
  eq(pillsOf(opened), [[PILL_10, 600, 645, 60, 164, true, 3, '3 sessions at this time', [3, 2, 1], ROWS]], 'precondition: an open pill at 10:00');
  const closed = gridLayout(background(), []);
  eq(pillsOf(closed), [[PILL_10, 600, 645, 60, 45, false, 3, '3 sessions at this time', [3, 2, 1], ROWS]]);
  eq(closed.blocks.map(b => b.item.code), ['OPENING', 'MUST'], 'and its sessions are still not blocks of their own');
});

await test('Changing day closes open pills: a layout asked for without open pills has every pill collapsed', () => {
  const entries = background([session('Q-A', hm(13), hm(13, 45)), session('Q-B', hm(13), hm(13, 45)), session('Q-C', hm(13), hm(13, 45))]);
  eq(gridLayout(entries, [PILL_10, '780']).pills.map(p => [p.id, p.open, p.height]), [[PILL_10, true, 164], ['780', true, 164]], 'precondition: both pills were open');
  eq(gridLayout(entries).pills.map(p => [p.id, p.open, p.height]), [[PILL_10, false, 45], ['780', false, 45]], 'nothing is remembered from the layout before');
});

// ================================================================ an open pill pushes the rest down

await test('Collapsed, everything is at its real time: the pill is 45 tall, the 11 AM line and the Must are 120 down', () => {
  const l = gridLayout(background());
  eq(l.startMin, 540, 'the grid starts at 9 AM');
  const pill = pillAt(l, PILL_10);
  eq([pill.open, pill.height], [false, 45]);
  eq(hourLine(l, '11 AM').top, 120);
  eq(blockOf(l, 'MUST').top, 120);
  eq(everything(l), {
    startMin: 540, endMin: 720, height: 180,
    hours: [[540, '9 AM', 0], [600, '10 AM', 60], [660, '11 AM', 120], [720, '12 PM', 180]],
    blocks: [['OPENING', 540, 570, 0, 30, 0, 1], ['MUST', 660, 705, 120, 45, 0, 1]],
    pills: [[PILL_10, 600, 645, 60, 45, false, 3, '3 sessions at this time', [3, 2, 1], ROWS]],
    bands: [],
  });
});

await test('Open, later sessions and hour lines move by the same amount: the pill is 164 tall, the 11 AM line and the Must are 239 down, the grid 119 taller', () => {
  const collapsed = gridLayout(background()), l = gridLayout(background(), [PILL_10]);
  eq(l.startMin, 540, 'the grid starts at 9 AM');
  eq([PILL_HEADER, PILL_ROW], [32, 44], 'an open pill is 32 units of header plus 44 units per row');
  const pill = pillAt(l, PILL_10);
  eq([pill.open, pill.height], [true, 164]);
  eq(hourLine(l, '11 AM').top, 239);
  eq(blockOf(l, 'MUST').top, 239);
  eq([collapsed.height, l.height, l.height - collapsed.height], [180, 299, 119]);
  eq(everything(l), {
    startMin: 540, endMin: 720, height: 299,
    hours: [[540, '9 AM', 0], [600, '10 AM', 60], [660, '11 AM', 239], [720, '12 PM', 299]],
    blocks: [['OPENING', 540, 570, 0, 30, 0, 1], ['MUST', 660, 705, 239, 45, 0, 1]],
    pills: [[PILL_10, 600, 645, 60, 164, true, 3, '3 sessions at this time', [3, 2, 1], ROWS]],
    bands: [],
  });
});

await test('Nothing before the end of the pill moves: the 10 AM line and the pill are 60 down', () => {
  const l = gridLayout(background(), [PILL_10]);
  eq(l.startMin, 540, 'the grid starts at 9 AM');
  eq([pillAt(l, PILL_10).open, hourLine(l, '11 AM').top], [true, 239], 'precondition: the pill is open and what follows it has moved');
  eq(hourLine(l, '10 AM').top, 60);
  eq(pillAt(l, PILL_10).top, 60);
  eq([hourLine(l, '9 AM').top, blockOf(l, 'OPENING').top, blockOf(l, 'OPENING').height], [0, 0, 30], 'nor does anything earlier');
});

await test('A time just inside the pill does not move; its end does: 10:44 is 104 down and 10:45 is 224 down', () => {
  const collapsed = gridLayout(background()), l = gridLayout(background(), [PILL_10]);
  eq([l.startMin, pillAt(l, PILL_10).open], [540, true], 'the grid starts at 9 AM and the pill is open');
  eq(l.y(hm(10, 44)), 104);
  eq(l.y(hm(10, 45)), 224);
  eq([l.y(hm(9)), l.y(hm(10)), l.y(hm(11)), l.y(hm(12))], [0, 60, 239, 299], 'the start, the pill\'s start, and the hours after it');
  eq([collapsed.y(hm(10, 44)), collapsed.y(hm(10, 45)), collapsed.y(hm(11))], [104, 105, 120], 'collapsed, the same minutes are a unit apart');
});

await test('Closing the pill puts everything back: the 11 AM line and the Must are 120 down again', () => {
  const opened = gridLayout(background(), [PILL_10]);
  eq([opened.startMin, pillAt(opened, PILL_10).open, hourLine(opened, '11 AM').top, blockOf(opened, 'MUST').top, opened.height], [540, true, 239, 239, 299], 'precondition: the pill is open');
  const l = gridLayout(background(), []);
  eq(hourLine(l, '11 AM').top, 120);
  eq(blockOf(l, 'MUST').top, 120);
  eq([pillAt(l, PILL_10).open, pillAt(l, PILL_10).height, l.height, l.y(hm(10, 45))], [false, 45, 180, 105]);
});

// The Background plus a second pill of three from 1:00 to 1:45 and a Want from 2:00 to 2:45.
const twoPills = () => background([session('Q-A', hm(13), hm(13, 45)), session('Q-B', hm(13), hm(13, 45)), session('Q-C', hm(13), hm(13, 45)), session('WANT', hm(14), hm(14, 45))]);
const PILL_1PM = '780';

await test('Two open pills add up: the Want starts 538 units down', () => {
  const l = gridLayout(twoPills(), [PILL_10, PILL_1PM]);
  eq(l.startMin, 540, 'the grid starts at 9 AM');
  eq(l.pills.map(p => [p.id, p.open, p.count, p.top, p.height]), [[PILL_10, true, 3, 60, 164], [PILL_1PM, true, 3, 359, 164]], 'both pills are open');
  eq(blockOf(l, 'WANT').top, 538);
  eq([blockOf(l, 'MUST').top, hourLine(l, '1 PM').top, hourLine(l, '2 PM').top, l.height], [239, 359, 538, 598]);
});

await test('Two open pills add up: each open pill moves only what comes after it', () => {
  const tops = openIds => { const l = gridLayout(twoPills(), openIds); return [blockOf(l, 'MUST').top, pillAt(l, PILL_1PM).top, blockOf(l, 'WANT').top, l.height]; };
  eq(tops([]), [120, 240, 300, 360], 'both collapsed: every start is at its real time');
  eq(tops([PILL_10]), [239, 359, 419, 479], 'only the 10:00 pill open');
  eq(tops([PILL_1PM]), [120, 240, 419, 479], 'only the 1:00 pill open');
  eq(tops([PILL_1PM, PILL_10]), [239, 359, 538, 598], 'both open');
});

await test('Open, later sessions and hour lines move by the same amount: a pill of four is 32 plus four rows of 44', () => {
  const sessions = [session('A', hm(10), hm(10, 45)), session('B', hm(10), hm(10, 45)), session('C', hm(10), hm(10, 45)), session('D', hm(10), hm(10, 45)), session('NEXT', hm(11), hm(11, 45))];
  const collapsed = gridLayout({ sessions, bands: [] }), l = gridLayout({ sessions, bands: [] }, [PILL_10]);
  eq([collapsed.startMin, pillAt(collapsed, PILL_10).height, blockOf(collapsed, 'NEXT').top, collapsed.height], [600, 45, 60, 120], 'precondition: collapsed, on a grid that starts at 10 AM');
  eq([pillAt(l, PILL_10).label, pillAt(l, PILL_10).height, blockOf(l, 'NEXT').top, l.height], ['4 sessions at this time', 208, 223, 283]);
});

await test('Open, later sessions and hour lines move by the same amount: blocked time and lunch move too, and a band across the end of the pill stretches', () => {
  const entries = () => ({ ...background(), bands: [band('block', 'block:b', 'Booth duty', hm(10, 30), hm(11, 30)), band('lunch', 'lunch', 'Lunch', hm(12), hm(12, 45))] });
  const collapsed = gridLayout(entries()), l = gridLayout(entries(), [PILL_10]);
  eq(bandsOf(collapsed), [['block', 'block:b', 'Booth duty', 630, 690, 90, 60], ['lunch', 'lunch', 'Lunch', 720, 765, 180, 45]], 'precondition: collapsed, each band is at its real time');
  eq(bandsOf(l), [['block', 'block:b', 'Booth duty', 630, 690, 90, 179], ['lunch', 'lunch', 'Lunch', 720, 765, 299, 45]]);
  eq([collapsed.height, l.height], [240, 359]);
  eq(pillsOf(l), [[PILL_10, 600, 645, 60, 164, true, 3, '3 sessions at this time', [3, 2, 1], ROWS]], 'the band is not one of the pill\'s sessions');
});

// ================================================================ a pill taller than its list

await test('Three sessions spread over three hours: the open pill is 180 units tall and the Must starts 180 units down', () => {
  const sessions = () => [session('A', hm(9), hm(10, 30)), session('B', hm(10), hm(11, 30)), session('C', hm(11), hm(12)), session('MUST', hm(12), hm(12, 45), { priority: MUST })];
  const l = gridLayout({ sessions: sessions(), bands: [] }, ['540']);
  eq(l.startMin, 540, 'the grid starts at 9 AM');
  eq(pillsOf(l), [['540', 540, 720, 0, 180, true, 3, '3 sessions at this time', [2, 2, 2], ['A', 'B', 'C']]]);
  eq(blocksOf(l), [['MUST', 720, 765, 180, 45, 0, 1]]);
  eq(hoursOf(l), [[540, '9 AM', 0], [600, '10 AM', 60], [660, '11 AM', 120], [720, '12 PM', 180], [780, '1 PM', 240]]);
  eq(l.height, 240);
  const collapsed = gridLayout({ sessions: sessions(), bands: [] });
  eq([pillAt(collapsed, '540').open, pillAt(collapsed, '540').height, blockOf(collapsed, 'MUST').top, collapsed.height], [false, 180, 180, 240], 'collapsed, it is the same day');
});

await test('Three sessions spread over three hours: a pill exactly as tall as its list moves nothing, one a minute shorter moves the rest by one', () => {
  // The list of three is 164 units: 32 of header and three rows of 44.
  const day = minutes => {
    const sessions = [session('A', hm(9), hm(9) + minutes), session('B', hm(9), hm(9) + minutes), session('C', hm(9), hm(9) + minutes), session('NEXT', hm(12), hm(12, 30))];
    const collapsed = gridLayout({ sessions, bands: [] }), opened = gridLayout({ sessions, bands: [] }, ['540']);
    return [pillAt(collapsed, '540').height, blockOf(collapsed, 'NEXT').top, pillAt(opened, '540').open, pillAt(opened, '540').height, blockOf(opened, 'NEXT').top, opened.height];
  };
  eq(day(163), [163, 180, true, 164, 181, 241], 'a minute shorter than its list');
  eq(day(164), [164, 180, true, 164, 180, 240], 'exactly as long as its list');
  eq(day(165), [165, 180, true, 165, 180, 240], 'a minute longer than its list');
});

// ================================================================ what a tap needs

await test('Tapping a full-width block: the block carries session BRK101 itself, key included', () => {
  const brk = session('BRK101', hm(10), hm(10, 45)), other = session('OTHER', hm(11), hm(11, 45));
  const l = gridLayout({ sessions: [brk, other], bands: [] });
  eq(l.blocks.map(b => [b.item.key, b.cols]), [['key:BRK101', 1], ['key:OTHER', 1]]);
  ok(blockOf(l, 'BRK101').item === brk, 'the block\'s item is not the session that was given');
  eq(l.pills, []);
});

await test('Tapping one of a side-by-side pair: each half carries its own session, key included', () => {
  const brk = session('BRK101', hm(10), hm(10, 45)), other = session('OTHER', hm(10), hm(10, 45));
  const l = gridLayout({ sessions: [other, brk], bands: [] });
  eq(blocksOf(l).map(b => [b[0], b[5], b[6]]), [['BRK101', 0, 2], ['OTHER', 1, 2]]);
  eq(l.blocks.map(b => b.item.key).sort(), ['key:BRK101', 'key:OTHER']);
  ok(blockOf(l, 'BRK101').item === brk && blockOf(l, 'OTHER').item === other, 'a block\'s item is not the session that was given');
  eq(l.pills, []);
});

await test('Tapping a row in an open pill: each row is its session, key included, and nothing else stands for it', () => {
  const brk = session('BRK101', hm(10), hm(10, 45), { priority: MUST }), b = session('OTHER-B', hm(10), hm(10, 45)), c = session('OTHER-C', hm(10), hm(10, 45));
  const l = gridLayout({ sessions: [c, b, brk], bands: [] }, [PILL_10]);
  eq(l.pills.map(p => [p.id, p.open, p.rows.map(r => r.key)]), [[PILL_10, true, ['key:BRK101', 'key:OTHER-B', 'key:OTHER-C']]]);
  same(pillAt(l, PILL_10).rows, [brk, b, c], 'rows');
  eq(l.blocks, [], 'BRK101 is reached through its row only');
});

await test('Blocked time and lunch have no details: a band carries no session, and no block or pill row stands for one', () => {
  const brk = session('BRK101', hm(10), hm(10, 45));
  const entries = gridEntries({ items: [brk], blocks: [blockedTime('b1', 'Booth duty', TUE, hm(10), hm(11))], lunch: { start: hm(12), end: hm(12, 45) }, day: TUE });
  entriesAre(entries, [brk], ['block:b1', 'lunch'], 'what is on the grid');
  const l = gridLayout(entries);
  eq(bandsOf(l), [['block', 'block:b1', 'Booth duty', 600, 660, 0, 60], ['lunch', 'lunch', 'Lunch', 720, 765, 120, 45]], 'the grid shows blocked time and lunch');
  eq(l.bands.map(b => ['item' in b, 's' in b, b.kind]), [[false, false, 'block'], [false, false, 'lunch']], 'neither carries a session to open');
  eq(l.blocks.map(b => b.item.key), ['key:BRK101'], 'the only block is the session');
  eq(l.pills, []);
});

// ================================================================ a band's label stays readable
// beyond the feature file: blocked time and lunch never join a pair or a pill, so a session or
// pill can be drawn over one. A band's label is the first BAND_LABEL units of the band, at its
// right edge. Whatever is drawn over that at the right edge is marked `lane` and so is the band:
// the page then stops the session short of the right edge and the label is read beside it.

const lanes = l => ({ blocks: blocksOf(l).map(b => [b[0], blockOf(l, b[0]).lane]), pills: l.pills.map(p => [p.id, p.lane]), bands: l.bands.map(b => [b.key, b.lane]) });
const booth = (start, end) => band('block', 'block:booth', 'Booth duty', start, end);

await test('should mark a session that starts with blocked time, and the band, as sharing the row; not one that starts after the label', () => {
  eq(BAND_LABEL, 15);
  const at = start => lanes(gridLayout({ sessions: [session('A', start, start + 45)], bands: [booth(hm(11), hm(12))] }));
  eq(at(hm(11)), { blocks: [['A', true]], pills: [], bands: [['block:booth', true]] }, 'starting together');
  eq(at(hm(11, 14)), { blocks: [['A', true]], pills: [], bands: [['block:booth', true]] }, 'starting in the last unit of the label');
  eq(at(hm(11, 15)), { blocks: [['A', false]], pills: [], bands: [['block:booth', false]] }, 'starting just under the label');
  eq(at(hm(10, 16)), { blocks: [['A', true]], pills: [], bands: [['block:booth', true]] }, 'ending one unit into the label');
  eq(at(hm(10, 15)), { blocks: [['A', false]], pills: [], bands: [['block:booth', false]] }, 'ending where the band starts');
});

await test('should mark a pill drawn over the label of blocked time or lunch, closed or open', () => {
  const sessions = [session('A', hm(10), hm(10, 45), { priority: MUST }), session('B', hm(10), hm(10, 45)), session('C', hm(10), hm(10, 45), { priority: MAYBE })];
  const bands = [booth(hm(10), hm(10, 45)), band('lunch', 'lunch', 'Lunch', hm(12), hm(12, 45))];
  const expected = { blocks: [], pills: [['600', true]], bands: [['block:booth', true], ['lunch', false]] };
  eq(lanes(gridLayout({ sessions, bands })), expected, 'closed');
  eq(lanes(gridLayout({ sessions, bands }, ['600'])), expected, 'open');
  eq(lanes(gridLayout({ sessions, bands: [band('lunch', 'lunch', 'Lunch', hm(10, 30), hm(11, 15))] })), { blocks: [], pills: [['600', true]], bands: [['lunch', true]] }, 'lunch that starts inside the pill');
  eq(lanes(gridLayout({ sessions, bands: [band('lunch', 'lunch', 'Lunch', hm(10, 45), hm(11, 30))] })), { blocks: [], pills: [['600', false]], bands: [['lunch', false]] }, 'lunch that starts where the pill ends');
});

await test('should mark both halves of a pair when the right half is over the label, and neither when only the left half is', () => {
  const meeting = band('block', 'block:m', 'Customer meeting', hm(14), hm(16));
  // The right half is the later start. Here it starts with the band.
  const right = gridLayout({ sessions: [session('EARLY', hm(13, 30), hm(14, 30)), session('LATE', hm(14), hm(15))], bands: [meeting] });
  eq(blocksOf(right).map(b => [b[0], b[5], b[6]]), [['EARLY', 0, 2], ['LATE', 1, 2]], 'precondition: a pair, LATE on the right');
  eq(lanes(right), { blocks: [['EARLY', true], ['LATE', true]], pills: [], bands: [['block:m', true]] });
  // Here only the left half is over the label: the right half starts 30 units below it.
  const left = gridLayout({ sessions: [session('EARLY', hm(14), hm(15)), session('LATE', hm(14, 30), hm(15, 30))], bands: [meeting] });
  eq(blocksOf(left).map(b => [b[0], b[5], b[6]]), [['EARLY', 0, 2], ['LATE', 1, 2]], 'precondition: a pair, LATE on the right');
  eq(lanes(left), { blocks: [['EARLY', false], ['LATE', false]], pills: [], bands: [['block:m', false]] });
});

await test('should take a band shorter than a label as all label, and mark nothing when there are no bands', () => {
  const short = band('block', 'block:s', 'Call', hm(10), hm(10, 10));
  const at = start => lanes(gridLayout({ sessions: [session('A', start, hm(11))], bands: [short] }));
  eq(at(hm(10, 9)), { blocks: [['A', true]], pills: [], bands: [['block:s', true]] }, 'starting in the last unit of the band');
  eq(at(hm(10, 10)), { blocks: [['A', false]], pills: [], bands: [['block:s', false]] }, 'starting where the band ends');
  const none = gridLayout({ sessions: [session('A', hm(9), hm(10)), session('P1', hm(11), hm(12)), session('P2', hm(11), hm(12)), session('P3', hm(11), hm(12)), session('H1', hm(13), hm(14)), session('H2', hm(13), hm(14))], bands: [] });
  eq(lanes(none), { blocks: [['A', false], ['H1', false], ['H2', false]], pills: [['660', false]], bands: [] });
});

// ================================================================ gaps found by mutation checks
// beyond the feature file: edges the scenarios do not print. Expected numbers are worked out by
// hand: a pill of three is 32 + 3 * 44 = 164 tall open, so one that runs 60 minutes (10:00 to
// 11:00) adds 164 - 60 = 104 to everything at or after 11:00.

const three = (start, end, prefix = '') => ['A', 'B', 'C'].map(c => session(prefix + c, start, end));

await test('Open, later sessions and hour lines move by the same amount: a pill that ends on the last hour makes the grid 164 tall, with the 11 AM line 164 down', () => {
  const l = gridLayout({ sessions: three(hm(10), hm(11)), bands: [] }, [PILL_10]);
  eq([l.startMin, l.endMin], [600, 660], 'precondition: the grid is 10 AM to 11 AM');
  eq(pillsOf(l), [[PILL_10, 600, 660, 0, 164, true, 3, '3 sessions at this time', [2, 2, 2], ['A', 'B', 'C']]], 'precondition: the pill is open and 164 tall');
  eq(l.height, 164);
  eq(hoursOf(l), [[600, '10 AM', 0], [660, '11 AM', 164]]);
  eq(gridLayout({ sessions: three(hm(10), hm(11)), bands: [] }).height, 60, 'collapsed, the same day is 60 tall');
});

await test('Open, later sessions and hour lines move by the same amount: a session and a band that start where the pill ends are 164 down', () => {
  const l = gridLayout({ sessions: [...three(hm(10), hm(11)), session('NEXT', hm(11), hm(12))], bands: [band('lunch', 'lunch', 'Lunch', hm(11), hm(11, 45))] }, [PILL_10]);
  eq(pillAt(l, PILL_10).height, 164, 'precondition: the pill is open');
  eq(blocksOf(l), [['NEXT', 660, 720, 164, 60, 0, 1]]);
  eq(bandsOf(l), [['lunch', 'lunch', 'Lunch', 660, 705, 164, 45]]);
  eq(l.height, 224);
});

await test('Open, later sessions and hour lines move by the same amount: a band that ends where the pill ends stretches over all of it', () => {
  const l = gridLayout({ sessions: three(hm(10), hm(11)), bands: [band('block', 'block:b', 'Booth duty', hm(9), hm(11))] }, [PILL_10]);
  eq(pillAt(l, PILL_10).height, 164, 'precondition: the pill is open');
  eq(bandsOf(l), [['block', 'block:b', 'Booth duty', 540, 660, 0, 224]]);
  eq(pillAt(l, PILL_10).top, 60, 'and the pill is 60 down on the grid that starts at 9 AM');
});

await test('Open, later sessions and hour lines move by the same amount: a second pill that starts where the open pill ends is 164 down', () => {
  const l = gridLayout({ sessions: [...three(hm(10), hm(11)), ...three(hm(11), hm(12), 'N-')], bands: [] }, [PILL_10]);
  eq(l.pills.map(p => [p.id, p.open, p.top, p.height]), [[PILL_10, true, 0, 164], ['660', false, 164, 60]]);
  eq(l.height, 224);
});

await test('Two sessions that overlap: the pair is ordered by start, not by end', () => {
  const long = session('LONG', hm(10), hm(11, 30)), short = session('SHORT', hm(10, 30), hm(11));
  const l = gridLayout({ sessions: [short, long], bands: [] });
  eq(blocksOf(l), [['LONG', 600, 690, 0, 90, 0, 2], ['SHORT', 630, 660, 30, 30, 1, 2]]);
});

await test('Blocked time and lunch are on the grid: bands are ordered by start when one is inside another', () => {
  const entries = gridEntries({ items: [], blocks: [blockedTime('long', 'All afternoon', TUE, hm(11), hm(14))], lunch: { start: hm(12), end: hm(12, 45) }, day: TUE });
  eq(entries.bands.map(b => [b.kind, b.startMin, b.endMin]), [['block', 660, 840], ['lunch', 720, 765]]);
  eq(entries.sessions, [], 'neither is a session');
});

await test('Picks that start and end between hours: a day that runs to midnight ends on a 12 AM line', () => {
  const l = gridLayout({ sessions: [session('LATE', hm(22, 30), hm(23, 30))], bands: [] });
  eq(hoursOf(l), [[1320, '10 PM', 0], [1380, '11 PM', 60], [1440, '12 AM', 120]]);
});

await test('Two sessions that overlap: on a tie of start and priority the order is the code, not the title or the key', () => {
  // Order by code is A, B; by title Alpha (B) before Zeta (A); by key k1 (B) before k2 (A).
  const b = session('B', hm(14), hm(15), { title: 'Alpha', key: 'k1' }), a = session('A', hm(14), hm(15), { title: 'Zeta', key: 'k2' });
  eq(blocksOf(gridLayout({ sessions: [b, a], bands: [] })).map(x => [x[0], x[5], x[6]]), [['A', 0, 2], ['B', 1, 2]]);
});

await test('Three sessions at the same time: tied rows are in code order, not title or key order', () => {
  // By code A, B, C; by title B (Alpha), C (Beta), A (Zeta); by key B (k1), C (k2), A (k3).
  const sessions = [session('B', hm(10), hm(10, 45), { title: 'Alpha', key: 'k1' }), session('C', hm(10), hm(10, 45), { title: 'Beta', key: 'k2' }), session('A', hm(10), hm(10, 45), { title: 'Zeta', key: 'k3' })];
  eq(pillAt(gridLayout({ sessions, bands: [] }), PILL_10).rows.map(r => r.code), ['A', 'B', 'C']);
});

await test('Blocked time and lunch are on the grid: a band is exactly kind, key, title and the times, from the blocked time\'s key and title', () => {
  const b = { ...blockedTime('x', 'Booth duty', TUE, hm(11), hm(12)), key: 'block:KEY', id: 'block:ID', code: 'CODE' };
  const entries = gridEntries({ items: [], blocks: [b], lunch: { start: hm(12), end: hm(12, 45) }, day: TUE });
  eq(entries.bands, [
    { kind: 'block', key: 'block:KEY', title: 'Booth duty', startMin: 660, endMin: 720 },
    { kind: 'lunch', key: 'lunch', title: 'Lunch', startMin: 720, endMin: 765 },
  ]);
  eq(entries.bands.map(x => Object.keys(x).sort()), [['endMin', 'key', 'kind', 'startMin', 'title'], ['endMin', 'key', 'kind', 'startMin', 'title']], 'no other field comes along');
  eq(entries.sessions, [], 'neither is a session');
});

await test('Blocked time and lunch are on the grid: a laid-out band is exactly kind, key, title, the times, top, height and lane, whatever else it was handed', () => {
  const handed = { kind: 'block', key: 'k', title: 't', startMin: 600, endMin: 660, item: { code: 'X' }, pseudo: 'block' };
  const l = gridLayout({ sessions: [], bands: [handed] });
  eq(l.bands, [{ kind: 'block', key: 'k', title: 't', startMin: 600, endMin: 660, top: 0, height: 60, lane: false }]);
  eq(Object.keys(l.bands[0]).sort(), ['endMin', 'height', 'key', 'kind', 'lane', 'startMin', 'title', 'top']);
});

await test('A pick without a time is not on the grid: an entry that is null, or whose end is a numeric string, is skipped and the good ones stay', () => {
  const a = session('A', hm(10), hm(10, 45)), str = session('STR', 600, '660'), ok2 = session('OK', hm(11), hm(12));
  const booth = blockedTime('b', 'Booth', TUE, hm(11), hm(12));
  const entries = gridEntries({ items: [null, a, undefined, str, ok2], blocks: [undefined, booth, null], day: TUE });
  same(entries.sessions, [a, ok2], 'sessions');
  eq(entries.bands.map(b => b.key), ['block:b'], 'bands');
});

await test('A pick without a time is not on the grid: items, dropped, blocks, sessions and bands that are not lists are ignored, and the lists beside them are used', () => {
  const a = session('A', hm(10), hm(10, 45)), booth = blockedTime('b', 'Booth', TUE, hm(11), hm(12));
  eq(gridEntries({ items: 'junk', dropped: {}, blocks: 5, lunch: null, day: TUE }), { sessions: [], bands: [] });
  entriesAre(gridEntries({ items: [a], dropped: {}, blocks: 5, day: TUE }), [a], [], 'items beside junk dropped and blocks');
  entriesAre(gridEntries({ items: 'junk', blocks: [booth], day: TUE }), [], ['block:b'], 'blocks beside junk items');
  ok(gridLayout({ sessions: {}, bands: 'x' }) === null, 'nothing drawable gives null');
  eq(blocksOf(gridLayout({ sessions: [a], bands: 'x' })), [['A', 600, 645, 0, 45, 0, 1]], 'sessions beside junk bands');
  eq(bandsOf(gridLayout({ sessions: {}, bands: [band('lunch', 'lunch', 'Lunch', hm(12), hm(12, 45))] })), [['lunch', 'lunch', 'Lunch', 720, 765, 0, 45]], 'bands beside junk sessions');
});

await test('A pick without a time is not on the grid: asking for entries with no argument or no items still answers', () => {
  eq(gridEntries(), { sessions: [], bands: [] });
  const booth = blockedTime('b', 'Booth', TUE, hm(11), hm(12));
  entriesAre(gridEntries({ blocks: [booth], day: TUE }), [], ['block:b'], 'no items: the blocked time is still there');
});

await test('A pick the plan dropped is still on the grid: a dropped entry that is null, has no reason or is a repeat of nothing is skipped, the real repeat still applies', () => {
  const a = session('A', hm(10), hm(10, 45)), b = session('B', hm(11), hm(11, 45));
  const dropped = [null, { item: b }, { reason: { kind: 'repeat' } }, { item: a, reason: { kind: 'repeat' } }];
  entriesAre(gridEntries({ items: [a, b], dropped, day: TUE }), [b], [], 'A is given up for another run, B and the junk change nothing');
});

await test('Two sessions that overlap: codes that are numbers are ordered as text, and nothing throws', () => {
  // As text "10" comes before "7".
  const l = gridLayout({ sessions: [session(7, hm(10), hm(10, 45)), session(10, hm(10), hm(10, 45))], bands: [] });
  eq(blocksOf(l).map(x => [x[0], x[5], x[6]]), [[10, 0, 2], [7, 1, 2]]);
});

await test('Opening a pill: an id that is the end minute of a pill, not its id, opens nothing', () => {
  const sessions = three(hm(10), hm(10, 45));
  const stray = pillAt(gridLayout({ sessions, bands: [] }, ['645']), PILL_10);
  eq([stray.open, stray.height], [false, 45]);
  const real = pillAt(gridLayout({ sessions, bands: [] }, ['645', PILL_10]), PILL_10);
  eq([real.open, real.height], [true, 164], 'the pill\'s own id does open it');
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} test(s) failed`);
