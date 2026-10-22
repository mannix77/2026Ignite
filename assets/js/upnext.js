// "Up next": the sessions coming up that I care about, grouped by start time, each with the
// walk from here and whether I can make it. Pure: app.js supplies the walk, rating and interest.

const IN_PROGRESS_MIN_LEFT = 15; // joining a session with less than this left isn't worth the walk

// sessions: model sessions. walkTo(s) -> minutes from here or null when position is unknown.
// prio(s): 0 = rejected, null = unrated, >0 = rated. interest(s): 0..100 likeness to my picks.
// chosen(s): in my plan. Returns [{ startMin, items: [{ s, walk, slack, status, planned }] }]
// where status is 'ok' | 'inprogress' | 'unreachable' | 'unknown'.
export function upNext({ sessions, day, nowMin, horizon = 120, tolerance = 5, walkTo, prio, interest, chosen, minInterest = 25 }) {
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
    items.push({ s, walk, slack, status, planned, p: p ?? 0, i: interest(s) });
  }
  const reach = it => (it.status === 'unreachable' ? 1 : 0);
  items.sort((a, b) => a.s.startMin - b.s.startMin || reach(a) - reach(b) || b.planned - a.planned || b.p - a.p || b.i - a.i || (a.walk ?? 99) - (b.walk ?? 99));
  const slots = [];
  for (const it of items) {
    let slot = slots[slots.length - 1];
    if (!slot || slot.startMin !== it.s.startMin) slots.push(slot = { startMin: it.s.startMin, items: [] });
    slot.items.push({ s: it.s, walk: it.walk, slack: it.slack, status: it.status, planned: it.planned });
  }
  return slots;
}
