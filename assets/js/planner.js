// Scheduling brain: travel-aware conflict detection and an exact per-day optimizer.
//
// An "item" is one scheduled instance of a session you're interested in:
//   { key, id, code, title, type, day, startMin, endMin, loc, recorded, priority (1-3),
//     score?, locked }
// `id` groups repeat runs of the same session (attend at most one). `score` (your own
// ranking, e.g. from a workbook) overrides the priority-tier weights. Blocked time is a
// pseudo-item with a real location, `pseudo: 'block'`, a fixed `weight` and `locked`.
// Lunch is not an item: it's taken in a gap of the chain that is long enough for the walk
// *and* the meal, so it never hides travel time.
// A day's plan is a chain, so the best plan is the max-weight path through a DAG where
// a -> b exists when you can leave a and still reach b's room in time.

import { walkMinutes, sameRoom, DEFAULT_WALK } from './venue.js';

export const PRIORITY = { 3: 'Must', 2: 'Want', 1: 'Maybe', 0: 'Skip' };

export const DEFAULT_PLANNER = {
  walk: DEFAULT_WALK,
  buffer: 2,          // minutes to find the room and grab a seat
  tolerance: 5,       // minutes you'll accept missing (leave early / arrive late)
  keynoteExtra: 15,   // extra time to get into a keynote (security, seating, Chase Center)
  weights: {
    3: 100, 2: 50, 1: 20,
    scoreScale: 10,        // points per point of your own score (a workbook score of 9 = 90)
    recordedPenalty: 15,   // "I can watch this one later"
    notRecordedBonus: 10,  // only chance to see it
    handsOnBonus: 10,      // labs / table talks don't translate to a recording
    tightPerMin: 2,        // cost per minute missed on a tight transfer
  },
};

const HANDS_ON = new Set(['Lab', 'Table Talk', 'Workshop']);
const LOCK = 100000;
const EXACT_LIMIT = 256; // repeat-run combinations searched exhaustively
const NEG = -Infinity;

export function overlaps(a, b) {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

// Extra minutes needed to get into b beyond walking (keynote security and seating).
export function arrivalExtra(b, ctx = DEFAULT_PLANNER) {
  return b && !b.pseudo && (b.type === 'Keynote' || b.loc?.building === 'C') ? (ctx.keynoteExtra ?? 0) : 0;
}

// Moving from a (earlier) to b (later) on the same day. Staying in the same room needs
// no walk and no buffer.
export function transition(a, b, ctx = DEFAULT_PLANNER) {
  const stay = sameRoom(a.loc, b.loc);
  const walk = stay ? 0 : walkMinutes(a.loc, b.loc, ctx.walk);
  const gap = b.startMin - a.endMin;
  const need = stay ? 0 : walk + ctx.buffer + arrivalExtra(b, ctx);
  const slack = gap - need;
  const shorter = Math.min(a.endMin - a.startMin, b.endMin - b.startMin);
  const allowed = Math.min(ctx.tolerance, Math.floor(shorter / 4));
  let status = 'ok';
  if (b.startMin <= a.startMin) status = 'conflict';
  else if (slack < 0) status = -slack <= allowed ? 'tight' : 'conflict';
  return { walk, gap, need, slack, miss: Math.max(0, -slack), status, allowed, stay };
}

export function canBoth(a, b, ctx = DEFAULT_PLANNER) {
  if (a.key === b.key) return false;
  if (a.day !== b.day) return true;
  const [x, y] = a.startMin <= b.startMin ? [a, b] : [b, a];
  if (x.startMin === y.startMin) return false;
  return transition(x, y, ctx).status !== 'conflict';
}

export function weigh(item, ctx = DEFAULT_PLANNER) {
  const w = ctx.weights;
  let score, why;
  if (item.weight != null) {
    score = item.weight;
    why = [item.title || 'Blocked time'];
  } else if (Number.isFinite(item.score)) {
    // Your own ranking already weighs recordings and formats, so nothing else is added.
    const k = w.scoreScale ?? 10;
    score = item.score * k;
    why = [`your score ${item.score} (×${k} = ${score})`];
  } else {
    score = w[item.priority] ?? 0;
    why = [`${PRIORITY[item.priority] || 'Unrated'} (+${w[item.priority] ?? 0})`];
    if (item.recorded === true && w.recordedPenalty) {
      score -= w.recordedPenalty;
      why.push(`recorded, can watch later (−${w.recordedPenalty})`);
    } else if (item.recorded === false && w.notRecordedBonus) {
      score += w.notRecordedBonus;
      why.push(`not recorded (+${w.notRecordedBonus})`);
    }
    if (HANDS_ON.has(item.type) && w.handsOnBonus) {
      score += w.handsOnBonus;
      why.push(`${item.type.toLowerCase()} is in-person only (+${w.handsOnBonus})`);
    }
  }
  score = Math.max(1, score);
  if (item.locked) score += LOCK;
  else if (item.forced) score += LOCK / 10; // what-if choice: beats picks, yields to real locks
  return { score, why };
}

// ---------------------------------------------------------------- lunch

// lunch: { from, to, length, weight } in minutes after midnight; null = don't plan one.
export function lunchConfig(l) {
  if (!l || l.on === false) return null;
  const len = Number(l.length), from = Number(l.from), to = Number(l.to);
  if (!(len > 0) || !(to - from >= len)) return null;
  return { from, to, length: len, weight: Math.max(0, Number(l.weight) || 0) };
}

const slot = (start, L) => ({ start, end: start + L.length });

// Latest slot that ends before the first session of the day.
function lunchBefore(first, L) {
  const t = Math.min(L.to, first.startMin) - L.length;
  return t >= L.from ? slot(t, L) : null;
}

// Earliest slot after the last session of the day.
function lunchAfter(last, L) {
  const t = Math.max(last.endMin, L.from);
  return t + L.length <= L.to ? slot(t, L) : null;
}

// A slot between a and b that leaves room for the walk (before or after eating).
function lunchBetween(a, b, t, L) {
  const eatThenWalk = Math.max(a.endMin, L.from);
  if (eatThenWalk + L.length <= Math.min(L.to, b.startMin - t.need)) return slot(eatThenWalk, L);
  const walkThenEat = Math.max(a.endMin + t.need, L.from);
  if (walkThenEat + L.length <= Math.min(L.to, b.startMin)) return slot(walkThenEat, L);
  return null;
}

// ---------------------------------------------------------------- one day

// Exact max-weight chain for one day, with at most one lunch taken in a gap that fits it
// alongside the walking. Returns { chosen (time order), total, lunch: slot | null }.
export function optimizeDay(items, ctx = DEFAULT_PLANNER, lunch = null) {
  const xs = items.slice().sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || cmpKey(a, b));
  const n = xs.length;
  const wt = xs.map(x => weigh(x, ctx).score);
  const L = lunch;
  const lw = L ? L.weight : 0;
  // best[i][s]: best chain ending at i; s = 1 once lunch has been taken.
  const best = xs.map(() => [NEG, NEG]);
  const prev = xs.map(() => [null, null]);
  for (let i = 0; i < n; i++) {
    best[i][0] = wt[i];
    prev[i][0] = { j: -1, s: 0, lunch: null };
    const before = L ? lunchBefore(xs[i], L) : null;
    if (before) { best[i][1] = wt[i] + lw; prev[i][1] = { j: -1, s: 0, lunch: before }; }
    for (let j = 0; j < i; j++) {
      if (xs[j].startMin >= xs[i].startMin) continue;
      const t = transition(xs[j], xs[i], ctx);
      if (t.status === 'conflict') continue;
      const step = wt[i] - t.miss * ctx.weights.tightPerMin;
      for (const s of [0, 1]) {
        if (best[j][s] === NEG) continue;
        const v = best[j][s] + step;
        if (v > best[i][s]) { best[i][s] = v; prev[i][s] = { j, s, lunch: null }; }
      }
      if (L && best[j][0] !== NEG) {
        const between = lunchBetween(xs[j], xs[i], t, L);
        if (between) {
          const v = best[j][0] + step + lw;
          if (v > best[i][1]) { best[i][1] = v; prev[i][1] = { j, s: 0, lunch: between }; }
        }
      }
    }
  }
  // The empty chain (just lunch) is a candidate too: a lone low-value pick that covers
  // the whole lunch window loses to eating when lunch is worth more.
  let end = { i: -1, s: 0 }, endTotal = L ? lw : 0, endLunch = L ? slot(L.from, L) : null;
  for (let i = 0; i < n; i++) {
    for (const s of [0, 1]) {
      if (best[i][s] === NEG) continue;
      let v = best[i][s], after = null;
      if (s === 0 && L) { after = lunchAfter(xs[i], L); if (after) v += lw; }
      if (v > endTotal) { end = { i, s }; endTotal = v; endLunch = after; }
    }
  }
  const chosen = [];
  let lunchSlot = endLunch;
  for (let cur = end; cur && cur.i >= 0;) {
    chosen.unshift(xs[cur.i]);
    const p = prev[cur.i][cur.s];
    if (p.lunch) lunchSlot = p.lunch;
    cur = p.j >= 0 ? { i: p.j, s: p.s } : null;
  }
  return { chosen, total: endTotal, lunch: lunchSlot };
}

function cmpKey(a, b) {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const valid = x => x.day && Number.isFinite(x.startMin) && Number.isFinite(x.endMin) && x.endMin > x.startMin;

// ---------------------------------------------------------------- all days

// Full plan across days. A session with repeat runs is attended at most once: we choose
// which run is "allowed" for every repeated session (exhaustively when the combinations
// are few, otherwise by coordinate descent), and each day is then solved exactly.
export function optimize(items, ctx = DEFAULT_PLANNER, lunch = null) {
  const scheduled = items.filter(valid);
  const byId = new Map();
  for (const x of scheduled) {
    if (!byId.has(x.id)) byId.set(x.id, []);
    byId.get(x.id).push(x);
  }
  const multi = [...byId].filter(([, xs]) => xs.length > 1)
    .map(([id, xs]) => {
      const locked = xs.find(x => x.locked);
      return { id, options: locked ? [locked] : xs };
    })
    .filter(g => g.options.length > 1 || g.options[0].locked);
  const allowed = new Map(multi.map(g => [g.id, g.options[0].key]));
  const days = [...new Set(scheduled.map(x => x.day))].sort();
  const isIn = x => !allowed.has(x.id) || allowed.get(x.id) === x.key;
  const solve = day => optimizeDay(scheduled.filter(x => x.day === day && isIn(x)), ctx, lunch);
  let result = Object.fromEntries(days.map(d => [d, solve(d)]));
  const sum = r => days.reduce((a, d) => a + r[d].total, 0);
  const free = multi.filter(g => g.options.length > 1);
  const combos = free.reduce((a, g) => a * g.options.length, 1);

  if (free.length && combos <= EXACT_LIMIT) {
    let best = { total: sum(result), result, pick: free.map(g => g.options[0].key) };
    const idx = free.map(() => 0);
    for (let c = 1; c < combos; c++) {
      for (let i = 0; i < idx.length; i++) { idx[i]++; if (idx[i] < free[i].options.length) break; idx[i] = 0; }
      free.forEach((g, i) => allowed.set(g.id, g.options[idx[i]].key));
      const r = Object.fromEntries(days.map(d => [d, solve(d)]));
      const t = sum(r);
      if (t > best.total + 1e-9) best = { total: t, result: r, pick: free.map((g, i) => g.options[idx[i]].key) };
    }
    free.forEach((g, i) => allowed.set(g.id, best.pick[i]));
    result = best.result;
  } else if (free.length) {
    // Start each repeated session on the run the unconstrained plan liked best, then
    // switch one session at a time while that improves the whole plan.
    for (const g of free) {
      const liked = g.options.find(x => optimizeDay(scheduled.filter(y => y.day === x.day), ctx, lunch).chosen.some(c => c.key === x.key));
      if (liked) allowed.set(g.id, liked.key);
    }
    result = Object.fromEntries(days.map(d => [d, solve(d)]));
    for (let round = 0; round < 10; round++) {
      let improved = false;
      for (const g of free) {
        const cur = allowed.get(g.id);
        const curDay = g.options.find(x => x.key === cur).day;
        let best = { total: sum(result), key: cur, result };
        for (const x of g.options) {
          if (x.key === cur) continue;
          allowed.set(g.id, x.key);
          const trial = { ...result };
          for (const d of new Set([curDay, x.day])) trial[d] = solve(d);
          const t = sum(trial);
          if (t > best.total + 1e-9) best = { total: t, key: x.key, result: trial };
        }
        allowed.set(g.id, best.key);
        if (best.key !== cur) { result = best.result; improved = true; }
      }
      if (!improved) break;
    }
  }

  const chosenKeys = new Set();
  const plan = {}, lunches = {};
  for (const d of days) {
    plan[d] = result[d].chosen;
    lunches[d] = result[d].lunch;
    for (const x of plan[d]) chosenKeys.add(x.key);
  }
  const chosenIds = new Set(scheduled.filter(x => chosenKeys.has(x.key)).map(x => x.id));
  const dropped = scheduled
    .filter(x => !chosenKeys.has(x.key))
    .map(x => ({ item: x, reason: explainDrop(x, plan[x.day] || [], ctx, chosenIds) }));
  const lockedConflicts = scheduled.filter(x => x.locked && !chosenKeys.has(x.key));
  const unscheduled = items.filter(x => !valid(x));
  const value = days.reduce((a, d) => a + chainValue(plan[d], ctx) + (lunches[d] ? (lunch?.weight || 0) : 0), 0);
  return { plan, lunch: lunches, dropped, lockedConflicts, unscheduled, value };
}

export function explainDrop(x, dayPlan, ctx = DEFAULT_PLANNER, chosenIds = new Set()) {
  const blocker = dayPlan.find(c => !canBoth(c, x, ctx));
  if (chosenIds.has(x.id)) {
    return blocker
      ? { kind: 'repeat', clash: true, other: blocker, text: `Clashes with ${blocker.code}; you'll attend another run of this session` }
      : { kind: 'repeat', clash: false, text: 'You\'re attending another run of this session' };
  }
  if (!blocker) return { kind: 'other', text: 'Lower value than the rest of the day' };
  if (blocker.pseudo === 'block') {
    return { kind: 'block', other: blocker, text: `During ${blocker.title} (blocked time)` };
  }
  if (overlaps(blocker, x)) {
    return { kind: 'overlap', other: blocker, text: `Same time as ${blocker.code} (${PRIORITY[blocker.priority] || ''})` };
  }
  const [a, b] = blocker.startMin <= x.startMin ? [blocker, x] : [x, blocker];
  const t = transition(a, b, ctx);
  return {
    kind: 'walk', other: blocker,
    text: `Can't get between ${blocker.code} and this in time: ${t.walk} min walk + ${t.need - t.walk} min buffer, only ${Math.max(0, t.gap)} min gap`,
  };
}

// Groups of picks on the same day that can't all be attended (connected components
// of the "can't do both" graph). Each group is a decision you have to make.
export function decisionGroups(items, ctx = DEFAULT_PLANNER) {
  const scheduled = items.filter(x => valid(x) && !x.pseudo);
  const byDay = {};
  for (const x of scheduled) (byDay[x.day] ||= []).push(x);
  const groups = [];
  for (const day of Object.keys(byDay).sort()) {
    const xs = byDay[day].sort((a, b) => a.startMin - b.startMin);
    const parent = xs.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        if (xs[i].id !== xs[j].id && !canBoth(xs[i], xs[j], ctx)) parent[find(i)] = find(j);
      }
    }
    const comp = {};
    xs.forEach((x, i) => (comp[find(i)] ||= []).push(x));
    for (const members of Object.values(comp)) {
      if (members.length > 1) {
        groups.push({
          day,
          start: Math.min(...members.map(m => m.startMin)),
          end: Math.max(...members.map(m => m.endMin)),
          items: members,
          resolved: isResolved(members, ctx),
        });
      }
    }
  }
  return groups.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.start - b.start));
}

// A clash group is settled only when, after honoring the locked choices, nothing that
// is still possible conflicts with anything else that is still possible.
export function isResolved(members, ctx = DEFAULT_PLANNER) {
  const locked = members.filter(x => x.locked);
  if (!locked.length) return false;
  const open = members.filter(x => !x.locked && locked.every(l => canBoth(l, x, ctx)));
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) if (!canBoth(open[i], open[j], ctx)) return false;
  }
  return true;
}

// Consecutive-pair transitions for a day's plan (for the timeline view).
export function transitions(dayPlan, ctx = DEFAULT_PLANNER) {
  const out = [];
  for (let i = 1; i < dayPlan.length; i++) out.push({ from: dayPlan[i - 1], to: dayPlan[i], ...transition(dayPlan[i - 1], dayPlan[i], ctx) });
  return out;
}

// Sessions you could slot into the free time around a day's plan without breaking it.
export function fillers(dayPlan, candidates, ctx = DEFAULT_PLANNER) {
  const plan = dayPlan.slice().sort((a, b) => a.startMin - b.startMin);
  const planKeys = new Set(plan.map(p => p.key));
  return candidates.filter(c => {
    if (planKeys.has(c.key)) return false;
    let before = null, after = null;
    for (const p of plan) {
      if (p.startMin <= c.startMin) before = p;
      else if (!after) after = p;
    }
    if (before && (before.startMin === c.startMin || transition(before, c, ctx).status === 'conflict')) return false;
    if (after && transition(c, after, ctx).status === 'conflict') return false;
    return true;
  });
}

const LUNCH_ITEM = s => ({ key: 'lunch', pseudo: 'lunch', code: 'Lunch', title: 'Lunch break', startMin: s.start, endMin: s.end });

// Where you are now and what's next, for the conference-day view. `origin` is where the
// day starts (hotel / first building) when nothing has happened yet; with `origin.live`
// (GPS or "I'm at") it is where you are, whatever the plan says. Lunch (a slot, not an
// item) can be "current" or "next", but never the place you walk from.
export function nowNext(dayPlan, nowMin, ctx = DEFAULT_PLANNER, origin = null, lunch = null) {
  const plan = dayPlan.slice().sort((a, b) => a.startMin - b.startMin);
  let current = plan.find(p => p.startMin <= nowMin && nowMin < p.endMin) || null;
  let next = plan.find(p => p.startMin > nowMin) || null;
  const from = (origin && origin.live ? { key: 'origin', loc: origin } : null)
    || current || [...plan].reverse().find(p => p.endMin <= nowMin) || (origin ? { key: 'origin', loc: origin } : null);
  if (lunch && !current && lunch.start <= nowMin && nowMin < lunch.end) current = LUNCH_ITEM(lunch);
  if (lunch && lunch.start > nowMin && (!next || lunch.start < next.startMin)) next = LUNCH_ITEM(lunch);
  let leaveBy = null, walk = null, extra = 0;
  if (next && !next.pseudo) {
    const stay = from ? sameRoom(from.loc, next.loc) : false;
    walk = from ? (stay ? 0 : walkMinutes(from.loc, next.loc, ctx.walk)) : null;
    extra = arrivalExtra(next, ctx);
    leaveBy = next.startMin - (stay ? 0 : (walk ?? 0) + ctx.buffer + extra);
  }
  return { current, next, from, walk, leaveBy, extra };
}

// Value of a day's chain without lock bonuses (what you actually get out of it). Blocked
// time is a fixed constraint present in every option, so it adds nothing to compare.
export function chainValue(chain, ctx = DEFAULT_PLANNER) {
  let v = 0;
  chain.forEach((x, i) => {
    if (x.pseudo !== 'block') v += weigh({ ...x, locked: false, forced: false }, ctx).score;
    if (i > 0) v -= transition(chain[i - 1], x, ctx).miss * ctx.weights.tightPerMin;
  });
  return v;
}

// "If I go to X, what does the rest of my plan look like?" Runs over every day, so a
// session that moves to its repeat shows up as attended, not missed. Locks inside
// `release` are ignored for this what-if.
export function whatIf(items, forcedKey, release = new Set(), ctx = DEFAULT_PLANNER, lunch = null) {
  const xs = items.map(x => ({ ...x, forced: x.key === forcedKey, locked: x.key !== forcedKey && !release.has(x.key) && x.locked }));
  const res = optimize(xs, ctx, lunch);
  const chosen = Object.values(res.plan).flat();
  const feasible = chosen.some(x => x.key === forcedKey);
  return { plan: res.plan, lunch: res.lunch, chosen, feasible, value: res.value };
}

// Whole-plan outcomes for the options of one clash. Each outcome re-plans every day, so a
// big clash (busy days chain into one group) would freeze the page: only the `cap` most
// valuable options (locked ones always) are compared; the rest come back unevaluated, in
// order of their own weight. `outcomes` maps option key -> whatIf result.
export function compareOptions(items, options, ctx = DEFAULT_PLANNER, lunch = null, { cap = 6 } = {}) {
  const releaseFor = x => new Set([x.key, ...options.filter(o => !o.locked).map(o => o.key),
    ...options.filter(o => o.locked && o.id !== x.id && !canBoth(o, x, ctx)).map(o => o.key)]);
  const byWeight = options.slice().sort((a, b) => (b.locked - a.locked) || weigh(b, ctx).score - weigh(a, ctx).score || a.startMin - b.startMin);
  const evaluate = byWeight.filter((x, i) => x.locked || i < cap);
  const outcomes = new Map(evaluate.map(x => [x.key, whatIf(items, x.key, releaseFor(x), ctx, lunch)]));
  const rest = byWeight.filter(x => !outcomes.has(x.key));
  const ranked = evaluate.slice().sort((a, b) => (b.locked - a.locked) || outcomes.get(b.key).value - outcomes.get(a.key).value || a.startMin - b.startMin);
  return { outcomes, order: [...ranked, ...rest] };
}
