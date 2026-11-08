// Clash cards per start time and a fixed ranking of the options in each
// (specs/features/clash-ranking.feature). Pure: no DOM, no store, so it can be tested.
//
// A whole afternoon of overlapping picks chains into one decision group (planner.js
// decisionGroups), and the whole-plan what-if can compare only the heaviest few of its
// options. Here the chain is cut into one card per start time, and every option in a card
// is ranked by one rule the reader can check:
//   1. a reserved seat or your own lock stays first;
//   2. a session with another run that is free, or that only displaces lower picks, is
//      pushed down (it is not lost: the other run is described);
//   3. tier (Must, Want, Maybe), then your score within the tier;
//   4. not recorded beats recorded (a recording can be watched later);
//   5. the building of the session before or after it breaks a tie.

import { canBoth, overlaps, isResolved, DEFAULT_PLANNER, PRIORITY } from './planner.js';
import { fmtDay, fmtTime } from './time.js';

const timed = x => !!x && !x.pseudo && typeof x.day === 'string' && x.day !== '' && Number.isFinite(x.startMin) && Number.isFinite(x.endMin) && x.endMin > x.startMin;
const byStart = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || a.startMin - b.startMin || a.endMin - b.endMin || String(a.code).localeCompare(String(b.code));

// One card per start time, and every option on exactly one card: the earliest option not yet
// on a card anchors a card holding every unplaced option it cannot be combined with (an
// overlap in time, or a walk between buildings too long for the gap). An option that would be
// alone on its card (everything it competes with is already placed) joins the card it competes
// with most, so a late starter lands on the card of the picks it competes with.
export function slotGroups(items, ctx = DEFAULT_PLANNER) {
  const xs = (Array.isArray(items) ? items : []).filter(timed).sort(byStart);
  const clash = (a, b) => a.day === b.day && !canBoth(a, b, ctx);
  const placed = new Set();
  const cards = [];
  for (const anchor of xs) {
    if (placed.has(anchor.key)) continue;
    const members = xs.filter(x => !placed.has(x.key) && (x === anchor || clash(anchor, x)));
    if (members.length < 2) {
      const home = cards.filter(c => c.day === anchor.day).map(c => [c, c.items.filter(x => clash(anchor, x)).length])
        .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0];
      if (!home) continue;                                  // competes with nothing: not a clash
      home[0].items.push(anchor);
      placed.add(anchor.key);
      continue;
    }
    for (const m of members) placed.add(m.key);
    cards.push({ day: anchor.day, start: anchor.startMin, items: members });
  }
  for (const c of cards) {
    c.items.sort(byStart);
    c.end = Math.max(...c.items.map(m => m.endMin));
    c.resolved = isResolved(c.items, ctx);
  }
  return cards;
}

const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

// The options of one card, best first. `plan` is the chosen chain per day (optimize().plan),
// `runsOf(id)` the timed runs of a repeat group. Each row carries the option, its sort key,
// the reasons in words, every other run with what is planned against it (`alts`), and the
// runs that would do instead (`elsewhere`: free, or clashing only with lower picks).
export function rankOptions(opts, { plan = {}, ctx = DEFAULT_PLANNER, runsOf = () => [] } = {}) {
  const inCard = new Set(opts.map(o => o.key));
  const planned = day => (plan[day] || []).filter(p => !p.pseudo);
  // Blocked time is in the chain as a pseudo item: it stands against another run like a session.
  const against = day => (plan[day] || []).filter(p => !p.pseudo || p.pseudo === 'block');
  const rows = opts.map(x => {
    const alts = (runsOf(x.id) || []).filter(r => timed(r) && r.key !== x.key && !inCard.has(r.key)).sort(byStart).map(run => {
      const clashes = against(run.day).filter(p => p.id !== run.id && !canBoth(p, run, ctx))
        .map(p => ({ key: p.key, code: p.pseudo ? p.title || p.code : p.code, priority: p.priority, block: !!p.pseudo, locked: !p.pseudo && !!p.locked, fixed: !!p.pseudo || !!p.locked }));
      return { run, clashes, free: clashes.length === 0 };
    });
    // A run elsewhere would do when nothing is against it, or only lower picks that are not
    // locked (a reserved seat or your own choice is never the thing to give up).
    const elsewhere = alts.filter(a => a.free || a.clashes.every(c => !c.fixed && (c.priority || 0) < (x.priority || 0)));
    const others = planned(x.day).filter(p => !inCard.has(p.key) && p.id !== x.id);
    const before = others.filter(p => p.endMin <= x.startMin).sort((a, b) => b.endMin - a.endMin)[0];
    const after = others.filter(p => p.startMin >= x.endMin).sort((a, b) => a.startMin - b.startMin)[0];
    // Only a recognised building counts: an unknown or placeholder room is 'U' for everyone.
    const sameBuilding = (p, q) => !!p?.loc?.known && !!q?.loc?.known && p.loc.building === q.loc.building;
    const sameBefore = !!before && sameBuilding(x, before);
    const sameAfter = !!after && sameBuilding(x, after);
    const key = [x.locked ? 1 : 0, x.locked || !elsewhere.length ? 1 : 0, x.priority || 0,
      Number.isFinite(x.score) ? x.score : -1, x.recorded === false ? 1 : 0, sameBefore || sameAfter ? 1 : 0];
    const reasons = [];
    if (x.locked) reasons.push(x.reserved ? 'Reserved seat' : 'Your choice');
    const tier = PRIORITY[x.priority] || 'Unrated';
    reasons.push(Number.isFinite(x.score) ? `${tier} · score ${x.score}` : tier);
    if (x.recorded === false) reasons.push('not recorded');
    else if (x.recorded === true) reasons.push('recorded');
    for (const a of alts) {
      const name = c => (c.block ? `${c.code} (blocked time)` : `${c.code} (${PRIORITY[c.priority] || 'Unrated'}${c.locked ? ', your choice' : ''})`);
      reasons.push(`also runs ${fmtDay(a.run.day)} ${fmtTime(a.run.startMin)}, ${a.free ? 'nothing against it' : `clashes with ${a.clashes.map(name).join(', ')}`}`);
    }
    if (sameBefore) reasons.push('same building as the session before');
    else if (sameAfter) reasons.push('same building as the session after');
    return { item: x, key, reasons, alts, elsewhere };
  });
  rows.sort((a, b) => cmpKey(b.key, a.key) || a.item.startMin - b.item.startMin || String(a.item.code).localeCompare(String(b.item.code)));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// The top two tie on every rule: the order between them is the code, not a judgement.
export function rankTie(rows) {
  return Array.isArray(rows) && rows.length > 1 && cmpKey(rows[0].key, rows[1].key) === 0;
}
