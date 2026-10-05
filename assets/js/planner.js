// Scheduling brain: travel-aware conflict detection and an exact per-day optimizer.
//
// An "item" is one scheduled instance of a session you're interested in:
//   { key, id, code, title, type, day, startMin, endMin, loc, recorded, priority (1-3), locked }
// `id` groups repeat runs of the same session (attend at most one). Pseudo-items (lunch,
// blocked time) carry `pseudo` and a fixed `weight`.
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
    recordedPenalty: 15,   // "I can watch this one later"
    notRecordedBonus: 10,  // only chance to see it
    handsOnBonus: 10,      // labs / table talks don't translate to a recording
    tightPerMin: 2,        // cost per minute missed on a tight transfer
  },
};

const HANDS_ON = new Set(['Lab', 'Table Talk', 'Workshop']);
const LOCK = 100000;
const EXACT_LIMIT = 256; // repeat-instance combinations searched exhaustively

export function overlaps(a, b) {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

// Extra minutes needed to get into b beyond walking (keynote security and seating).
export function arrivalExtra(b, ctx = DEFAULT_PLANNER) {
  return b && (b.type === 'Keynote' || b.loc?.building === 'C') ? (ctx.keynoteExtra ?? 0) : 0;
}

// Moving from a (earlier) to b (later) on the same day. Staying in the same room needs
// no walk and no buffer.
export function transition(a, b, ctx = DEFAULT_PLANNER) {
  const stay = sameRoom(a.loc, b.loc);
  const flexible = a.loc?.building === '*' || b.loc?.building === '*'; // e.g. lunch: eat near the next room
  const walk = stay ? 0 : walkMinutes(a.loc, b.loc, ctx.walk);
  const gap = b.startMin - a.endMin;
  const need = stay || flexible ? 0 : walk + ctx.buffer + arrivalExtra(b, ctx);
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

// Exact max-weight chain for one day. Returns chosen items in time order.
export function optimizeDay(items, ctx = DEFAULT_PLANNER) {
  const xs = items.slice().sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || cmpKey(a, b));
  const n = xs.length;
  const wt = xs.map(x => weigh(x, ctx).score);
  const best = new Array(n).fill(0);
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    best[i] = wt[i];
    for (let j = 0; j < i; j++) {
      if (xs[j].startMin >= xs[i].startMin) continue;
      const t = transition(xs[j], xs[i], ctx);
      if (t.status === 'conflict') continue;
      const v = best[j] + wt[i] - t.miss * ctx.weights.tightPerMin;
      if (v > best[i]) { best[i] = v; prev[i] = j; }
    }
  }
  let end = -1;
  for (let i = 0; i < n; i++) if (end < 0 || best[i] > best[end]) end = i;
  const chosen = [];
  for (let i = end; i >= 0; i = prev[i]) chosen.unshift(xs[i]);
  return { chosen, total: end < 0 ? 0 : best[end] };
}

function cmpKey(a, b) {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const valid = x => x.day && Number.isFinite(x.startMin) && Number.isFinite(x.endMin) && x.endMin > x.startMin;

// Full plan across days. A session with repeat runs is attended at most once: we choose
// which run is "allowed" for every repeated session (exhaustively when the combinations
// are few, otherwise by coordinate descent), and each day is then solved exactly.
export function optimize(items, ctx = DEFAULT_PLANNER) {
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
  const solve = day => optimizeDay(scheduled.filter(x => x.day === day && isIn(x)), ctx);
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
      const liked = g.options.find(x => solveFree(scheduled, x.day, ctx).some(c => c.key === x.key));
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
  const plan = {};
  for (const d of days) {
    plan[d] = result[d].chosen;
    for (const x of plan[d]) chosenKeys.add(x.key);
  }
  const chosenIds = new Set(scheduled.filter(x => chosenKeys.has(x.key)).map(x => x.id));
  const dropped = scheduled
    .filter(x => !chosenKeys.has(x.key))
    .map(x => ({ item: x, reason: explainDrop(x, plan[x.day] || [], ctx, chosenIds) }));
  const lockedConflicts = scheduled.filter(x => x.locked && !chosenKeys.has(x.key));
  const unscheduled = items.filter(x => !valid(x));
  return { plan, dropped, lockedConflicts, unscheduled };
}

function solveFree(scheduled, day, ctx) {
  return optimizeDay(scheduled.filter(x => x.day === day), ctx).chosen;
}

export function explainDrop(x, dayPlan, ctx = DEFAULT_PLANNER, chosenIds = new Set()) {
  const blocker = dayPlan.find(c => !canBoth(c, x, ctx));
  if (chosenIds.has(x.id)) {
    return blocker
      ? { kind: 'repeat', clash: true, other: blocker, text: `Clashes with ${blocker.code}; you'll attend another run of this session` }
      : { kind: 'repeat', clash: false, text: 'You\'re attending another run of this session' };
  }
  if (!blocker) return { kind: 'other', text: 'Lower value than the rest of the day' };
  if (overlaps(blocker, x)) {
    return { kind: 'overlap', other: blocker, text: `Same time as ${blocker.code}${blocker.pseudo ? '' : ` (${PRIORITY[blocker.priority] || ''})`}` };
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

// Where you are now and what's next, for the conference-day view. `origin` is where the
// day starts (hotel / first building) when nothing has happened yet.
export function nowNext(dayPlan, nowMin, ctx = DEFAULT_PLANNER, origin = null) {
  const plan = dayPlan.slice().sort((a, b) => a.startMin - b.startMin);
  const current = plan.find(p => p.startMin <= nowMin && nowMin < p.endMin) || null;
  const next = plan.find(p => p.startMin > nowMin) || null;
  let leaveBy = null, walk = null, extra = 0;
  const from = current || [...plan].reverse().find(p => p.endMin <= nowMin) || (origin ? { key: 'origin', loc: origin } : null);
  if (next) {
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

// "If I go to X, what does the rest of my day look like?" Locks inside `release`
// (the other options of the same decision) are ignored for this what-if, and repeat
// runs on the same day still count only once.
export function whatIf(dayItems, forcedKey, release = new Set(), ctx = DEFAULT_PLANNER) {
  const xs = dayItems.map(x => ({ ...x, forced: x.key === forcedKey, locked: x.key !== forcedKey && !release.has(x.key) && x.locked }));
  const { plan } = optimize(xs, ctx);
  const chosen = Object.values(plan).flat();
  const feasible = chosen.some(x => x.key === forcedKey);
  return { chosen, feasible, value: chainValue(chosen, ctx) };
}
