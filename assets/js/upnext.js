// "Up next": the sessions coming up that I care about, grouped by start time, each with the
// walk from here and whether I can make it. Pure: app.js supplies the walk, rating and interest.

import { sameRoom, walkMinutes } from './venue.js';

const IN_PROGRESS_MIN_LEFT = 15; // joining a session with less than this left isn't worth the walk

// The walk on from a candidate's room to the destination, for the detour: the venue matrix,
// except that a room in a building the venue does not know gives null rather than the matrix's
// "unknown" guess, so an arrival time is never built on a guess. Same room and online are 0.
export function onwardWalk(a, b, walk) {
  if (!a || !b) return null;
  if (a.building === 'O' || b.building === 'O') return 0;
  if (sameRoom(a, b)) return 0;
  if (!a.known || !b.known) return null;
  return walkMinutes(a, b, walk);
}

// sessions: model sessions. walkTo(s) -> minutes from here or null when position is unknown.
// prio(s): 0 = rejected, null = unrated, >0 = rated. interest(s): 0..100 likeness to my picks.
// chosen(s): in my plan. dest: where I need to be after the candidate ({ key?, loc, startMin|null }:
// the next planned item by default, or a place I chose, with no deadline), or null when nothing
// follows. walkBetween(a, b) -> minutes from one location to another, or null when unknown.
// Returns [{ startMin, items: [{ s, walk, slack, status, planned, detour }] }] where status is
// 'ok' | 'inprogress' | 'unreachable' | 'unknown' and detour is null or
// { onward, arrive, slack }: the walk on from the candidate to dest, when I would get there,
// and the minutes to spare before dest starts (negative = late; null when dest has no time).
export function upNext({ sessions, day, nowMin, horizon = 120, tolerance = 5, walkTo, prio, interest, chosen, minInterest = 25, dest = null, walkBetween = null }) {
  const items = [];
  for (const s of sessions) {
    if (!s.inPerson || s.day !== day || !(s.endMin > nowMin) || !(s.startMin <= nowMin + horizon)) continue;
    const p = prio(s);
    if (p === 0) continue;
    const planned = !!chosen(s);
    if (!(planned || p > 0 || interest(s) >= minInterest)) continue;
    const walk = walkTo(s);
    const started = s.startMin <= nowMin;
    let status, slack = null;
    if (walk == null) status = 'unknown';
    else {
      slack = s.startMin - (nowMin + walk);
      if (started) status = nowMin + walk <= s.endMin - IN_PROGRESS_MIN_LEFT ? 'inprogress' : 'unreachable';
      else status = slack >= -Math.min(tolerance, Math.floor((s.endMin - s.startMin) / 4)) ? 'ok' : 'unreachable'; // as planner.js: never more than 1/4 of a session
    }
    items.push({ s, walk, slack, status, planned, p: p ?? 0, i: interest(s), detour: detourTo(s, status, dest, walkBetween) });
  }
  const reach = it => (it.status === 'unreachable' ? 1 : 0);
  items.sort((a, b) => a.s.startMin - b.s.startMin || reach(a) - reach(b) || b.planned - a.planned || b.p - a.p || b.i - a.i || (a.walk ?? 99) - (b.walk ?? 99));
  const slots = [];
  for (const it of items) {
    let slot = slots[slots.length - 1];
    if (!slot || slot.startMin !== it.s.startMin) slots.push(slot = { startMin: it.s.startMin, items: [] });
    slot.items.push({ s: it.s, walk: it.walk, slack: it.slack, status: it.status, planned: it.planned, detour: it.detour });
  }
  return slots;
}

// The cost of going to s and then on to dest: null when nothing follows, when s is the
// destination itself, when I could not make s anyway, or when the walk on is unknown.
function detourTo(s, status, dest, walkBetween) {
  if (!dest || !dest.loc || typeof walkBetween !== 'function' || status === 'unreachable') return null;
  if (dest.key != null && dest.key === s.key) return null;
  const onward = walkBetween(s.loc, dest.loc);
  if (!Number.isFinite(onward)) return null;
  const arrive = s.endMin + onward;
  return { onward, arrive, slack: Number.isFinite(dest.startMin) ? dest.startMin - arrive : null };
}
