// What can be read on the My plan grid, in a real browser at both phone sizes (issue #155,
// specs/features/plan-grid-view.feature). Everything here is beyond the feature file: the
// scenarios say what is on the grid, these tests say that its words are not hidden.
//
//   A pill's label ("N sessions at this time") is always whole, closed and open, however many
//   sessions the pill holds. Its dots take the room that is left: only whole dots, the first in
//   rating order.
//
//   Blocked time and lunch stay readable when a session or pill is drawn over them: whatever
//   would cover a band's label stops short of the right edge by a lane, and the label is read
//   in that lane. Which sessions those are is decided by assets/js/grid.js (`lane`, tested
//   without a browser in tests/grid.test.js); here the page must honour it.
//
// Playwright's own visibility checks do not see what is drawn on top of an element, so "can be
// read" is measured: the label's box, whether it is clipped, and what document.elementFromPoint
// finds at points across it.
//
// Same conventions as plan-grid.spec.js: the fixture's catalogs and saved picks
// (plan-grid.fixture.js), a fixed clock, a browser time zone that is not the conference's, no
// service worker, no request leaves the local server, and every test first asserts what is
// already true without the grid (the planner booted on the seeded day and the list shows what
// the test depends on).
//
// The page is drawn in the machine's own system font, which the suite does not control. The
// suite was run with the page's font set to each of five (DejaVu Sans, the widest, in which
// "99 sessions at this time" is 167.6px; Noto Sans; Liberation Sans; FreeSans; Droid Sans
// Fallback, the narrowest, 120.7px) and passes in all of them: the lane width is the widest that
// still lets "99 sessions at this time" fit beside it at 390px in DejaVu Sans (one pixel more
// fails there), and the band labels the tests expect whole in a lane ("Stand-up", "Call",
// "Review", "Demo", "Lunch") are short enough for it in all five.
import { test, expect as baseExpect } from '@playwright/test';
import { serveFixture, seedState, CATALOGS, BLOCKS, FIXED_NOW, TUE, WED, FRI } from './plan-grid.fixture.js';

const expect = baseExpect.configure({ timeout: 4000 });
const BOOT_TIMEOUT = 15_000;

test.use({ timezoneId: 'Asia/Tokyo', locale: 'en-US', serviceWorkers: 'block', actionTimeout: 5000, navigationTimeout: 15_000 });

// The stylesheet's contract (.daygrid in assets/css/app.css), in pixels: the hour gutter, the
// inset of a session from each edge of the band area, the gap between the halves of a pair, and
// the lane a session leaves at the right for the label of the band under it (--g-gutter,
// --g-inset, --g-gap, --g-lane).
const GUTTER = 46, INSET = 6, GAP = 4, LANE = 87;
const LEFT = GUTTER + INSET;   // where every full-width session, left half and pill starts

let traffic;      // what the page asked for (fixture serveFixture)
let pageErrors;   // uncaught exceptions in any page of the test
let catalog;      // the Ignite catalog served to the page; a test may add sessions before it opens

test.beforeEach(async ({ context, baseURL }) => {
  test.setTimeout(60_000);
  pageErrors = [];
  context.on('weberror', e => pageErrors.push(String(e.error())));
  await context.clock.setFixedTime(new Date(FIXED_NOW));
  traffic = await serveFixture(context, baseURL);
  // Registered after the fixture's route, so it answers first: the same catalog unless a test
  // added sessions to it.
  catalog = CATALOGS.ignite2026;
  await context.route(url => url.pathname === '/data/ignite2026/sessions.json',
    route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) }));
});

test.afterEach(() => {
  expect(pageErrors, 'uncaught errors in the page').toEqual([]);
  // The fixture refuses every request that is not for the local server; the only one the Ignite
  // planner tries is its live check.
  expect([...new Set(traffic.blocked)].filter(host => host !== 'eventtools.event.microsoft.com'), 'other hosts the page asked for').toEqual([]);
});

// ---------------------------------------------------------------- sessions and blocked time of a test

const MUST = 3, WANT = 2, MAYBE = 1;
const utc = (day, hhmm) => new Date(`${day}T${hhmm}:00-08:00`).toISOString().replace('.000Z', 'Z');
const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// One more session in the Ignite catalog, with the saved pick that rates it. The record is the
// fixture's BRK101 with its own id, run key, code, title and time (the fixture's rec() is not
// exported); the pick has the shape the fixture saves.
const TEMPLATE = CATALOGS.ignite2026.sessions.find(s => s.code === 'BRK101');
function extra(code, title, day, from, to, rating) {
  const low = code.toLowerCase();
  return {
    key: `i-${low}`,
    rec: { ...TEMPLATE, id: `s-${low}`, inst: `i-${low}`, code, group: code, title, desc: `${title}: a fixture session.`,
      start: utc(day, from), end: utc(day, to), dur: minutes(to) - minutes(from) },
    pick: [`s-${low}`, { p: rating, lock: null, note: '', at: Date.UTC(2026, 10, 1), g: code, code }],
  };
}
// `count` sessions at one time, FIT001 onwards; `ratings(i)` rates the i-th (from 0).
const together = (count, day, from, to, ratings) => Array.from({ length: count },
  (_, i) => extra(`FIT${String(i + 1).padStart(3, '0')}`, `Fit session ${i + 1}`, day, from, to, ratings(i)));

// Blocked time as Settings saves it (minutes after midnight, conference time).
const blocked = (id, label, day, start, end) => ({ id, day, start, end, label, building: 'W' });

// Seeds the Ignite planner's saved state (the fixture's, on `day`, with `blocks` as its blocked
// time and the picks of `added`), serves the catalog with the added sessions, opens My plan and
// checks the harness: the planner booted in scheduled mode on that day, as the list.
async function openPlan(page, { day = TUE, blocks = BLOCKS, added = [] } = {}) {
  expect(TEMPLATE, 'the fixture session the added ones are copied from').toMatchObject({ code: 'BRK101', start: '2026-11-17T18:00:00Z', end: '2026-11-17T18:45:00Z' });
  catalog = { ...CATALOGS.ignite2026, sessions: [...CATALOGS.ignite2026.sessions, ...added.map(a => a.rec)] };
  // One seed script writes the whole state: the order two init scripts run in is not defined.
  await seedState(page.context(), { ignite: { ui: { day }, blocks, picks: Object.fromEntries(added.map(a => a.pick)) } });
  await page.goto('/#/plan');
  await expect(page).toHaveTitle('Ignite Planner', { timeout: BOOT_TIMEOUT });
  await expect(page.locator('#main h1')).toHaveText('My plan', { timeout: BOOT_TIMEOUT });
  // The fixture catalog is 31 sessions, 29 of them timed; every added session has a time.
  await expect(page.locator('#sync-status')).toContainText(`${31 + added.length} sessions · ${29 + added.length} timed`);
  await expect(page.locator(`#main .daytabs [data-act="day"][data-day="${day}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#main [data-day-view]')).toHaveAttribute('data-day-view', 'list');
  await expect(page.locator('#main .daygrid'), 'no grid before the switch is used').toHaveCount(0);
}

// The list's "What you'll miss" says why the plan left a pick out.
const missedBecause = (page, key) => page.locator(`#main .sacrifices [data-card="${key}"] .reason`);
const timelineCards = page => page.locator('#main .timeline .t-item [data-card]').evaluateAll(els => els.map(e => e.dataset.card));

async function showGrid(page, day) {
  await page.locator('#main [role="group"][aria-label="Day view"] [data-act="plan-view"][data-view="grid"]').click();
  const grid = page.locator(`#main [data-day-view="grid"] .daygrid[data-grid-day="${day}"]`);
  await expect(grid, `the grid for ${day}`).toBeVisible();
  await expect(page.locator('#main .daygrid')).toHaveCount(1);
  return grid;
}

const block = (grid, key) => grid.locator(`button.g-block[data-act="open"][data-key="${key}"]`);
const closedPill = (grid, id) => grid.locator(`button.g-pill[data-act="pill"][data-pill="${id}"][aria-expanded="false"]`);
const openPill = (grid, id) => grid.locator(`div.g-pill.open[data-pill="${id}"]`);
const bandCalled = (grid, title) => grid.locator('.g-band').filter({ hasText: title });
async function openThePill(grid, id) {
  await closedPill(grid, id).click();
  await expect(openPill(grid, id), `the open pill ${id}`).toBeVisible();
}

// ---------------------------------------------------------------- measuring

// Where an element is drawn, in real pixels from the top-left of .daygrid, and whether it is
// marked as sharing its row with a band's label.
async function geo(locator, what) {
  await expect(locator, what).toHaveCount(1);
  await expect(locator, what).toBeVisible();
  return locator.evaluate(el => {
    const g = el.closest('.daygrid').getBoundingClientRect(), r = el.getBoundingClientRect();
    const px = v => Math.round(v * 100) / 100;
    return { left: px(r.left - g.left), right: px(r.right - g.left), width: px(r.width), top: px(r.top - g.top), height: px(r.height), lane: el.hasAttribute('data-lane') };
  });
}
const gridWidth = grid => grid.evaluate(el => el.getBoundingClientRect().width);
// What is marked [data-lane] on the grid, as "kind:which".
const lanes = grid => grid.locator('[data-lane]').evaluateAll(els => els.map(e =>
  (e.matches('.g-band') ? `band:${e.textContent.replace(/\s+/g, ' ').trim()}` : e.matches('.g-pill') ? `pill:${e.dataset.pill}` : `block:${e.dataset.key}`)).sort());

// A pill's header (the closed pill itself, or the header of an open one), measured in the page:
//   text         the label's text
//   scrollWidth, clientWidth   of the label: clipped or ellipsised when scrollWidth is larger
//   inside       the label's box is inside the header's and the pill's (padding) boxes
//   hits         what elementFromPoint finds at the label's left end, centre and right end:
//                'label', 'pill' (the header button), or a description of whatever else
//   left, right  of the label's box, and `edge`, the header's inner right edge (inside its
//                border and padding is not counted: the padding box), all from the header's left
//   dots         one per dot, in page order: its rating class; `shown` 'whole' (all of it is
//                inside every box that clips it), 'hidden' (none of it is) or 'cut'; its left,
//                right and size; and for a whole dot, `on`: elementFromPoint at its centre is
//                that dot
const pillFacts = pill => pill.evaluate(el => {
  const head = el.matches('button') ? el : el.querySelector(':scope > .g-pill-head');
  const label = head.querySelector('.g-pill-label'), dotsBox = head.querySelector('.g-dots');
  head.scrollIntoView({ block: 'center' });
  // The padding box: what overflow: hidden clips to.
  const pad = e => { const r = e.getBoundingClientRect(); return { left: r.left + e.clientLeft, top: r.top + e.clientTop, right: r.left + e.clientLeft + e.clientWidth, bottom: r.top + e.clientTop + e.clientHeight }; };
  const name = e => (!e ? 'nothing' : e === label ? 'label' : e === head ? 'pill' : `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
  const px = v => Math.round(v * 100) / 100;
  const lr = label.getBoundingClientRect(), x0 = head.getBoundingClientRect().left;
  const boxes = [pad(el), pad(head)];
  const y = (lr.top + lr.bottom) / 2;
  // What a dot is clipped by: the pill, the header, and the dots' own box if that one clips.
  const clips = getComputedStyle(dotsBox).overflowX === 'visible' ? boxes : [...boxes, pad(dotsBox)];
  const clip = { left: Math.max(...clips.map(c => c.left)), top: Math.max(...clips.map(c => c.top)), right: Math.min(...clips.map(c => c.right)), bottom: Math.min(...clips.map(c => c.bottom)) };
  return {
    text: label.textContent,
    scrollWidth: label.scrollWidth, clientWidth: label.clientWidth,
    inside: boxes.every(b => lr.left >= b.left - 0.5 && lr.right <= b.right + 0.5 && lr.top >= b.top - 0.5 && lr.bottom <= b.bottom + 0.5),
    hits: [lr.left + 1, (lr.left + lr.right) / 2, lr.right - 1].map(x => name(document.elementFromPoint(x, y))),
    left: px(lr.left - x0), right: px(lr.right - x0), edge: px(pad(head).right - x0),
    dots: [...head.querySelectorAll('.g-dot')].map(d => {
      const r = d.getBoundingClientRect();
      const w = Math.min(r.right, clip.right) - Math.max(r.left, clip.left), h = Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top);
      const shown = w <= 0.01 || h <= 0.01 ? 'hidden' : w >= r.width - 0.01 && h >= r.height - 0.01 ? 'whole' : 'cut';
      return {
        rating: ['p-3', 'p-2', 'p-1'].filter(c => d.classList.contains(c)).join(' '), shown,
        left: px(r.left - x0), right: px(r.right - x0), size: `${px(r.width)}x${px(r.height)}`,
        on: shown === 'whole' ? document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2) === d : null,
      };
    }),
  };
});

// The whole label of a pill can be read: its text, not clipped or ellipsised, inside the pill,
// and nothing else is found anywhere across it.
function expectLabelWhole(f, text, what) {
  expect(f.text, `${what}: the label`).toBe(text);
  expect(f.clientWidth, `${what}: the label has a width`).toBeGreaterThan(0);
  expect(f.scrollWidth, `${what}: the label is not clipped or ellipsised (scrollWidth ${f.scrollWidth}, clientWidth ${f.clientWidth})`).toBeLessThanOrEqual(f.clientWidth);
  expect(f.inside, `${what}: the label's box is inside the pill's`).toBe(true);
  expect(f.hits, `${what}: what is found at the label's left end, centre and right end`).toEqual(['label', 'label', 'label']);
  // After the words, as before: 8px, then the chevron (a 7px box and its 2px stroke, with 3px on
  // each side) and the header's 10px of padding: 8 + 3 + 9 + 3 + 10 = 33px, so the words never
  // touch the chevron.
  expect(f.edge - f.right, `${what}: from the end of the label to the header's inner edge`).toBeCloseTo(33, 0);
}

// Only whole dots are shown, and those shown are the first in the order given. Returns how many.
function expectWholeDots(f, ratings, what) {
  expect(f.dots.map(d => d.rating), `${what}: one dot a session, in rating order`).toEqual(ratings);
  const shown = f.dots.map(d => d.shown);
  expect(shown.filter(s => s === 'cut'), `${what}: no dot is cut (${shown.join(' ')})`).toEqual([]);
  const count = shown.filter(s => s === 'whole').length;
  expect(shown, `${what}: the dots shown are the first ones`).toEqual([...Array(count).fill('whole'), ...Array(ratings.length - count).fill('hidden')]);
  const whole = f.dots.filter(d => d.shown === 'whole');
  expect(whole.map(d => d.on), `${what}: every dot shown is on top at its centre`).toEqual(Array(count).fill(true));
  // A dot is 9px round; dots are 3px apart, and the last one shown is at least 8px before the
  // words (exactly 8px when every dot is shown).
  expect(whole.map(d => d.size), `${what}: every dot shown is 9px round`).toEqual(Array(count).fill('9x9'));
  for (let i = 1; i < count; i++) expect(whole[i].left - whole[i - 1].right, `${what}: between dot ${i} and dot ${i + 1}`).toBeCloseTo(3, 1);
  if (count) expect(f.left - whole[count - 1].right, `${what}: between the last dot shown and the label`).toBeGreaterThanOrEqual(8 - 0.05);
  if (count === ratings.length) expect(f.left - whole[count - 1].right, `${what}: every dot is shown, so the label follows 8px after them`).toBeCloseTo(8, 1);
  return count;
}

// A band's label, measured in the page:
//   text         its text
//   left, right, width   of its box, from the left of .daygrid
//   inside       its box is inside the band's
//   scrollWidth, clientWidth   clipped or ellipsised when scrollWidth is larger (both 0 for a
//                label that is plain inline text)
//   hits         what elementFromPoint finds at fifteen points across the label (five across, at
//                a quarter, half and three quarters of its height), each named once: 'label', or
//                a description of whatever is drawn over it
const labelFacts = band => band.evaluate(el => {
  const label = el.querySelector('.g-band-label');
  el.scrollIntoView({ block: 'center' });
  const g = el.closest('.daygrid').getBoundingClientRect(), b = el.getBoundingClientRect(), r = label.getBoundingClientRect();
  const px = v => Math.round(v * 100) / 100;
  const name = e => (!e ? 'nothing' : e === label || label.contains(e) ? 'label'
    : `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}${e.dataset.key ? `[${e.dataset.key}]` : ''}${e.dataset.pill ? `[pill ${e.dataset.pill}]` : ''}`);
  const hits = [];
  for (const fy of [0.25, 0.5, 0.75]) {
    for (const x of [r.left + 1, r.left + r.width * 0.25, r.left + r.width * 0.5, r.left + r.width * 0.75, r.right - 1]) {
      hits.push(name(document.elementFromPoint(x, r.top + r.height * fy)));
    }
  }
  return {
    text: label.textContent.replace(/\s+/g, ' ').trim(),
    left: px(r.left - g.left), right: px(r.right - g.left), width: px(r.width),
    inside: r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
    scrollWidth: label.scrollWidth, clientWidth: label.clientWidth,
    points: hits.length, hits: [...new Set(hits)],
  };
});

// How tall a band's label is drawn, and whether lines of it are cut off (scrollHeight larger).
const labelLines = band => band.locator('.g-band-label').evaluate(el => ({
  height: Math.round(el.getBoundingClientRect().height * 100) / 100, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
}));

// A band's label can be read: nothing is drawn over any of it and it is inside its band.
// `whole` also says it is not cut short. (Only a label in a lane is a box of its own that can
// cut its text, which expectInLane asserts; any other is plain inline text, and `inside` says
// the band does not cut it.)
function expectLabelRead(f, text, what, { whole = true } = {}) {
  expect(f.text, `${what}: the label`).toBe(text);
  expect(f.width, `${what}: the label has a width`).toBeGreaterThan(10);
  expect(f.points, `${what}: points looked at`).toBe(15);
  expect(f.hits, `${what}: what is found across the label`).toEqual(['label']);
  expect(f.inside, `${what}: the label is inside its band`).toBe(true);
  if (whole) expect(f.scrollWidth, `${what}: the label is not cut short (scrollWidth ${f.scrollWidth}, clientWidth ${f.clientWidth})`).toBeLessThanOrEqual(f.clientWidth);
}

// A band's label sits in the lane to the right of `session` (a session or pill drawn over the
// band): clear of its right edge, and no wider than the lane less the 6px around it.
function expectInLane(label, session, what) {
  expect(label.left, `${what}: the label starts to the right of the session's right edge`).toBeGreaterThanOrEqual(session.right + 1);
  expect(label.clientWidth, `${what}: the label is a box of its own, so "cut short" can be measured`).toBeGreaterThan(0);
  expect(label.width, `${what}: the label is no wider than the lane`).toBeLessThanOrEqual(LANE - 6 + 0.5);
}

// The width of the grid: the viewport less the page's 16px padding on each side.
async function expectGridWidth(grid, viewport) {
  const W = await gridWidth(grid);
  expect(W, 'the grid is as wide as the page allows').toBe(viewport.width - 32);
  return W;
}
// A session or pill with nothing beside it: from the gutter and inset to the inset at the right.
function expectFullWidth(g, W, what) {
  expect(g.lane, `${what}: not marked data-lane`).toBe(false);
  expect(g.left, `${what}: starts after the hour gutter`).toBeCloseTo(LEFT, 0);
  expect(g.right, `${what}: reaches the right edge`).toBeCloseTo(W - INSET, 0);
}
// A session or pill that leaves the lane: the same start, ending a lane short of the right edge.
function expectStopsShort(g, W, what) {
  expect(g.lane, `${what}: marked data-lane`).toBe(true);
  expect(g.left, `${what}: starts after the hour gutter`).toBeCloseTo(LEFT, 0);
  expect(g.right, `${what}: stops a lane short of the right edge`).toBeCloseTo(W - INSET - LANE, 0);
}

// ================================================================ a pill's label and dots

test.describe('a pill shows its whole label, and whole dots in the room that is left', () => {
  test('a pill of three: closed and open, the label is whole and all three dots are shown', async ({ page, viewport }) => {
    await openPlan(page);
    // Tuesday's three picks at 10:00: the plan attends the Must and drops the other two.
    expect(await timelineCards(page)).toEqual(['i-brk102', 'i-brk105', 'i-brk106', 'i-brk109', 'i-brk108']);
    await expect(missedBecause(page, 'i-brk103')).toBeVisible();
    await expect(missedBecause(page, 'i-brk101')).toBeVisible();

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    await expect(grid.locator('.g-pill')).toHaveCount(1);
    expectFullWidth(await geo(closedPill(grid, '600'), 'the pill'), W, 'the pill');

    const closed = await pillFacts(closedPill(grid, '600'));
    expectLabelWhole(closed, '3 sessions at this time', 'closed');
    expect(expectWholeDots(closed, ['p-3', 'p-2', 'p-1'], 'closed'), 'closed: a Must, a Want and a Maybe dot, all shown').toBe(3);

    await openThePill(grid, '600');
    const open = await pillFacts(openPill(grid, '600'));
    expectLabelWhole(open, '3 sessions at this time', 'open');
    expect(expectWholeDots(open, ['p-3', 'p-2', 'p-1'], 'open'), 'open: all three dots shown').toBe(3);
  });

  test('a pill of thirty: closed and open, the label is whole and the dots shown are whole, the first in rating order, at least one', async ({ page, viewport }) => {
    // Friday, thirty picks from 2:00 to 2:45 PM: two Musts, three Wants and twenty-five Maybes.
    const thirty = together(30, FRI, '14:00', '14:45', i => (i < 2 ? MUST : i < 5 ? WANT : MAYBE));
    await openPlan(page, { day: FRI, added: thirty });
    // Only one of the thirty can be attended: the list has one and "What you'll miss" the rest.
    const attended = await timelineCards(page);
    expect(attended, 'one of the two Musts is in the plan').toHaveLength(1);
    expect(['i-fit001', 'i-fit002']).toContain(attended[0]);
    await expect(page.locator('#main .sacrifices [data-card]')).toHaveCount(29);

    const grid = await showGrid(page, FRI);
    const W = await expectGridWidth(grid, viewport);
    await expect(grid.locator('.g-pill')).toHaveCount(1);
    await expect(grid.locator('.g-block')).toHaveCount(0);
    const pill = await geo(closedPill(grid, '840'), 'the pill');
    expectFullWidth(pill, W, 'the pill');
    // Thirty dots of 9px with 3px between them are 357px: more than the pill is wide at either
    // phone size, so some must be hidden.
    expect(pill.width, 'the pill is narrower than thirty dots').toBeLessThan(357);

    const ratings = [...Array(2).fill('p-3'), ...Array(3).fill('p-2'), ...Array(25).fill('p-1')];
    const closed = await pillFacts(closedPill(grid, '840'));
    expectLabelWhole(closed, '30 sessions at this time', 'closed');
    const shownClosed = expectWholeDots(closed, ratings, 'closed');
    expect(shownClosed, 'closed: at least one dot').toBeGreaterThanOrEqual(1);
    expect(shownClosed, 'closed: not all thirty').toBeLessThan(30);

    await openThePill(grid, '840');
    await expect(openPill(grid, '840').locator('button.g-row')).toHaveCount(30);
    const open = await pillFacts(openPill(grid, '840'));
    expectLabelWhole(open, '30 sessions at this time', 'open');
    const shownOpen = expectWholeDots(open, ratings, 'open');
    expect(shownOpen, 'open: at least one dot').toBeGreaterThanOrEqual(1);
    expect(shownOpen, 'open: not all thirty').toBeLessThan(30);
  });
});

// ================================================================ a band's label under a session

test.describe('blocked time and lunch stay readable under a session or pill that starts with them', () => {
  test('blocked time 10:00 to 10:45 under the three 10:00 picks: the pill, closed and open, stops short and "Stand-up" is read beside it', async ({ page, viewport }) => {
    await openPlan(page, { blocks: [...BLOCKS, blocked('standup', 'Stand-up', TUE, 600, 645)] });
    // The plan dropped all three picks for the blocked time.
    for (const key of ['i-brk101', 'i-brk102', 'i-brk103']) await expect(missedBecause(page, key)).toHaveText('During Stand-up (blocked time)');

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    await expect(grid.locator('.g-band')).toHaveCount(3);
    // The pill and the band are at the same time: both 60 units down and 45 tall.
    const standup = bandCalled(grid, 'Stand-up');
    const band = await geo(standup, 'the Stand-up band');
    let pill = await geo(closedPill(grid, '600'), 'the pill');
    expect([band.top, band.height, pill.top, pill.height]).toEqual([60, 45, 60, 45]);

    let label = await labelFacts(standup);
    expectLabelRead(label, '⛔ Stand-up', 'closed');
    expectInLane(label, pill, 'closed');
    expectStopsShort(pill, W, 'the closed pill');
    expect(band.lane, 'the band is marked data-lane').toBe(true);
    // The narrower pill still shows its own words, and whole dots in what room is left (how
    // many depends on the font: three need 41px beside the words).
    const closed = await pillFacts(closedPill(grid, '600'));
    expectLabelWhole(closed, '3 sessions at this time', 'the closed pill');
    expectWholeDots(closed, ['p-3', 'p-2', 'p-1'], 'the closed pill');
    // Nothing else is over a label: the Must at 11:00 and the other two bands are as before.
    expect(await lanes(grid)).toEqual(['band:⛔ Stand-up', 'pill:600']);
    expectFullWidth(await geo(block(grid, 'i-brk105'), 'BRK105'), W, 'BRK105, at 11:00');
    expectLabelRead(await labelFacts(bandCalled(grid, 'Booth duty')), '⛔ Booth duty', 'Booth duty, nothing over it');
    expectLabelRead(await labelFacts(bandCalled(grid, 'Lunch')), '🍽 Lunch', 'lunch, nothing over it');

    await openThePill(grid, '600');
    pill = await geo(openPill(grid, '600'), 'the open pill');
    expect([pill.top, pill.height], 'the open pill: a header of 32 and three rows of 44').toEqual([60, 164]);
    label = await labelFacts(standup);
    expectLabelRead(label, '⛔ Stand-up', 'open');
    expectInLane(label, pill, 'open');
    expectStopsShort(pill, W, 'the open pill');
    const open = await pillFacts(openPill(grid, '600'));
    expectLabelWhole(open, '3 sessions at this time', 'the open pill');
    expectWholeDots(open, ['p-3', 'p-2', 'p-1'], 'the open pill');
    expect(await lanes(grid)).toEqual(['band:⛔ Stand-up', 'pill:600']);
    expectFullWidth(await geo(block(grid, 'i-brk105'), 'BRK105'), W, 'BRK105, below the open pill');
  });

  test('blocked time 11:00 to 12:00 under the Must at 11:00: the session stops short and "Call" is read beside it', async ({ page, viewport }) => {
    await openPlan(page, { blocks: [...BLOCKS, blocked('call', 'Call', TUE, 660, 720)] });
    await expect(missedBecause(page, 'i-brk105')).toHaveText('During Call (blocked time)');

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    const band = await geo(bandCalled(grid, 'Call'), 'the Call band');
    const must = await geo(block(grid, 'i-brk105'), 'BRK105');
    expect([band.top, band.height, must.top, must.height], 'both start 120 units down').toEqual([120, 60, 120, 45]);
    await expect(block(grid, 'i-brk105'), 'still one session, not half of a pair').toHaveAttribute('data-cols', '1');

    const label = await labelFacts(bandCalled(grid, 'Call'));
    expectLabelRead(label, '⛔ Call', 'the Call band');
    expectInLane(label, must, 'the Call band');
    expectStopsShort(must, W, 'BRK105');
    expect(band.lane, 'the band is marked data-lane').toBe(true);
    // Everything that is not over that label is as wide as before.
    expect(await lanes(grid)).toEqual(['band:⛔ Call', 'block:i-brk105']);
    expectFullWidth(await geo(closedPill(grid, '600'), 'the 10:00 pill'), W, 'the 10:00 pill');
    expectFullWidth(await geo(block(grid, 'i-brk109'), 'BRK109'), W, 'BRK109, at 3:00');
    expectFullWidth(await geo(block(grid, 'i-brk108'), 'BRK108'), W, 'BRK108, at 4:00');
  });

  test('a label of a few words takes two lines in the lane when its band is tall enough for two, and one cut line when it is not', async ({ page, viewport }) => {
    // The same label twice, each under a session that starts with it: an hour from 11:00 under
    // the Must at 11:00, and half an hour from 4:00 PM under BRK108.
    await openPlan(page, { blocks: [...BLOCKS, blocked('tall', 'Team sync call', TUE, 660, 720), blocked('short', 'Team sync call', TUE, 960, 990)] });
    await expect(missedBecause(page, 'i-brk105')).toHaveText('During Team sync call (blocked time)');
    await expect(missedBecause(page, 'i-brk108')).toHaveText('During Team sync call (blocked time)');

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    const bands = bandCalled(grid, 'Team sync call');
    await expect(bands).toHaveCount(2);
    const tall = bands.nth(0), short = bands.nth(1);
    expect([(await geo(tall, 'the hour')).height, (await geo(short, 'the half hour')).height]).toEqual([60, 30]);
    const must = await geo(block(grid, 'i-brk105'), 'BRK105'), last = await geo(block(grid, 'i-brk108'), 'BRK108');
    expectStopsShort(must, W, 'BRK105');
    expectStopsShort(last, W, 'BRK108');

    // An hour: two lines of 16px, nothing cut either way.
    const two = await labelFacts(tall), twoLines = await labelLines(tall);
    expectLabelRead(two, '⛔ Team sync call', 'the label in the hour');
    expectInLane(two, must, 'the label in the hour');
    expect(twoLines.height, 'two lines').toBe(32);
    expect(twoLines.scrollHeight, 'no line is cut off').toBeLessThanOrEqual(twoLines.clientHeight);

    // Half an hour has room for one line: the same label is one line, cut to the lane.
    const one = await labelFacts(short), oneLine = await labelLines(short);
    expectLabelRead(one, '⛔ Team sync call', 'the label in the half hour', { whole: false });
    expectInLane(one, last, 'the label in the half hour');
    expect(oneLine.height, 'one line').toBe(16);
    expect(one.scrollWidth, 'the line is longer than the lane').toBeGreaterThan(one.clientWidth);
    await expect(short.locator('.g-band-label')).toHaveCSS('text-overflow', 'ellipsis');
  });

  test('a label keeps to one line when a later full-width session is drawn where its second line would be, and takes two when that session starts under it', async ({ page, viewport }) => {
    // Two hours of blocked time with the same label, each under a 15-minute session that starts
    // with it (so the label is in a lane) and a second session that keeps its full width:
    // 7:00 AM, where the second starts 20 minutes in (inside the second line, units 15 to 31), and
    // 5:00 PM, where it starts 31 minutes in (just under the second line).
    const added = [
      extra('FIT601', 'Early one', TUE, '07:00', '07:15', MAYBE), extra('FIT602', 'Early two', TUE, '07:20', '08:00', MAYBE),
      extra('FIT603', 'Late one', TUE, '17:00', '17:15', MAYBE), extra('FIT604', 'Late two', TUE, '17:31', '18:00', MAYBE),
    ];
    await openPlan(page, { added, blocks: [...BLOCKS, blocked('early', 'Team sync call', TUE, 420, 480), blocked('late', 'Team sync call', TUE, 1020, 1080)] });
    for (const a of added) await expect(missedBecause(page, a.key)).toHaveText('During Team sync call (blocked time)');

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    const bands = bandCalled(grid, 'Team sync call');
    await expect(bands).toHaveCount(2);
    const facts = async (band, firstKey, secondKey, what) => {
      const b = await geo(band, `the ${what} band`), one = await geo(block(grid, firstKey), firstKey), two = await geo(block(grid, secondKey), secondKey);
      expect([b.height, b.lane, one.top - b.top], `${what}: an hour, in a lane, the first session starts with it`).toEqual([60, true, 0]);
      expectStopsShort(one, W, firstKey);
      expectFullWidth(two, W, secondKey);
      return { below: two.top - b.top, first: one, label: await labelFacts(band), lines: await labelLines(band) };
    };

    // The second session is drawn over where a second line would be: the label is one line, cut
    // to the lane, and all of it can still be read.
    const covered = await facts(bands.nth(0), 'i-fit601', 'i-fit602', '7:00 AM');
    expect(covered.below, 'the second session starts 20 units down the band').toBe(20);
    expect(covered.lines.height, 'one line').toBe(16);
    expectLabelRead(covered.label, '⛔ Team sync call', 'the 7:00 AM label', { whole: false });
    expectInLane(covered.label, covered.first, 'the 7:00 AM label');
    expect(covered.label.scrollWidth, 'the line is longer than the lane').toBeGreaterThan(covered.label.clientWidth);

    // The second session starts under the second line: the label takes both, with nothing over it.
    const clear = await facts(bands.nth(1), 'i-fit603', 'i-fit604', '5:00 PM');
    expect(clear.below, 'the second session starts 31 units down the band').toBe(31);
    expect(clear.lines.height, 'two lines').toBe(32);
    expect(clear.lines.scrollHeight, 'no line is cut off').toBeLessThanOrEqual(clear.lines.clientHeight);
    expectLabelRead(clear.label, '⛔ Team sync call', 'the 5:00 PM label');
    expectInLane(clear.label, clear.first, 'the 5:00 PM label');
  });

  test('a blocked-time label too long for the lane ends in an ellipsis inside the lane, never under the session; with nothing over it, a long label is whole', async ({ page, viewport }) => {
    // Two long labels: one from 11:00 to 12:00, under the Must at 11:00, and one from 5:00 to
    // 5:30 PM, which starts where the last session of the day ends.
    const title = 'Quarterly planning with the leadership team', free = 'Travel to the airport with the team';
    await openPlan(page, { blocks: [...BLOCKS, blocked('long', title, TUE, 660, 720), blocked('free', free, TUE, 1020, 1050)] });
    await expect(missedBecause(page, 'i-brk105')).toHaveText(`During ${title} (blocked time)`);
    expect(await timelineCards(page), 'BRK108, 4:00 to 5:00, is still in the plan').toContain('i-brk108');

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    const must = await geo(block(grid, 'i-brk105'), 'BRK105');
    expectStopsShort(must, W, 'BRK105');

    const label = await labelFacts(bandCalled(grid, title));
    // The whole text is still in the page; what is drawn of it is cut to the lane.
    expectLabelRead(label, `⛔ ${title}`, 'the long label', { whole: false });
    // An hour has room for two lines; this label needs more, so its second line is cut.
    const lines = await labelLines(bandCalled(grid, title));
    expect(lines.height, 'two lines').toBe(32);
    expect(lines.scrollHeight, 'the label is longer than the room it has').toBeGreaterThan(lines.clientHeight);
    expectInLane(label, must, 'the long label');
    expect(label.width, 'the label fills the lane, less the 6px around it').toBeCloseTo(LANE - 6, 0);
    // An ellipsis is drawn only where the box both clips and asks for one.
    await expect(bandCalled(grid, title).locator('.g-band-label')).toHaveCSS('text-overflow', 'ellipsis');
    await expect(bandCalled(grid, title).locator('.g-band-label')).toHaveCSS('overflow-x', 'hidden');

    // The other long label has nothing over it, so it is not kept to a lane: all of it is drawn.
    const band = await geo(bandCalled(grid, free), 'the 5:00 PM band');
    expect([band.top, band.height, band.lane], 'from 5:00 PM, 480 units down, not marked data-lane').toEqual([480, 30, false]);
    expectFullWidth(await geo(block(grid, 'i-brk108'), 'BRK108'), W, 'BRK108, which ends where that band starts');
    const whole = await labelFacts(bandCalled(grid, free));
    expectLabelRead(whole, `⛔ ${free}`, 'the long label with nothing over it');
    expect(whole.width, 'it is wider than a lane, and whole').toBeGreaterThan(LANE);
    expect(await lanes(grid)).toEqual([`band:⛔ ${title}`, 'block:i-brk105']);
  });

  test('a pair whose right half starts with blocked time: both halves stay equal and end where the lane starts, and "Review" is read beside them', async ({ page, viewport }) => {
    await openPlan(page, { blocks: [...BLOCKS, blocked('review', 'Review', TUE, 840, 870)] });
    // BRK106 (1:30 to 2:30) and BRK107 (2:00 to 3:00) both run into the blocked time.
    await expect(missedBecause(page, 'i-brk106')).toHaveText('During Review (blocked time)');
    await expect(missedBecause(page, 'i-brk107')).toHaveText('During Review (blocked time)');

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    await expect(block(grid, 'i-brk106')).toHaveAttribute('data-col', '0');
    await expect(block(grid, 'i-brk107')).toHaveAttribute('data-col', '1');
    const band = await geo(bandCalled(grid, 'Review'), 'the Review band');
    const left = await geo(block(grid, 'i-brk106'), 'BRK106'), right = await geo(block(grid, 'i-brk107'), 'BRK107');
    expect([band.top, band.height, left.top, right.top], 'the right half starts with the band, 300 units down').toEqual([300, 30, 270, 300]);

    const label = await labelFacts(bandCalled(grid, 'Review'));
    expectLabelRead(label, '⛔ Review', 'the Review band');
    expectInLane(label, right, 'the Review band');
    // The pair shares what is left of the row: the band area (W - 46) less both insets, the lane
    // and the gap, halved.
    expect([left.lane, right.lane, band.lane], 'both halves and the band are marked data-lane').toEqual([true, true, true]);
    expect(left.left, 'the left half starts after the hour gutter').toBeCloseTo(LEFT, 0);
    expect(right.right, 'the right half stops a lane short of the right edge').toBeCloseTo(W - INSET - LANE, 0);
    expect(left.width, 'the left half').toBeCloseTo((W - GUTTER - 2 * INSET - LANE - GAP) / 2, 0);
    expect(right.width, 'the right half is as wide as the left').toBeCloseTo(left.width, 1);
    expect(right.left - left.right, 'the gap between the halves').toBeCloseTo(GAP, 0);
    expect(await lanes(grid)).toEqual(['band:⛔ Review', 'block:i-brk106', 'block:i-brk107']);
    expectFullWidth(await geo(block(grid, 'i-brk109'), 'BRK109'), W, 'BRK109, at 3:00');
  });

  test('lunch under a session that starts with it: the session stops short and "Lunch" is read beside it', async ({ page, viewport }) => {
    // A Maybe from 12:00 to 12:30 on Tuesday, when lunch is 12:00 to 12:45.
    const overLunch = extra('FIT500', 'Lunch and learn', TUE, '12:00', '12:30', MAYBE);
    await openPlan(page, { added: [overLunch] });
    // The plan keeps lunch and drops the Maybe.
    await expect(page.locator('#main .timeline .t-lunch .t-time')).toHaveText('12:00 PM12:45 PM');
    await expect(missedBecause(page, 'i-fit500')).toBeVisible();

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    const band = await geo(bandCalled(grid, 'Lunch'), 'the lunch band');
    const maybe = await geo(block(grid, 'i-fit500'), 'FIT500');
    expect([band.top, band.height, maybe.top, maybe.height], 'both start 180 units down').toEqual([180, 45, 180, 30]);

    const label = await labelFacts(bandCalled(grid, 'Lunch'));
    expectLabelRead(label, '🍽 Lunch', 'the lunch band');
    expectInLane(label, maybe, 'the lunch band');
    expectStopsShort(maybe, W, 'FIT500');
    expect(band.lane, 'the band is marked data-lane').toBe(true);
    expect(await lanes(grid)).toEqual(['band:🍽 Lunch', 'block:i-fit500']);
  });

  test('ninety-nine sessions under blocked time: at every width from 320px the narrowed pill shows whole dots or none, and from 390px up its whole label', async ({ page, viewport }) => {
    // Friday, 99 picks from 2:00 to 2:45 PM inside blocked time from 2:00 to 3:00.
    const many = together(99, FRI, '14:00', '14:45', i => (i === 0 ? MUST : i === 1 ? WANT : MAYBE));
    await openPlan(page, { day: FRI, blocks: [...BLOCKS, blocked('demo', 'Demo', FRI, 840, 900)], added: many });
    await expect(page.locator('#main .sacrifices [data-card]')).toHaveCount(99);
    await expect(missedBecause(page, 'i-fit001')).toHaveText('During Demo (blocked time)');
    await expect(missedBecause(page, 'i-fit099')).toHaveText('During Demo (blocked time)');

    const grid = await showGrid(page, FRI);
    const W = await expectGridWidth(grid, viewport);
    const pill = await geo(closedPill(grid, '840'), 'the pill');
    expectStopsShort(pill, W, 'the pill');
    const ratings = ['p-3', 'p-2', ...Array(97).fill('p-1')];
    const facts = await pillFacts(closedPill(grid, '840'));
    expectLabelWhole(facts, '99 sessions at this time', 'the pill');
    expectWholeDots(facts, ratings, 'the pill');
    const label = await labelFacts(bandCalled(grid, 'Demo'));
    expectLabelRead(label, '⛔ Demo', 'the Demo band');
    expectInLane(label, pill, 'the Demo band');

    // Every width from 320px to 420px: the room left for dots goes from none to a few, so a
    // first dot that only half fits would show somewhere on the way. (Inside its border and
    // padding the pill is 121px wide at 320px and 221px at 420px. Beside the words it needs 23px
    // for the chevron and 17px for a first dot, and the words are 121px to 168px in the fonts
    // tried: no dot at 320px, at least one at 420px.)
    const shownAt = {};
    for (let width = 320; width <= 420; width++) {
      await page.setViewportSize({ width, height: viewport.height });
      const f = await pillFacts(closedPill(grid, '840'));
      shownAt[width] = expectWholeDots(f, ratings, `${width}px wide`);
      if (width >= 390) expectLabelWhole(f, '99 sessions at this time', `${width}px wide`);
    }
    // The sweep did go from no room for a dot to room for some, and never back.
    expect(shownAt[320], 'at 320px there is no room for a dot').toBe(0);
    expect(shownAt[420], 'at 420px there is room for at least one').toBeGreaterThanOrEqual(1);
    const counts = Object.values(shownAt);
    expect(counts.every((n, i) => i === 0 || n >= counts[i - 1]), `a wider pill never shows fewer dots (${counts.join(' ')})`).toBe(true);
  });
});

// ================================================================ nothing over a label

test.describe('a session that is not over a band\'s label keeps its full width', () => {
  test('a session that starts 15 minutes after blocked time is full width, and the band\'s label is read above it', async ({ page, viewport }) => {
    // Wednesday: blocked time from 3:40, BRK207 from 3:55 to 4:40. 15 units is the height of a
    // label (BAND_LABEL in grid.js): the nearest a session can start and leave it readable.
    await openPlan(page, { day: WED, blocks: [...BLOCKS, blocked('sync', 'Sync', WED, 940, 985)] });
    await expect(missedBecause(page, 'i-brk207')).toHaveText('During Sync (blocked time)');

    const grid = await showGrid(page, WED);
    const W = await expectGridWidth(grid, viewport);
    const band = await geo(bandCalled(grid, 'Sync'), 'the Sync band');
    const later = await geo(block(grid, 'i-brk207'), 'BRK207');
    expect([band.top, band.height, later.top, later.height], 'the session starts 15 units below the top of the band').toEqual([400, 45, 415, 45]);

    expectFullWidth(later, W, 'BRK207');
    expect(band.lane, 'the band is not marked data-lane').toBe(false);
    expectLabelRead(await labelFacts(bandCalled(grid, 'Sync')), '⛔ Sync', 'the Sync band');
    // Nothing on the day is marked, while the day does have sessions, pills and bands.
    await expect(grid.locator('[data-lane]')).toHaveCount(0);
    await expect(grid.locator('.g-block')).toHaveCount(5);
    await expect(grid.locator('.g-pill')).toHaveCount(2);
    await expect(grid.locator('.g-band')).toHaveCount(2);
  });

  test('a day where nothing covers a label has no data-lane anywhere and every session keeps its width', async ({ page, viewport }) => {
    await openPlan(page);
    expect(await timelineCards(page)).toEqual(['i-brk102', 'i-brk105', 'i-brk106', 'i-brk109', 'i-brk108']);

    const grid = await showGrid(page, TUE);
    const W = await expectGridWidth(grid, viewport);
    // Booth duty 9:00 to 10:00 and lunch 12:00 to 12:45: no session or pill starts inside either.
    await expect(grid.locator('.g-band')).toHaveCount(2);
    await expect(grid.locator('.g-block')).toHaveCount(5);
    await expect(grid.locator('.g-pill')).toHaveCount(1);
    await expect(grid.locator('[data-lane]')).toHaveCount(0);

    expectFullWidth(await geo(closedPill(grid, '600'), 'the pill'), W, 'the pill');
    for (const key of ['i-brk105', 'i-brk109', 'i-brk108']) expectFullWidth(await geo(block(grid, key), key), W, key);
    // The pair: the band area less both insets and the gap, halved.
    const left = await geo(block(grid, 'i-brk106'), 'BRK106'), right = await geo(block(grid, 'i-brk107'), 'BRK107');
    expect([left.lane, right.lane]).toEqual([false, false]);
    expect(left.left).toBeCloseTo(LEFT, 0);
    expect(right.right).toBeCloseTo(W - INSET, 0);
    expect(left.width, 'the left half').toBeCloseTo((W - GUTTER - 2 * INSET - GAP) / 2, 0);
    expect(right.width, 'the right half').toBeCloseTo((W - GUTTER - 2 * INSET - GAP) / 2, 0);
    expect(right.left - left.right, 'the gap between the halves').toBeCloseTo(GAP, 0);
    expectLabelRead(await labelFacts(bandCalled(grid, 'Booth duty')), '⛔ Booth duty', 'Booth duty');
    expectLabelRead(await labelFacts(bandCalled(grid, 'Lunch')), '🍽 Lunch', 'lunch');

    // Opening the pill changes no width.
    await openThePill(grid, '600');
    await expect(grid.locator('[data-lane]')).toHaveCount(0);
    expectFullWidth(await geo(openPill(grid, '600'), 'the open pill'), W, 'the open pill');
    expectFullWidth(await geo(block(grid, 'i-brk105'), 'BRK105'), W, 'BRK105, below the open pill');
  });
});

// ================================================================ what a block shows at each height

// A block's layout changes with its height (assets/css/app.css, the @container rules of
// .g-block): under 30 minutes one line with no room; from 30 the title over the time and room;
// from 44 a second line of title; from 70 the room on a line of its own; from 84 a third line of
// title. Each change is checked on both sides, a minute apart.
test.describe('what a session block shows depends on how tall it is', () => {
  // Long enough for more than three lines on either phone, so the number of lines shown is the
  // number the block allows.
  const TITLE = 'A session whose title is long enough to need more than three whole lines on a phone, so that how many lines of it a block shows is decided by how tall the block is and never by the words running out';
  // Each part of a block, measured from the top of the block's clipped area (.g-in): shown or
  // not, where it starts, how tall it is, and whether its box is inside that area.
  const parts = blockEl => blockEl.evaluate(el => {
    el.scrollIntoView({ block: 'center' });
    const px = v => Math.round(v * 100) / 100;
    const clip = el.querySelector('.g-in');
    clip.scrollTop = 0;   // measured unscrolled: a clipped area can still be scrolled by script
    const c = clip.getBoundingClientRect();
    const part = sel => {
      const e = el.querySelector(sel), r = e.getBoundingClientRect();
      const shown = getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0;
      if (!shown) return { shown };
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        shown, top: px(r.top - c.top), height: px(r.height),
        inside: r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5,
        onTop: !!hit && (hit === e || e.contains(hit)),
      };
    };
    const across = sel => { const r = el.querySelector(sel).getBoundingClientRect(); return { left: px(r.left - c.left), right: px(r.right - c.left) }; };
    return {
      clips: getComputedStyle(clip).overflowY, height: px(el.getBoundingClientRect().height),
      title: part('.g-title'), time: part('.g-time'), room: part('.g-room'), titleAcross: across('.g-title'), timeAcross: across('.g-time'),
    };
  });
  const shownAt = (top, height) => ({ shown: true, top, height, inside: true, onTop: true });

  // minutes, start, end, and what is expected: the title's lines (14px each), and the room:
  // 'none' (not shown), 'beside' (on the time's line) or 'below' (a line of its own).
  const CASES = [
    [29, '00:00', '00:29', { titleLines: 1, oneLine: true, room: 'none' }],
    [30, '00:40', '01:10', { titleLines: 1, room: 'beside' }],
    [43, '01:20', '02:03', { titleLines: 1, room: 'beside' }],
    [44, '02:10', '02:54', { titleLines: 2, room: 'beside' }],
    [69, '03:00', '04:09', { titleLines: 2, room: 'beside' }],
    [70, '04:15', '05:25', { titleLines: 2, room: 'below' }],
    [83, '05:30', '06:53', { titleLines: 2, room: 'below' }],
    [84, '07:00', '08:24', { titleLines: 3, room: 'below' }],
  ];

  test('on both sides of 30, 44, 70 and 84 minutes: the lines of title, and the room hidden, beside the time or on its own line, all inside the block', async ({ page, viewport }) => {
    // Friday has no picks of its own: eight sessions before 9 AM, none overlapping another.
    const added = CASES.map(([min, from, to]) => extra(`FIT7${String(min).padStart(2, '0')}`, TITLE, FRI, from, to, WANT));
    await openPlan(page, { day: FRI, added });
    const grid = await showGrid(page, FRI);
    const W = await expectGridWidth(grid, viewport);
    await expect(grid.locator('.g-block')).toHaveCount(8);
    await expect(grid.locator('.g-pill')).toHaveCount(0);

    for (const [i, [min, , , want]] of CASES.entries()) {
      const what = `${min} minutes`;
      const el = block(grid, added[i].key);
      expectFullWidth(await geo(el, what), W, what);
      const f = await parts(el);
      expect([f.height, f.clips], `${what}: as tall as it is long, and it clips what does not fit`).toEqual([min, 'hidden']);
      await expect(el.locator('.g-title'), what).toHaveText(TITLE);
      await expect(el.locator('.g-room'), what).toHaveText('Moscone West, Level 2, Room 2001');

      if (want.oneLine) {
        // One line: the time, then the title to its right, each box the full height of the
        // clipped area (27px less the 1px above), and no room.
        expect(f.time, `${what}: the time`).toEqual(shownAt(1, 26));
        expect(f.title, `${what}: the title, on the time's line`).toEqual(shownAt(1, 26));
        expect(f.titleAcross.left, `${what}: the title starts 8px after the time ends`).toBeCloseTo(f.timeAcross.right + 8, 0);
        expect(f.room, `${what}: the room`).toEqual({ shown: false });
        continue;
      }
      const under = 1 + 14 * want.titleLines;   // 1px of padding, then the title's lines
      expect(f.title, `${what}: ${want.titleLines} line(s) of title`).toEqual(shownAt(1, 14 * want.titleLines));
      expect(f.time, `${what}: the time, under the title`).toEqual(shownAt(under, 13));
      expect(f.room, `${what}: the room, ${want.room} the time`).toEqual(shownAt(want.room === 'below' ? under + 13 : under, 13));
      expect(f.titleAcross.left, `${what}: the title starts at the left of the block, as the time does`).toBeCloseTo(f.timeAcross.left, 0);
    }
  });
});
