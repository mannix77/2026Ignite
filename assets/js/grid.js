// The My plan calendar grid (issue #155, specs/features/plan-grid-view.feature): which of a
// day's entries go on the grid and where each one is drawn. Pure: no DOM and no storage, so the
// rules can be checked without a browser. One minute is one unit of height.
//
// Sessions that overlap (a.startMin < b.endMin && b.startMin < a.endMin; touching is not
// overlapping) form a group, transitively. A group of one is a full-width block, a group of two
// is two half-width blocks side by side, and three or more collapse into one pill that runs
// from the group's first start to its last end. Blocked time and lunch are bands: each is drawn
// at its own time and never joins a group, so a pill only ever counts sessions.

export const PILL_HEADER = 32; // units: the header of an open pill
export const PILL_ROW = 44;    // units: each session row of an open pill
export const BAND_LABEL = 15;  // units: the top of a band, where its label is written

const list = x => (Array.isArray(x) ? x : []);
const timed = x => !!x && Number.isFinite(x.startMin) && Number.isFinite(x.endMin) && x.endMin > x.startMin;
const byStart = (a, b) => a.startMin - b.startMin;
const priorityThenCode = (a, b) => (b.priority - a.priority) || String(a.code).localeCompare(String(b.code));

// The saved List / Grid choice: 'grid' only for exactly 'grid'; anything else is 'list'.
export function planView(saved) { return saved === 'grid' ? 'grid' : 'list'; }

// What goes on `day`'s grid.
//   items    every timed run of every live pick, chosen or dropped (computePlan().items):
//            { key, id, code, title, priority, day, startMin, endMin, ... }
//   dropped  optimize().dropped: [{ item, reason: { kind } }]
//   blocks   blocked time: [{ key, title, day, startMin, endMin, pseudo: 'block' }]
//   lunch    that day's protected lunch { start, end }, or null
// Returns { sessions, bands }:
//   sessions the items on `day` that have a time (finite, endMin > startMin), in the order
//            given, except a run the plan gave up for another run of the same session (dropped
//            with reason.kind 'repeat'): that pick is attended elsewhere, not missed here.
//   bands    [{ kind: 'block', key, title, startMin, endMin }] for the day's blocked time and
//            { kind: 'lunch', key: 'lunch', title: 'Lunch', startMin, endMin } for lunch,
//            ordered by start; one without a time is left out.
export function gridEntries({ items, dropped, blocks, lunch, day } = {}) {
  const repeated = new Set(list(dropped).filter(d => d && d.reason && d.reason.kind === 'repeat' && d.item).map(d => d.item.key));
  const sessions = list(items).filter(x => timed(x) && x.day === day && !repeated.has(x.key));
  const bands = list(blocks).filter(b => timed(b) && b.day === day)
    .map(b => ({ kind: 'block', key: b.key, title: b.title, startMin: b.startMin, endMin: b.endMin }));
  if (lunch && timed({ startMin: lunch.start, endMin: lunch.end })) {
    bands.push({ kind: 'lunch', key: 'lunch', title: 'Lunch', startMin: lunch.start, endMin: lunch.end });
  }
  return { sessions, bands: bands.sort(byStart) };
}

// Overlap groups: sorted by start, a session joins the running group while it starts before the
// group's latest end, which also chains A-B-C where A and C never touch.
function overlapGroups(sessions) {
  const groups = [];
  let end = -Infinity;
  for (const s of [...sessions].sort(byStart)) {
    if (s.startMin >= end) {
      groups.push([]);
      end = -Infinity;
    }
    groups[groups.length - 1].push(s);
    end = Math.max(end, s.endMin);
  }
  return groups;
}

const hourLabel = min => `${Math.floor(min / 60) % 12 || 12} ${Math.floor(min / 60) % 24 < 12 ? 'AM' : 'PM'}`;

// Where everything is drawn. `open` is an iterable of pill ids; an id with no pill is ignored.
// Returns null when there are no sessions and no bands, else:
//   startMin, endMin  whole hours: the hour at or before the first start and the hour at or
//                     after the last end, over sessions and bands alike
//   hours   [{ min, label, top }] for every whole hour from startMin to endMin inclusive;
//           label like '9 AM', '12 PM', '5 PM'
//   blocks  [{ item, startMin, endMin, top, height, col, cols }] sessions drawn on their own:
//           cols 1 is full width; cols 2 is half width with col 0 (left: the earlier start;
//           on a tie the higher priority, then code) or col 1. Each is at its own start.
//   pills   [{ id, startMin, endMin, top, height, open, count, label, dots, rows }]
//           id is String(startMin); label is `${count} sessions at this time`; rows are the
//           group's sessions, Must first (priority descending, then startMin, then code);
//           dots is rows.map(r => r.priority).
//   bands   [{ kind, key, title, startMin, endMin, top, height }]
//   height  y(endMin): the height of the whole grid
//   y(min)  units from the top of the grid for a minute of the day:
//           (min - startMin) plus, for every open pill with endMin <= min, that pill's extra
//           height max(0, PILL_HEADER + PILL_ROW * count - (endMin - startMin)).
// top is y(startMin). A block or band is y(endMin) - y(startMin) tall. A closed pill is
// endMin - startMin tall; an open one is max(that, PILL_HEADER + PILL_ROW * count), so a pill
// already taller than its list does not shrink the day. blocks, pills and bands are each in
// time order.
//
// Every block, pill and band also has `lane` (true or false). A band's label is its first
// BAND_LABEL units (all of a shorter band), at the right edge. A session or pill is drawn over
// the band, so one that reaches the right edge there would hide the label: it and the band get
// lane true, and the page stops it short of the right edge to leave the label a lane. What
// reaches the right edge is a pill, a full-width block, or the right half of a pair; both halves
// of that pair get lane, so they stay equal. A band is still never one of a pair or a pill.
export function gridLayout({ sessions, bands } = {}, open = []) {
  const all = list(sessions), strips = list(bands);
  if (!all.length && !strips.length) return null;
  const openIds = new Set(open);

  const groups = overlapGroups(all);
  const pills = groups.filter(g => g.length >= 3).map(g => {
    const rows = [...g].sort((a, b) => (b.priority - a.priority) || byStart(a, b) || priorityThenCode(a, b));
    const startMin = g[0].startMin;
    const id = String(startMin);
    return { id, startMin, endMin: Math.max(...g.map(s => s.endMin)), open: openIds.has(id), count: g.length,
      label: `${g.length} sessions at this time`, dots: rows.map(r => r.priority), rows };
  });

  const drawn = [...all, ...strips];
  const startMin = Math.floor(Math.min(...drawn.map(x => x.startMin)) / 60) * 60;
  const endMin = Math.ceil(Math.max(...drawn.map(x => x.endMin)) / 60) * 60;

  const openHeight = p => PILL_HEADER + PILL_ROW * p.count;
  const openPills = pills.filter(p => p.open);
  const y = min => min - startMin + openPills.filter(p => p.endMin <= min)
    .reduce((sum, p) => sum + Math.max(0, openHeight(p) - (p.endMin - p.startMin)), 0);
  const span = x => ({ top: y(x.startMin), height: y(x.endMin) - y(x.startMin) });

  const hours = [];
  for (let min = startMin; min <= endMin; min += 60) hours.push({ min, label: hourLabel(min), top: y(min) });

  // One list per single or pair, left to right.
  const placed = groups.filter(g => g.length < 3).map(g => [...g].sort((a, b) => byStart(a, b) || priorityThenCode(a, b))
    .map((item, col) => ({ item, startMin: item.startMin, endMin: item.endMin, ...span(item), col, cols: g.length })));
  for (const p of pills) {
    p.top = y(p.startMin);
    p.height = p.open ? Math.max(p.endMin - p.startMin, openHeight(p)) : p.endMin - p.startMin;
  }
  const drawnBands = strips.map(b => ({ kind: b.kind, key: b.key, title: b.title, startMin: b.startMin, endMin: b.endMin, ...span(b) })).sort(byStart);

  // lane: what reaches the right edge over a band's label, and the band whose label it is.
  const overLabel = (x, b) => x.top < b.top + Math.min(BAND_LABEL, b.height) && b.top < x.top + x.height;
  const hidesLabel = x => drawnBands.some(b => overLabel(x, b));
  for (const p of pills) p.lane = hidesLabel(p);
  for (const row of placed) { const lane = hidesLabel(row.at(-1)); for (const b of row) b.lane = lane; }
  const atRight = [...pills, ...placed.map(row => row.at(-1))];
  for (const b of drawnBands) b.lane = atRight.some(x => overLabel(x, b));

  return { startMin, endMin, hours, blocks: placed.flat(), pills, bands: drawnBands, y, height: y(endMin) };
}
