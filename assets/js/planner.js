// Scheduling brain: travel-aware conflict detection and an exact per-day optimizer.
//
// An "item" is one scheduled instance of a session you're interested in:
//   { key, id, code, title, type, day, startMin, endMin, loc, recorded, priority (1-3), locked }
// A plan is a chain per day, so the best plan is the max-weight path through a DAG
// where a -> b exists when you can leave a and still reach b's room in time.

import { walkMinutes, DEFAULT_WALK } from './venue.js';

export const PRIORITY = { 3: 'Must', 2: 'Want', 1: 'Maybe', 0: 'Skip' };

export const DEFAULT_PLANNER = {
  walk: DEFAULT_WALK,
  buffer: 2,          // minutes to find the room and grab a seat
  tolerance: 5,       // minutes you'll accept missing (leave early / arrive late)
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

export function overlaps(a, b) {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

// Moving from a (earlier) to b (later) on the same day.
export function transition(a, b, ctx = DEFAULT_PLANNER) {
  const walk = walkMinutes(a.loc, b.loc, ctx.walk);
  const gap = b.startMin - a.endMin;
  const need = walk + ctx.buffer;
  const slack = gap - need;
  const shorter = Math.min(a.endMin - a.startMin, b.endMin - b.startMin);
  const allowed = Math.min(ctx.tolerance, Math.floor(shorter / 4));
  let status = 'ok';
  if (b.startMin <= a.startMin) status = 'conflict';
  else if (slack < 0) status = -slack <= allowed ? 'tight' : 'conflict';
  return { walk, gap, need, slack, miss: Math.max(0, -slack), status, allowed };
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
  let score = w[item.priority] ?? 0;
  const why = [`${PRIORITY[item.priority] || 'Unrated'} (+${w[item.priority] ?? 0})`];
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

// Full plan across days. A session with repeat instances is attended at most once.
export function optimize(items, ctx = DEFAULT_PLANNER) {
  const scheduled = items.filter(x => x.day && Number.isFinite(x.startMin) && Number.isFinite(x.endMin));
  const excluded = new Set();
  // A locked instance pins the session to that instance.
  const lockedIds = new Set(scheduled.filter(x => x.locked).map(x => x.id));
  for (const x of scheduled) if (lockedIds.has(x.id) && !x.locked) excluded.add(x.key);

  const days = [...new Set(scheduled.map(x => x.day))].sort();
  const run = day => optimizeDay(scheduled.filter(x => x.day === day && !excluded.has(x.key)), ctx);
  const result = Object.fromEntries(days.map(d => [d, run(d)]));

  for (let guard = 0; guard < scheduled.length; guard++) {
    const seen = new Map();
    for (const d of days) for (const x of result[d].chosen) {
      if (!seen.has(x.id)) seen.set(x.id, []);
      seen.get(x.id).push(x);
    }
    const dup = [...seen.values()].find(v => v.length > 1);
    if (!dup) break;
    // Drop whichever duplicate instance costs the least to give up.
    let cheapest = null;
    for (const x of dup) {
      excluded.add(x.key);
      const loss = result[x.day].total - run(x.day).total;
      excluded.delete(x.key);
      if (!cheapest || loss < cheapest.loss) cheapest = { x, loss };
    }
    excluded.add(cheapest.x.key);
    result[cheapest.x.day] = run(cheapest.x.day);
  }

  const chosenKeys = new Set();
  const plan = {};
  for (const d of days) {
    plan[d] = result[d].chosen;
    for (const x of plan[d]) chosenKeys.add(x.key);
  }
  const chosenIds = new Set([...chosenKeys].map(k => scheduled.find(x => x.key === k).id));
  const dropped = scheduled
    .filter(x => !chosenKeys.has(x.key))
    .map(x => ({ item: x, reason: explainDrop(x, plan[x.day] || [], ctx, chosenIds) }));
  const lockedConflicts = scheduled.filter(x => x.locked && !chosenKeys.has(x.key));
  const unscheduled = items.filter(x => !scheduled.includes(x));
  return { plan, dropped, lockedConflicts, unscheduled };
}

export function explainDrop(x, dayPlan, ctx = DEFAULT_PLANNER, chosenIds = new Set()) {
  if (chosenIds.has(x.id)) {
    return { kind: 'repeat', text: 'Attending another time slot of this session instead' };
  }
  for (const c of dayPlan) {
    if (canBoth(c, x, ctx)) continue;
    if (overlaps(c, x)) {
      return { kind: 'overlap', other: c, text: `Overlaps ${c.code} (${PRIORITY[c.priority] || ''})` };
    }
    const [a, b] = c.startMin <= x.startMin ? [c, x] : [x, c];
    const t = transition(a, b, ctx);
    return {
      kind: 'walk', other: c,
      text: `Can't get between ${c.code} and this in time: ${t.walk} min walk + ${ctx.buffer} min buffer, only ${Math.max(0, t.gap)} min gap`,
    };
  }
  return { kind: 'other', text: 'Lower value than the rest of the day' };
}

// Groups of picks on the same day that can't all be attended (connected components
// of the "can't do both" graph). Each group is a decision you have to make.
export function decisionGroups(items, ctx = DEFAULT_PLANNER) {
  const scheduled = items.filter(x => x.day && Number.isFinite(x.startMin));
  const byDay = {};
  for (const x of scheduled) (byDay[x.day] ||= []).push(x);
  const groups = [];
  for (const day of Object.keys(byDay).sort()) {
    const xs = byDay[day].sort((a, b) => a.startMin - b.startMin);
    const parent = xs.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        if (xs[j].startMin > xs[i].endMin + 60) break;
        if (!canBoth(xs[i], xs[j], ctx)) parent[find(i)] = find(j);
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
        });
      }
    }
  }
  return groups.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.start - b.start));
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

// Where you are now and what's next, for the conference-day view.
export function nowNext(dayPlan, nowMin, ctx = DEFAULT_PLANNER) {
  const plan = dayPlan.slice().sort((a, b) => a.startMin - b.startMin);
  const current = plan.find(p => p.startMin <= nowMin && nowMin < p.endMin) || null;
  const next = plan.find(p => p.startMin > nowMin) || null;
  let leaveBy = null, walk = null;
  const from = current || [...plan].reverse().find(p => p.endMin <= nowMin) || null;
  if (next) {
    walk = from ? walkMinutes(from.loc, next.loc, ctx.walk) : null;
    leaveBy = next.startMin - (walk ?? 0) - ctx.buffer;
  }
  return { current, next, from, walk, leaveBy };
}

// Value of a day's chain without lock bonuses (what you actually get out of it).
export function chainValue(chain, ctx = DEFAULT_PLANNER) {
  let v = 0;
  chain.forEach((x, i) => {
    v += weigh({ ...x, locked: false, forced: false }, ctx).score;
    if (i > 0) v -= transition(chain[i - 1], x, ctx).miss * ctx.weights.tightPerMin;
  });
  return v;
}

// "If I go to X, what does the rest of my day look like?" Locks inside `release`
// (the other options of the same decision) are ignored for this what-if.
export function whatIf(dayItems, forcedKey, release = new Set(), ctx = DEFAULT_PLANNER) {
  const xs = dayItems.map(x => ({ ...x, forced: x.key === forcedKey, locked: x.key !== forcedKey && !release.has(x.key) && x.locked }));
  const { chosen } = optimizeDay(xs, ctx);
  const feasible = chosen.some(x => x.key === forcedKey);
  return { chosen, feasible, value: chainValue(chosen, ctx) };
}
