// Clash cards per time slot and the ranking of their options (specs/features/clash-ranking.feature).
// Run with: node tests/clash.test.js

import { slotGroups, rankOptions, rankTie, missHeadline, optionCost, missReasons } from '../assets/js/clash.js';
import { DEFAULT_PLANNER, compareOptions, optimize } from '../assets/js/planner.js';
import { parseLocation } from '../assets/js/venue.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
}

const W = parseLocation('Moscone West, Level 2, Room 2001');
const S = parseLocation('Moscone South, Level 2, Room 209');
const TUE = '2026-11-17', THU = '2026-11-19';
let n = 0;
// A planned run: start/end in minutes; `extra` overrides (id = repeat group, priority 3/2/1, score, locked, reserved, recorded).
function item(start, end, extra = {}) {
  n++;
  return { key: `k${n}`, id: `s${n}`, code: `BRK${n}`, title: `T${n}`, type: 'Breakout', day: TUE, startMin: start, endMin: end,
    loc: W, recorded: null, priority: 2, locked: false, reserved: false, ...extra };
}
const H = h => Math.round(h * 60);
const ctx = DEFAULT_PLANNER;
const codes = list => list.map(x => x.code);

// ---- slots

test('should put a late starter that overlaps only placed picks on their card', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(15.25), { code: 'B' }), c = item(H(15.08), H(15.83), { code: 'C' });
  const slots = slotGroups([c, b, a], ctx);
  eq(slots.map(s => [s.day, s.start, s.end, codes(s.items)]), [[TUE, H(14), H(15.83), ['A', 'B', 'C']]]);
  eq(slots.map(s => s.resolved), [false]);
});
test('should give two later picks that overlap each other their own card', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(15.25), { code: 'B' });
  const d = item(H(15.08), H(15.83), { code: 'D' }), e = item(H(15.17), H(15.67), { code: 'E' });
  const slots = slotGroups([e, d, b, a], ctx);
  eq(slots.map(s => [s.start, codes(s.items)]), [[H(14), ['A', 'B']], [H(15.08), ['D', 'E']]]);
});
test('should attach a lone late starter to the card it overlaps most', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(14.75), { code: 'B' });
  const d = item(H(14.5), H(15.5), { code: 'D' }), e = item(H(14.5), H(15.5), { code: 'E' }), f = item(H(14.5), H(15.5), { code: 'F' });
  const late = item(H(15.25), H(16), { code: 'LATE' });
  const slots = slotGroups([a, b, d, e, f, late], ctx);
  eq(slots.map(s => codes(s.items)), [['A', 'B', 'D', 'E', 'F', 'LATE']], 'D, E, F overlap A so they are on its card; LATE overlaps three of them');
  const g = item(H(16), H(16.5), { code: 'G' }), h = item(H(16), H(16.5), { code: 'H' }), late2 = item(H(16.25), H(17), { code: 'LATE2' });
  eq(slotGroups([a, b, g, h, late2], ctx).map(s => codes(s.items)), [['A', 'B'], ['G', 'H', 'LATE2']], 'LATE2 overlaps the later card only');
});
test('should leave out a pick that overlaps nothing', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(14.75), { code: 'B' }), lone = item(H(16), H(16.75), { code: 'LONE' });
  eq(slotGroups([a, b, lone], ctx).map(s => codes(s.items)), [['A', 'B']]);
});
test('should keep runs of the same session out of one slot and keep days apart', () => {
  const a = item(H(14), H(14.75), { code: 'A', id: 'g' }), a2 = item(H(14), H(14.75), { code: 'A-R1', id: 'g' });
  const b = item(H(14), H(14.75), { code: 'B' }), thu = item(H(14), H(14.75), { code: 'THU', day: THU }), thu2 = item(H(14), H(14.75), { code: 'THU2', day: THU });
  eq(slotGroups([a, a2, b, thu, thu2], ctx).map(s => [s.day, codes(s.items)]), [[TUE, ['A', 'A-R1', 'B']], [THU, ['THU', 'THU2']]]);
});
test('should put two picks on one card when the walk between them is too long for the gap, and not when it fits', () => {
  const M = parseLocation('Marriott Marquis, Yerba Buena Ballroom, Salon 8');
  const a = item(H(14), H(14.75), { code: 'A', loc: W }), b = item(H(14.75) + 5, H(15.5) + 5, { code: 'B', loc: M });
  eq(slotGroups([a, b], ctx).map(s => [s.start, codes(s.items)]), [[H(14), ['A', 'B']]], 'a 5 min gap for a 13 min walk is a clash');
  const later = item(H(15.25), H(16), { code: 'B2', loc: M });
  eq(slotGroups([a, later], ctx), [], 'a 30 min gap is not');
});
test('should call a slot decided when a lock settles it', () => {
  const a = item(H(14), H(14.75), { code: 'A', locked: true }), b = item(H(14), H(14.75), { code: 'B' });
  eq(slotGroups([a, b], ctx).map(s => s.resolved), [true]);
});

// ---- ranking (no other runs: `runsOf` returns the option alone)

const alone = x => [x];
const rank = (opts, plan = {}, runsOf = alone) => rankOptions(opts, { plan, ctx, runsOf });

test('should rank a reserved seat first, before a Must', () => {
  const want = item(H(14), H(15.25), { code: 'LABR', priority: 2, locked: true, reserved: true }), must = item(H(14), H(14.75), { code: 'MUST', priority: 3 });
  const r = rank([must, want]);
  eq(codes(r.map(o => o.item)), ['LABR', 'MUST']);
  eq(r[0].reasons[0], 'Reserved seat');
});
test('should rank by tier, then score within a tier', () => {
  const must = item(H(14), H(14.75), { code: 'MUST', priority: 3 }), w12 = item(H(14), H(14.75), { code: 'W12', priority: 2, score: 12 }), w6 = item(H(14), H(14.75), { code: 'W6', priority: 2, score: 6 });
  eq(codes(rank([w6, w12, must]).map(o => o.item)), ['MUST', 'W12', 'W6']);
});
test('should rank an unrecorded session above a recorded one of the same tier', () => {
  const rec = item(H(14), H(14.75), { code: 'REC', recorded: true }), live = item(H(14), H(14.75), { code: 'LIVE', recorded: false });
  const r = rank([rec, live]);
  eq(codes(r.map(o => o.item)), ['LIVE', 'REC']);
  eq(r[0].reasons.includes('not recorded'), true);
});
test('should break a tie by the building of the session before or after', () => {
  const west = item(H(14), H(14.75), { code: 'A-WEST', loc: W }), south = item(H(14), H(14.75), { code: 'B-SOUTH', loc: S });
  const before = item(H(13), H(13.75), { code: 'PREV', loc: S });
  const r = rank([west, south], { [TUE]: [before] });
  eq(codes(r.map(o => o.item)), ['B-SOUTH', 'A-WEST']);
  eq(r[0].reasons.includes('same building as the session before'), true);
  eq(codes(rank([west, south]).map(o => o.item)), ['A-WEST', 'B-SOUTH'], 'without a neighbour the order falls back to the code');
});

test('should never call two unknown rooms the same building', () => {
  const U = parseLocation('');
  const a = item(H(14), H(14.75), { code: 'A-TBA', loc: U }), b = item(H(14), H(14.75), { code: 'B-TBA', loc: U });
  const before = item(H(13), H(13.75), { code: 'PREV', loc: U });
  const r = rank([b, a], { [TUE]: [before] });
  eq(codes(r.map(o => o.item)), ['A-TBA', 'B-TBA'], 'the order is the code fallback');
  eq(r.map(o => o.reasons.some(t => t.startsWith('same building'))), [false, false]);
  eq(rankTie(r), true);
  const known = item(H(13), H(13.75), { code: 'PREV2', loc: W });
  eq(rank([b, item(H(14), H(14.75), { code: 'C-WEST', loc: W })], { [TUE]: [known] })[0].item.code, 'C-WEST', 'a known building still counts');
});

// ---- other runs

test('should push down a Must whose other run is free, and say so', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const want = item(H(14), H(14.75), { code: 'WANT', priority: 2 });
  const r = rank([must, want], { [THU]: [] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['WANT', 'LAB']);
  eq(r[1].elsewhere.map(e => [e.run.code, e.free, e.clashes]), [['LAB-R1', true, []]]);
  eq(r[1].reasons.includes('also runs Thu, Nov 19 1:00 PM, nothing against it'), true);
});
test('should push down a Must whose other run only displaces a Maybe, naming it', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const maybe = item(H(13), H(13.75), { code: 'MAYBE', priority: 1, day: THU }), other = item(H(14), H(14.75), { code: 'OTHER', priority: 2 });
  const r = rank([must, other], { [THU]: [maybe] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['OTHER', 'LAB']);
  eq(r[1].elsewhere.map(e => [e.run.code, e.free, e.clashes.map(c => [c.code, c.priority])]), [['LAB-R1', false, [['MAYBE', 1]]]]);
  eq(r[1].reasons.includes('also runs Thu, Nov 19 1:00 PM, clashes with MAYBE (Maybe)'), true);
});
test('should keep a Must in place when its other run clashes with another Must, and still describe it', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const must2 = item(H(13), H(13.75), { code: 'MUST2', priority: 3, day: THU }), other = item(H(14), H(14.75), { code: 'OTHER', priority: 2 });
  const r = rank([other, must], { [THU]: [must2] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['LAB', 'OTHER']);
  eq(r[0].elsewhere, []);
  eq(r[0].alts.map(a => [a.run.code, a.clashes.map(c => c.code)]), [['LAB-R1', ['MUST2']]]);
  eq(r[0].reasons.includes('also runs Thu, Nov 19 1:00 PM, clashes with MUST2 (Must)'), true);
});
test('should count blocked time against an other run, and never as something to displace', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const other = item(H(14), H(14.75), { code: 'OTHER', priority: 2 });
  const dinner = { key: 'block:1', id: 'block:1', code: 'Dinner', title: 'Customer dinner', pseudo: 'block', locked: true, priority: 0, day: THU, startMin: H(13), endMin: H(15), loc: W };
  const r = rank([other, must], { [THU]: [dinner] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['LAB', 'OTHER']);
  eq(r[0].elsewhere, []);
  eq(r[0].alts.map(a => [a.free, a.clashes.map(c => [c.code, c.block, c.fixed])]), [[false, [['Customer dinner', true, true]]]]);
  eq(r[0].reasons.includes('also runs Thu, Nov 19 1:00 PM, clashes with Customer dinner (blocked time)'), true);
  eq(codes(rank([other, must], { [THU]: [] }, id => (id === 'lab' ? [must, thu] : [])).map(o => o.item)), ['OTHER', 'LAB'], 'without the block the run is free and the Must is pushed down');
});
test('should not treat a locked lower pick on the other run as something to displace', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const other = item(H(14), H(14.75), { code: 'OTHER', priority: 2 });
  const reservedWant = item(H(13), H(14.25), { code: 'LABR', priority: 2, locked: true, reserved: true, day: THU });
  const r = rank([other, must], { [THU]: [reservedWant] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['LAB', 'OTHER']);
  eq(r[0].elsewhere, []);
  eq(r[0].reasons.includes('also runs Thu, Nov 19 1:00 PM, clashes with LABR (Want, your choice)'), true);
  const plainWant = { ...reservedWant, locked: false, reserved: false };
  eq(codes(rank([other, must], { [THU]: [plainWant] }, id => (id === 'lab' ? [must, thu] : [])).map(o => o.item)), ['OTHER', 'LAB'], 'the same Want unlocked is displaceable');
});
test('should never push down a reserved seat for having a free run', () => {
  const lab = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3, locked: true, reserved: true }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const must = item(H(14), H(14.75), { code: 'MUST', priority: 3 });
  const r = rank([must, lab], { [THU]: [] }, id => (id === 'lab' ? [lab, thu] : []));
  eq(codes(r.map(o => o.item)), ['LAB', 'MUST']);
  eq(r[0].elsewhere.length, 1, 'the free run is still reported');
});
test('should list only the other runs outside this clash that have a time', () => {
  const a = item(H(14), H(15.25), { code: 'A', id: 'g' }), a2 = item(H(14), H(15.25), { code: 'A-R1', id: 'g' });
  const tba = { ...item(0, 0, { code: 'A-R2', id: 'g' }), day: null, startMin: null, endMin: null };
  const thu = item(H(9), H(10.25), { code: 'A-R3', id: 'g', day: THU });
  const r = rank([a, a2], {}, () => [a, a2, tba, thu]);
  eq(r.map(o => [o.item.code, o.alts.map(x => x.run.code)]), [['A', ['A-R3']], ['A-R1', ['A-R3']]]);
});

// ---- toss-up

test('should call the top two a toss-up only when every ranking rule ties', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(14.75), { code: 'B' });
  eq(rankTie(rank([a, b])), true);
  const c = item(H(14), H(14.75), { code: 'C', score: 9 });
  eq(rankTie(rank([a, c])), false);
  eq(rankTie(rank([a])), false);
});

// ---- what an option costs, in one line

// A missed run: `id` is its session (repeat group), `code` the run's own code.
const missed = (code, id = code) => ({ id, code });

test('should name the picks an option costs when there are one or two', () => {
  eq(missHeadline([missed('BRK234')]), "You'd miss BRK234");
  eq(missHeadline([missed('BRK234'), missed('TT1650')]), "You'd miss BRK234 and TT1650");
});
test('should give the count once an option costs three picks or more', () => {
  eq(missHeadline([missed('BRK234'), missed('TT1650'), missed('LAB654')]), "You'd miss 3 picks");
  eq(missHeadline(Array.from({ length: 15 }, (_, i) => missed(`BRK${i}`))), "You'd miss 15 picks");
});
test('should count a session once when several of its runs are missed', () => {
  // Three runs, two sessions: named, by the first run of each, not counted as three.
  eq(missHeadline([missed('BRK234', 'g1'), missed('BRK234-R1', 'g1'), missed('TT1650', 'g2')]), "You'd miss BRK234 and TT1650");
  eq(missHeadline([missed('BRK234', 'g1'), missed('BRK234-R1', 'g1')]), "You'd miss BRK234");
  // Four runs, three sessions: the count is of sessions.
  eq(missHeadline([missed('A', 'g1'), missed('A-R1', 'g1'), missed('B', 'g2'), missed('C', 'g3')]), "You'd miss 3 picks");
});
test('should say nothing about missing when an option costs no pick', () => {
  eq(missHeadline([]), '');
  eq(missHeadline(undefined), '');
});

// ---- what an option costs, on its card and outside it

// A and B clash at 2:00; D and E clash at 3:05 on their own card. B runs long, into D.
function twoCards() {
  const a = item(H(14), H(14.75), { code: 'A', priority: 3 }), b = item(H(14), H(15.25), { code: 'B' });
  const d = item(H(15.08), H(15.83), { code: 'D', priority: 3 }), e = item(H(15.17), H(15.67), { code: 'E' });
  const items = [a, b, d, e];
  const cards = slotGroups(items, ctx);
  const current = Object.values(optimize(items, ctx, null).plan).flat();
  const { outcomes } = compareOptions(items, cards[0].items, ctx, null);
  return { a, b, d, e, cards, current, outcomes };
}

test('should count a planned pick on another card that the option pushes out of the plan', () => {
  const { a, b, cards, current, outcomes } = twoCards();
  // The case is real only if D is planned now, sits on the other card, and B's what-if drops it.
  eq(cards.map(c => codes(c.items)), [['A', 'B'], ['D', 'E']]);
  eq(codes(current), ['A', 'D'], 'the plan as it stands');
  eq(codes(outcomes.get(b.key).chosen), ['B', 'E'], 'the plan if B is chosen');
  const cost = optionCost(b, cards[0].items, outcomes.get(b.key).chosen, current);
  eq([codes(cost.onCard), codes(cost.outside)], [['A'], ['D']]);
  eq(missHeadline([...cost.onCard, ...cost.outside]), "You'd miss A and D");
  // The option the plan already takes costs nothing outside its card (B, on the card, is still missed).
  eq(codes(outcomes.get(a.key).chosen), ['A', 'D'], 'the plan if A is chosen');
  const keep = optionCost(a, cards[0].items, outcomes.get(a.key).chosen, current);
  eq([codes(keep.onCard), codes(keep.outside)], [['B'], []]);
});
test('should not count outside the card a pick that was never in the plan, that moved, or that is not a session', () => {
  const x = item(H(14), H(15), { code: 'X' }), y = item(H(14), H(15), { code: 'Y' });
  const gone = item(H(15), H(16), { code: 'GONE' }), never = item(H(15), H(16), { code: 'NEVER' });
  const run1 = item(H(16), H(17), { code: 'RUN1', id: 'rep' }), run2 = item(H(16), H(17), { code: 'RUN2', id: 'rep', day: THU });
  const block = item(H(17), H(18), { code: 'DINNER', pseudo: 'block' }), stays = item(H(18), H(19), { code: 'STAYS' });
  const current = [y, gone, run1, block, stays];
  const cost = optionCost(x, [x, y], [x, run2, stays], current);
  eq([codes(cost.onCard), codes(cost.outside)], [['Y'], ['GONE']], 'NEVER was not planned, RUN1 moved to RUN2, DINNER is blocked time');
  const stay = optionCost(x, [x, y], [x, run2, stays, gone], current);
  eq([codes(stay.onCard), codes(stay.outside)], [['Y'], []], 'nothing is pushed out when GONE stays, and Y is still missed');
});
test('should count a session once when a run on the card and its planned run elsewhere are both lost', () => {
  const x = item(H(14), H(15), { code: 'X' }), y1 = item(H(14), H(15), { code: 'Y1', id: 'y' }), y2 = item(H(14), H(15), { code: 'Y2', id: 'y', day: THU });
  const cost = optionCost(x, [x, y1], [x], [y2]);
  eq([codes(cost.onCard), codes(cost.outside)], [['Y1'], []]);
  // Another run of the chosen session itself is not a cost either.
  const x2 = item(H(9), H(10), { code: 'X2', id: x.id, day: THU });
  const own = optionCost(x, [x, y1], [x], [x2]);
  eq([codes(own.onCard), codes(own.outside)], [['Y1'], []]);
});
test('should keep every missed run of a session on the card, counted once in the headline', () => {
  const x = item(H(14), H(15), { code: 'X' }), y1 = item(H(14), H(15), { code: 'Y1', id: 'y' }), y2 = item(H(14.5), H(15.5), { code: 'Y2', id: 'y' });
  const cost = optionCost(x, [x, y1, y2], [x], []);
  eq([codes(cost.onCard), codes(cost.outside)], [['Y1', 'Y2'], []]);
  eq(missHeadline(cost.onCard), "You'd miss Y1");
  eq(missReasons(cost.onCard, [x], ctx), 'Y1, Y2 (same time as X)');
});
test('should cost nothing when the inputs are not lists', () => {
  const x = item(H(14), H(15), { code: 'X' });
  eq(optionCost(x, undefined, null, undefined), { onCard: [], outside: [] });
});

// ---- why each missed pick does not fit

test('should say a pick gives way to lunch when the option pushes lunch into its time', () => {
  // Lunch is 30 minutes between 11:30 and 1:30. Y ends 11:45, so lunch fits before D (12:45);
  // X runs to 12:30, and lunch then only fits in D's time.
  const lunch = { from: H(11.5), to: H(13.5), length: 30, weight: 100 };
  const x = item(H(11), H(12.5), { code: 'X' }), y = item(H(11), H(11.75), { code: 'Y', priority: 3 }), d = item(H(12.75), H(13.5), { code: 'D' });
  const items = [x, y, d];
  const cards = slotGroups(items, ctx);
  eq(cards.map(c => codes(c.items)), [['Y', 'X']], 'D clashes with no session');
  const now = optimize(items, ctx, lunch);
  const current = Object.values(now.plan).flat();
  eq([codes(current), now.lunch[TUE]], [['Y', 'D'], { start: H(11.75), end: H(12.25) }], 'the plan as it stands');
  const o = compareOptions(items, cards[0].items, ctx, lunch).outcomes.get(x.key);
  eq([codes(o.chosen), o.lunch[TUE]], [['X'], { start: H(12.5), end: H(13) }], 'the plan if X is chosen');
  const cost = optionCost(x, cards[0].items, o.chosen, current);
  eq([codes(cost.onCard), codes(cost.outside)], [['Y'], ['D']]);
  eq(missReasons(cost.outside, o.chosen, ctx, { lunch: o.lunch }), 'D (gives way to lunch)');
  eq(missReasons(cost.onCard, o.chosen, ctx, { lunch: o.lunch }), 'Y (same time as X)', 'a session that blocks it is still the reason');
});
test('should say lower value only when neither a session nor lunch is in the way', () => {
  const x = item(H(11), H(12), { code: 'X' }), d = item(H(13), H(14), { code: 'D' }), e = item(H(13), H(14), { code: 'E', day: THU });
  // Both sides of the lunch slot: touching it is not in it, one minute inside is.
  eq(missReasons([d], [x], ctx, { lunch: { [TUE]: { start: H(12.5), end: H(13) } } }), 'D (lower value)');
  eq(missReasons([d], [x], ctx, { lunch: { [TUE]: { start: H(12.5), end: H(13) + 1 } } }), 'D (gives way to lunch)');
  eq(missReasons([d], [x], ctx, { lunch: { [TUE]: { start: H(14), end: H(14.5) } } }), 'D (lower value)');
  eq(missReasons([d], [x], ctx, { lunch: { [TUE]: { start: H(14) - 1, end: H(14.5) } } }), 'D (gives way to lunch)');
  // Lunch on another day (E is at Tuesday's lunch time, on Thursday), or no lunch planned at all.
  eq(missReasons([d, e], [x], ctx, { lunch: { [TUE]: { start: H(13), end: H(13.5) }, [THU]: null } }), 'D (gives way to lunch) · E (lower value)');
  eq(missReasons([d], [x], ctx), 'D (lower value)');
  eq(missReasons(undefined, undefined, ctx), '');
});
test('should give the walk and the gap when a missed pick is too far to reach', () => {
  const M = parseLocation('Marriott Marquis, Yerba Buena Ballroom, Salon 8');
  const x = item(H(14), H(14.75), { code: 'X', loc: W }), far = item(H(14.75) + 5, H(15.5), { code: 'FAR', loc: M });
  const names = { [W.building]: 'West', [M.building]: 'Marriott' };
  eq(missReasons([far], [x], ctx, { short: b => names[b] }), 'FAR (13 min walk West → Marriott, 5 min gap)');
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
