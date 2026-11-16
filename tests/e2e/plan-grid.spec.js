// The List / Grid switch on My plan, in a real browser (issue #155,
// specs/features/plan-grid-view.feature). The layout rules themselves live in the pure module
// assets/js/grid.js and are tested without a browser; this suite covers what only exists once
// the page is drawn: the switch, what it saves, the grid's real pixels, pills opening and
// closing, and taps.
//
// Each test name starts with the title of the scenario it covers, or with "beyond the feature
// file" where the page does something no scenario names. The suite is deterministic: its own
// two catalogs and saved picks (plan-grid.fixture.js), no request leaves the local server, the
// page's clock is fixed and the browser runs in a time zone that is not the conference's.
//
// Every test first asserts what is already true without the feature (the fixture boots in
// scheduled mode, My plan lists the seeded day), so a failure before that point is a broken
// harness and a failure after it is about the switch or the grid.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect as baseExpect } from '@playwright/test';
import { serveFixture, seedState, CATALOGS, FIXED_NOW, KEYS, BLOCKS, TUE, WED, THU, FRI, RIV_MON, RIV_TUE, RIV_WED } from './plan-grid.fixture.js';

const expect = baseExpect.configure({ timeout: 4000 });
const BOOT_TIMEOUT = 15_000;

test.use({ timezoneId: 'Asia/Tokyo', locale: 'en-US', serviceWorkers: 'block', actionTimeout: 5000, navigationTimeout: 15_000 });

let traffic;      // what the page asked for (see serveFixture)
let pageErrors;   // uncaught exceptions in any page of the test

test.beforeEach(async ({ context, baseURL }) => {
  test.setTimeout(45_000);
  pageErrors = [];
  context.on('weberror', e => pageErrors.push(String(e.error())));
  await context.clock.setFixedTime(new Date(FIXED_NOW));
  traffic = await serveFixture(context, baseURL);
});

test.afterEach(() => {
  expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

// ---------------------------------------------------------------- the page as it is today

// What My plan shows for each fixture conference when it opens: true with or without the grid.
const BOOTED = {
  ignite2026: {
    title: 'Ignite Planner',
    status: '31 sessions · 29 timed',     // "timed" is only shown in the scheduled (official) mode
    tabs: [`${TUE}:true`, `${WED}:false`, `${THU}:false`, `${FRI}:false`],
    timeline: ['i-brk102', 'i-brk105', 'i-brk106', 'i-brk109', 'i-brk108'],
  },
  reinvent2026: {
    title: 're:Invent Planner',
    status: '9 sessions · 9 timed',
    tabs: [`${RIV_MON}:true`, `${RIV_TUE}:false`, `${RIV_WED}:false`],
    timeline: ['i-riv101', 'i-riv102'],
  },
};

const dayTabs = page => page.locator('#main .daytabs [data-act="day"]')
  .evaluateAll(els => els.map(b => `${b.dataset.day}:${b.getAttribute('aria-pressed')}`));
// The sessions the list shows for the day, in order (blocked time and lunch are rows without a card).
const timelineCards = page => page.locator('#main .timeline .t-item [data-card]').evaluateAll(els => els.map(e => e.dataset.card));
const missed = page => page.locator('#main .sacrifices [data-card]').evaluateAll(els => els.map(e => e.dataset.card).sort());

// The day's list is its picks and nothing else: every row is a session (`rows` is each one's
// run key and the start and end the list prints), there is no blocked time and no lunch. The
// re:Invent fixture is like this, so its days' ranges are its picks'. `dropped` is every pick
// of the day the plan left out, with the time "What you'll miss" prints for it: none on
// re:Invent's Monday and Tuesday.
async function expectPicksOnly(page, rows, dropped = []) {
  expect(await timelineCards(page), 'the sessions the list shows').toEqual(rows.map(r => r[0]));
  const items = page.locator('#main .timeline > .t-item');
  await expect(items, 'every row of the list is a session: no blocked time').toHaveCount(rows.length);
  for (const [i, [key, time]] of rows.entries()) {
    await expect(items.nth(i).locator('[data-card]'), `row ${i + 1}`).toHaveAttribute('data-card', key);
    await expect(items.nth(i).locator('.t-time'), `${key}: start and end`).toHaveText(time);
  }
  await expect(page.locator('#main .t-lunch'), 'no lunch').toHaveCount(0);
  await expect(page.locator('#main .sacrifices [data-card]'), dropped.length ? 'the picks the plan dropped' : 'nothing dropped').toHaveCount(dropped.length);
  for (const [key, time] of dropped) await expect(page.locator(`#main .sacrifices [data-card="${key}"] .meta`), `${key}: dropped`).toContainText(time);
}

// re:Invent Wednesday as the list shows it, the day of "Three sessions spread over three hours":
// RIV201 (9:00-10:30), RIV202 (10:00-11:30) and RIV203 (11:00-12:00) are linked by overlaps and
// together run 9:00 to 12:00; the plan drops RIV202, the one in the middle. RIV204 follows from
// 12:00 to 12:45.
const RIV_WEDNESDAY = {
  rows: [['i-riv201', '9:00 AM10:30 AM'], ['i-riv203', '11:00 AM12:00 PM'], ['i-riv204', '12:00 PM12:45 PM']],
  dropped: [['i-riv202', '10:00 AM–11:30 AM']],
};

// `list: false` skips the timeline: used where the page is expected to open on the grid.
async function expectPlanBooted(page, conf, { list = true } = {}) {
  const b = BOOTED[conf];
  await expect(page).toHaveTitle(b.title, { timeout: BOOT_TIMEOUT });
  await expect(page.locator('#main h1')).toHaveText('My plan', { timeout: BOOT_TIMEOUT });
  await expect(page.locator('#sync-status')).toContainText(b.status);
  expect(await dayTabs(page), 'the day tabs, the first day selected').toEqual(b.tabs);
  if (list) expect(await timelineCards(page), 'the day as the existing list').toEqual(b.timeline);
}

// Seeds saved state, opens My plan and checks the harness. `state` patches the seeded state
// (fixture seedState): { ignite: { ui, blocks }, reinvent: { ui } }.
async function openPlan(page, { conf = 'ignite2026', state, list = true } = {}) {
  await seedState(page.context(), state);
  await page.goto(conf === 'ignite2026' ? '/#/plan' : `/?conf=${conf}#/plan`);
  await expectPlanBooted(page, conf, { list });
}

// The conference switch in the header reloads the page for the other conference.
async function switchConference(page, conf) {
  await page.selectOption('#conf-switch', conf);
  await expectPlanBooted(page, conf, { list: false });
}

async function tapDay(page, day) {
  const tab = page.locator(`#main .daytabs [data-act="day"][data-day="${day}"]`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

// The saved ui state of a conference, as it is in storage now and as it was when the app booted.
const savedUi = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '{}').ui || {}, key);
const uiAtBoot = (page, key) => page.evaluate(k => JSON.parse(window.__savedAtBoot[k]).ui, key);
// The store saves about 150 ms after a change: wait for the value itself.
const expectSavedView = (page, key, view) => expect
  .poll(async () => (await savedUi(page, key)).planView, { message: `ui.planView saved under ${key}` }).toBe(view);

// My plan's parts by heading. With `strip`, the two parts the switch may change (the day-view
// wrapper and the switch itself) are removed first, and `html` is everything that is left.
const readPlan = (page, { strip = false } = {}) => page.evaluate(strip => {
  const text = e => e.textContent.replace(/\s+/g, ' ').trim();
  const main = document.querySelector('#main').cloneNode(true);
  const removed = { wrappers: 0, switches: 0 };
  if (strip) {
    for (const el of main.querySelectorAll('[data-day-view]')) { el.remove(); removed.wrappers++; }
    for (const el of main.querySelectorAll('[role="group"][aria-label="Day view"]')) { el.remove(); removed.switches++; }
  }
  const sections = {};
  for (const h of main.querySelectorAll('h2')) {
    const cards = [];
    for (let n = h.nextElementSibling; n && n.tagName !== 'H2' && !n.querySelector('h2'); n = n.nextElementSibling) {
      if (n.matches('[data-card]')) cards.push(n.dataset.card);
      for (const c of n.querySelectorAll('[data-card]')) cards.push(c.dataset.card);
    }
    sections[text(h)] = cards.sort();
  }
  return {
    removed,
    html: main.innerHTML.replace(/\s+/g, ' ').trim(),
    days: [...main.querySelectorAll('.daytabs [data-act="day"]')].map(b => `${b.dataset.day}:${b.getAttribute('aria-pressed')}`),
    clashes: [...main.querySelectorAll('section.decision header')].map(text),
    sections,
  };
}, strip);

// The parts of Tuesday's page that the "Switching to the grid" scenario names, as the fixture
// fills them: day tabs, clashes, what you'll miss, picks without a time, watch later, suggested
// and online.
const TUESDAY_AROUND = {
  days: [`${TUE}:true`, `${WED}:false`, `${THU}:false`, `${FRI}:false`],
  clashes: ['10:00 AM · 3 picks clash · ranked for you', '1:30 PM · 2 picks clash · ranked for you'],
  sections: {
    'Clashes on Tuesday, November 17': [],
    "What you'll miss on Tue, Nov 17": ['i-brk101', 'i-brk103', 'i-brk107'],
    'Picks without a time yet': ['i-brk401'],
    'Watch later (1)': ['i-brk104'],
    'Suggested for you': ['i-brk501', 'i-brk502', 'i-brk503'],
    'Online / on demand': ['i-brk402'],
  },
};

// ---------------------------------------------------------------- the switch and the grid

const viewSwitch = page => page.locator('#main [role="group"][aria-label="Day view"]');
const viewButton = (page, view) => viewSwitch(page).locator(`[data-act="plan-view"][data-view="${view}"]`);
const dayView = page => page.locator('#main [data-day-view]');
const dayGrid = (page, day) => page.locator(`#main [data-day-view="grid"] .daygrid[data-grid-day="${day}"]`);

// The switch is there, shows `selected`, and the page holds exactly one day view of that kind.
async function expectSwitch(page, selected) {
  await expect(viewSwitch(page), 'the List / Grid switch: [role="group"][aria-label="Day view"]').toBeVisible();
  await expect(viewSwitch(page)).toHaveCount(1);
  await expect(viewButton(page, 'list')).toHaveText('List');
  await expect(viewButton(page, 'grid')).toHaveText('Grid');
  await expect(viewButton(page, selected), `"${selected}" is the selected view`).toHaveAttribute('aria-pressed', 'true');
  await expect(viewButton(page, selected === 'list' ? 'grid' : 'list')).toHaveAttribute('aria-pressed', 'false');
  await expect(dayView(page)).toHaveCount(1);
  await expect(dayView(page)).toHaveAttribute('data-day-view', selected);
}

async function choose(page, view) {
  await expect(viewSwitch(page), 'the List / Grid switch: [role="group"][aria-label="Day view"]').toBeVisible();
  await viewButton(page, view).click();
  await expectSwitch(page, view);
}

// From the list My plan opens on (Tuesday): choose Grid, go to `day`, return that day's grid.
async function showGrid(page, day = TUE) {
  await choose(page, 'grid');
  if (day !== TUE) await tapDay(page, day);
  const grid = dayGrid(page, day);
  await expect(grid, `the grid for ${day}`).toBeVisible();
  await expect(page.locator('#main .daygrid')).toHaveCount(1);
  return grid;
}

// Hour lines, in time order. `top` is real layout pixels from the top of .daygrid (summed up
// the offset parents, so a label nudged with a transform does not move its line); `reachesGrid`
// is false if the line is not positioned inside .daygrid at all.
const hourLines = grid => grid.locator('.g-hour').evaluateAll(els => els.map(e => {
  const g = e.closest('.daygrid');
  let top = 0, n = e;
  for (; n && n !== g; n = n.offsetParent) top += n.offsetTop;
  return { min: Number(e.dataset.min), label: e.textContent.replace(/\s+/g, ' ').trim(), top, reachesGrid: n === g };
}).sort((a, b) => a.min - b.min));
const line = (min, label, top) => ({ min, label, top, reachesGrid: true });
const topOf = (lines, label) => lines.find(l => l.label === label)?.top;

// Tuesday and Wednesday both run 9 AM to 5 PM: one unit a minute, so an hour line every 60.
const NINE_TO_FIVE = [
  line(540, '9 AM', 0), line(600, '10 AM', 60), line(660, '11 AM', 120), line(720, '12 PM', 180), line(780, '1 PM', 240),
  line(840, '2 PM', 300), line(900, '3 PM', 360), line(960, '4 PM', 420), line(1020, '5 PM', 480),
];

// Where an element is drawn, in real pixels measured from the top-left of .daygrid.
async function box(locator, what) {
  await expect(locator, what).toBeVisible();
  return locator.evaluate(el => {
    const g = el.closest('.daygrid'), gr = g.getBoundingClientRect(), r = el.getBoundingClientRect();
    const px = v => Math.round(v * 100) / 100;
    return {
      top: px(r.top - gr.top - g.clientTop), bottom: px(r.bottom - gr.top - g.clientTop), height: px(r.height),
      left: px(r.left - gr.left), right: px(r.right - gr.left), width: px(r.width),
    };
  });
}
// Really drawn where it can be read. toBeVisible is also true of text that has a box but lies
// outside an ancestor that hides its overflow (a block clips what does not fit in its height), so
// this also asks that the box is inside every ancestor up to the grid that clips, that at least
// one does, that the element is what is found at its centre, and that none of its own lines are
// cut off. An ancestor that hides its
// overflow can still be scrolled by script, and scrollIntoView on the element would do exactly
// that and bring clipped text into view: so the page is scrolled as a whole, and each clipping
// ancestor is measured unscrolled, as a person sees it.
async function expectPainted(locator, what) {
  await expect(locator, what).toBeVisible();
  const f = await locator.evaluate(el => {
    const clippers = [], outside = [];
    for (let a = el.parentElement; a && !a.classList.contains('daygrid'); a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      clippers.push(a);
      a.scrollTop = 0;
      a.scrollLeft = 0;
    }
    const at = el.getBoundingClientRect();
    window.scrollBy(0, at.top + at.height / 2 - window.innerHeight / 2);
    const r = el.getBoundingClientRect();
    for (const a of clippers) {
      const c = a.getBoundingClientRect();
      if (r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5 || r.left < c.left - 0.5 || r.right > c.right + 0.5) outside.push(a.className);
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    // uncut: none of its own lines are cut off (a row squeezes its title and room to fit, and each
    // of them hides what no longer fits; being cut short across, with an ellipsis, is allowed).
    // The font's own box is 1px taller than the 13px line of a time or room, so a difference of a
    // pixel is not a cut line; the shortest line here is 13px, and 4px of one missing is.
    return { sized: r.width > 0 && r.height > 0, clipped: clippers.length > 0, outside, onTop: !!hit && (hit === el || el.contains(hit)), uncut: el.scrollHeight - el.clientHeight < 4 };
  });
  expect(f, what).toEqual({ sized: true, clipped: true, outside: [], onTop: true, uncut: true });
}
// One unit is one pixel; anything within half a pixel is that unit.
function expectAt(b, top, height, what) {
  expect(b.top, `${what}: units down from the top of the grid`).toBeCloseTo(top, 0);
  expect(b.height, `${what}: units tall`).toBeCloseTo(height, 0);
}
const gridHeight = grid => grid.evaluate(el => Math.round(el.getBoundingClientRect().height * 100) / 100);

const block = (grid, key) => grid.locator(`button.g-block[data-act="open"][data-key="${key}"]`);
// Every session drawn as a block of its own, by key: how wide it is and its priority class.
const blocks = grid => grid.locator('.g-block').evaluateAll(els => els.map(e => ({
  key: e.dataset.key, tag: e.tagName, act: e.dataset.act, cols: e.dataset.cols,
  prio: ['p-3', 'p-2', 'p-1'].filter(c => e.classList.contains(c)).join(' '),
})).sort((a, b) => (a.key < b.key ? -1 : 1)));
const full = (key, prio) => ({ key, tag: 'BUTTON', act: 'open', cols: '1', prio });
const half = (key, prio) => ({ key, tag: 'BUTTON', act: 'open', cols: '2', prio });

const TUESDAY_BLOCKS = [full('i-brk105', 'p-3'), half('i-brk106', 'p-3'), half('i-brk107', 'p-2'), full('i-brk108', 'p-2'), full('i-brk109', 'p-3')];
const WEDNESDAY_BLOCKS = [full('i-brk201', 'p-2'), full('i-brk206', 'p-3'), full('i-brk207', 'p-1'), full('i-brk214', 'p-2'), full('i-brk310-r1', 'p-2')];
const THURSDAY_BLOCKS = [half('i-brk301', 'p-3'), half('i-brk302', 'p-2'), full('i-brk303', 'p-1'), full('i-brk304', 'p-1'), full('i-brk305', 'p-3')];

// The whole text of a block's .g-time: the session's start and its end, in the app's 12-hour
// form. Accepted: "10:00 AM–10:50 AM" (as a session card writes it), "10:00 AM – 10:50 AM"
// (time.js fmtRange), the list's stacked "10:00 AM10:50 AM", and "10:00–10:50 AM". A start
// alone, a wrong end, or anything before or after the range is not.
const timeRange = (from, to, ap) => new RegExp(`^\\s*${from}(?:\\s*${ap})?\\s*(?:[–—-]|to)?\\s*${to}\\s*${ap}\\s*$`);

const band = (grid, kind) => grid.locator(`.g-band[data-band="${kind}"]`);

// A pill's id is its start in minutes after midnight (grid.js): 10:00 is "600", 1:00 PM "780".
const closedPill = (grid, id) => grid.locator(`button.g-pill[data-act="pill"][data-pill="${id}"][aria-expanded="false"]`);
const openPill = (grid, id) => grid.locator(`div.g-pill.open[data-pill="${id}"]`);
const pillHead = (grid, id) => openPill(grid, id).locator(`button.g-pill-head[data-act="pill"][data-pill="${id}"][aria-expanded="true"]`);
const pillRows = (grid, id) => openPill(grid, id).locator('button.g-row[data-act="open"]');
const dots = pill => pill.locator('.g-dot').evaluateAll(els => els.map(e => ['p-3', 'p-2', 'p-1'].filter(c => e.classList.contains(c)).join(' ')));
const rowKeys = (grid, id) => pillRows(grid, id).evaluateAll(els => els.map(e => e.dataset.key));

async function expectCollapsed(grid, id, label = '3 sessions at this time') {
  await expect(closedPill(grid, id), `the collapsed pill ${id}`).toBeVisible();
  await expect(closedPill(grid, id)).toContainText(label);
  await expect(grid.locator(`[data-pill="${id}"].open`)).toHaveCount(0);
}
async function openThePill(grid, id) {
  await closedPill(grid, id).click();
  await expect(openPill(grid, id), `the open pill ${id}`).toBeVisible();
  await expect(pillHead(grid, id)).toBeVisible();
}

// An open pill's list in real pixels: a header of 32 units at the top of the pill (`pill` is the
// open pill's box), then `rows` rows of 44 units each, stacked (give or take a 1px border).
// Returns where the last row ends, in units down the grid.
async function expectList(grid, id, pill, rows) {
  const head = await box(pillHead(grid, id), 'the pill header');
  expect(head.height, 'header').toBeCloseTo(32, 0);
  expect(Math.abs(head.top - pill.top), 'the header is at the top of the pill').toBeLessThanOrEqual(2);
  await expect(pillRows(grid, id), 'rows').toHaveCount(rows);
  let below = head.bottom;
  for (let i = 0; i < rows; i++) {
    const row = await box(pillRows(grid, id).nth(i), `row ${i + 1}`);
    expect(row.height, `row ${i + 1}`).toBeCloseTo(44, 0);
    expect(row.top, `row ${i + 1} follows what is above it`).toBeCloseTo(below, 0);
    below = row.bottom;
  }
  return below;
}

const detail = page => page.locator('dialog#detail');
async function expectDetails(page, code, title) {
  await expect(detail(page), `the session details dialog for ${code}`).toBeVisible();
  await expect(detail(page).locator('.d-head')).toContainText(code);
  await expect(detail(page).locator('#detail-title')).toHaveText(title);
}
async function closeDetails(page) {
  await detail(page).locator('.d-close').click();
  await expect(detail(page)).toBeHidden();
}

// ================================================================ harness

test.describe('harness', () => {
  // playwright.config.js reuses a server already listening on the port: make sure it is this one.
  test('harness: the local server serves this checkout\'s app', async ({ request }) => {
    for (const path of ['assets/js/app.js', 'assets/js/grid.js', 'specs/features/plan-grid-view.feature']) {
      const res = await request.get(`/${path}`, { timeout: 10_000 });
      expect(res.status(), path).toBe(200);
      expect(await res.text(), `${path} as served is the file in this checkout`)
        .toBe(readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8'));
    }
  });

  test('harness: the Ignite fixture boots in scheduled mode, the live check is blocked, and My plan lists every seeded day', async ({ page }) => {
    await openPlan(page);
    await expect(page.locator('#main .daygrid'), 'no grid before the switch is used').toHaveCount(0);

    // The Ignite planner checked the conference site; the request was refused, so the catalog
    // is still the fixture's ("Offline copy" is what the header says after a failed live check).
    await expect(page.locator('#sync-status')).toContainText('Offline copy');
    await expect(page.locator('#sync-status')).toContainText('31 sessions · 29 timed');
    expect([...new Set(traffic.blocked)], 'hosts refused').toEqual(['eventtools.event.microsoft.com']);
    expect(traffic.data.filter(d => d.startsWith('200')), 'data files served').toEqual(['200 /data/ignite2026/sessions.json']);
    expect(traffic.data.filter(d => !d.startsWith('200')).every(d => d.startsWith('404 /data/ignite2026/')), 'everything else under data/ is absent').toBe(true);
    expect(await uiAtBoot(page, KEYS.ignite2026), 'the switch was never used').toEqual({ tab: 'plan', filters: {}, day: null });

    // Tuesday, in the conference's own time although the browser is in Tokyo.
    expect(await readPlan(page)).toMatchObject(TUESDAY_AROUND);
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.first()).toContainText('Booth duty');
    await expect(rows.first().locator('.t-time')).toHaveText('9:00 AM10:00 AM');
    await expect(page.locator('#main .timeline .t-lunch .t-time')).toHaveText('12:00 PM12:45 PM');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk102"]') }).locator('.t-time')).toHaveText('10:00 AM10:45 AM');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk106"]') }).locator('.t-time')).toHaveText('1:30 PM2:30 PM');
    await expect(rows.last().locator('.t-time')).toHaveText('4:00 PM5:00 PM');
    await expect(page.locator('#main .timeline [data-card="i-brk102"]')).toHaveClass(/\bp-3\b/);
    await expect(page.locator('#main [data-card="i-brk104"] .meta')).toContainText('Tue, Nov 17 · 10:00 AM–10:45 AM');

    await tapDay(page, WED);
    expect(await timelineCards(page)).toEqual(['i-brk201', 'i-brk205', 'i-brk206', 'i-brk213', 'i-brk214', 'i-brk310-r1', 'i-brk207']);
    expect(await missed(page)).toEqual(['i-brk203', 'i-brk204', 'i-brk211', 'i-brk212']);
    await expect(page.locator('#main .timeline > .t-item').first().locator('.t-time')).toHaveText('9:14 AM9:50 AM');
    await expect(page.locator('#main .timeline > .t-item').last().locator('.t-time')).toHaveText('3:55 PM4:40 PM');
    await expect(page.locator('#main .timeline .t-lunch .t-time')).toHaveText('12:00 PM12:45 PM');

    await tapDay(page, THU);
    expect(await timelineCards(page)).toEqual(['i-brk304', 'i-brk305']);
    expect(await missed(page)).toEqual(['i-brk301', 'i-brk302', 'i-brk303']);
    await expect(page.locator('#main .sacrifices [data-card="i-brk301"] .reason')).toHaveText('During Customer meeting (blocked time)');
    await expect(page.locator('#main .sacrifices [data-card="i-brk302"] .reason')).toHaveText('During Customer meeting (blocked time)');
    await expect(page.locator('#main .sacrifices [data-card="i-brk303"] .reason')).toHaveText('Lower value than the rest of the day');
    await expect(page.locator('#main .panel', { hasText: 'Other runs:' }))
      .toContainText("BRK310 clashes with Customer meeting here, so you'll catch BRK310-R1 on Wed, Nov 18 at 3:00 PM");
    await expect(page.locator('#main .timeline > .t-item').last()).toContainText('Customer meeting');
    await expect(page.locator('#main .timeline > .t-item').last().locator('.t-time')).toHaveText('2:00 PM4:00 PM');

    await tapDay(page, FRI);
    await expect(page.locator('#main .panel.empty h3')).toHaveText('Nothing planned on Fri, Nov 20');
    await expect(page.locator('#main .timeline')).toHaveCount(0);
  });

  test('harness: the re:Invent fixture boots in scheduled mode from its own saved picks', async ({ page }) => {
    await openPlan(page, { conf: 'reinvent2026' });
    await expect(page.locator('#sync-status')).toContainText('Catalog snapshot');
    expect(traffic.data.filter(d => d.startsWith('200'))).toEqual(['200 /data/reinvent2026/sessions.json']);
    await expect(page.locator('#main .daygrid')).toHaveCount(0);
    // Monday, picks only (see expectPicksOnly): 9:00 AM to 12:00 PM.
    await expectPicksOnly(page, [['i-riv101', '9:00 AM10:00 AM'], ['i-riv102', '11:00 AM12:00 PM']]);
    // Tuesday, picks only: 9:00 AM to 5:00 PM. RIV103 (10:00) was never rated, so it is not a pick.
    await tapDay(page, RIV_TUE);
    await expectPicksOnly(page, [['i-riv104', '9:00 AM10:00 AM'], ['i-riv105', '4:00 PM5:00 PM']]);
    await expect(page.locator('#main .timeline [data-card="i-riv104"]')).toHaveClass(/\bp-3\b/);
    await expect(page.locator('#main .timeline [data-card="i-riv105"]')).toHaveClass(/\bp-2\b/);
    // Wednesday, picks only: 9:00 AM to 12:45 PM. Three picks linked by overlaps run 9:00 to
    // 12:00 (one clash of three; the plan drops the Maybe in the middle), then the day's one Must.
    await tapDay(page, RIV_WED);
    await expectPicksOnly(page, RIV_WEDNESDAY.rows, RIV_WEDNESDAY.dropped);
    expect((await readPlan(page)).clashes.map(c => c.split(' · ').slice(0, 2).join(' · ')), 'one clash, of all three').toEqual(['9:00 AM · 3 picks clash']);
    await expect(page.locator('#main .timeline [data-card="i-riv201"]')).toHaveClass(/\bp-2\b/);
    await expect(page.locator('#main .timeline [data-card="i-riv203"]')).toHaveClass(/\bp-2\b/);
    await expect(page.locator('#main .timeline [data-card="i-riv204"]')).toHaveClass(/\bp-3\b/);
    await expect(page.locator('#main .sacrifices [data-card="i-riv202"]')).toHaveClass(/\bp-1\b/);
    // The two conferences keep separate saved state: Ignite's picks are not re:Invent's.
    expect(await page.evaluate(keys => keys.map(k => Object.keys(JSON.parse(localStorage.getItem(k)).picks).length), [KEYS.ignite2026, KEYS.reinvent2026]))
      .toEqual([27, 8]);
  });
});

// ================================================================ the feature

test.describe('Rule: The list is the default and the switch is remembered per conference', () => {
  test('First visit: the day is shown as the list and the switch shows "List" as selected', async ({ page }) => {
    await openPlan(page);
    expect((await uiAtBoot(page, KEYS.ignite2026)).planView, 'Minesh has never used the switch').toBeUndefined();

    await expectSwitch(page, 'list');
    expect(await dayView(page).locator('.timeline .t-item [data-card]').evaluateAll(els => els.map(e => e.dataset.card)), 'the list is inside the day view')
      .toEqual(BOOTED.ignite2026.timeline);
    await expect(page.locator('#main .daygrid')).toHaveCount(0);
    await expect(page.locator('#main .g-hour')).toHaveCount(0);
  });

  test('Switching to the grid: Tuesday\'s timed sessions are shown as the grid, not the list, and everything around it is unchanged', async ({ page }) => {
    await openPlan(page);
    // The parts the scenario names are really on the page, so "unchanged" compares something.
    expect(await readPlan(page)).toMatchObject(TUESDAY_AROUND);

    await expectSwitch(page, 'list');
    const before = await readPlan(page, { strip: true });
    expect(before.removed, 'one day view and one switch were set aside').toEqual({ wrappers: 1, switches: 1 });
    expect(before).toMatchObject(TUESDAY_AROUND);

    await viewButton(page, 'grid').click();
    await expectSwitch(page, 'grid');
    const grid = dayGrid(page, TUE);
    await expect(grid).toBeVisible();
    await expect(page.locator('#main .timeline'), 'the list is gone').toHaveCount(0);
    // Every timed pick of Tuesday is on the grid: five as blocks, three in the 10:00 pill.
    expect(await blocks(grid)).toEqual(TUESDAY_BLOCKS);
    await expectCollapsed(grid, '600');
    await expect(grid.locator('.g-pill')).toHaveCount(1);

    const after = await readPlan(page, { strip: true });
    expect(after.removed).toEqual({ wrappers: 1, switches: 1 });
    expect(after).toMatchObject(TUESDAY_AROUND);
    expect(after.html, 'My plan outside the day view and the switch').toBe(before.html);
  });

  test('The grid follows the day tabs: Wednesday is shown as the grid', async ({ page }) => {
    await openPlan(page);
    const tuesday = await showGrid(page);
    expect(await blocks(tuesday)).toEqual(TUESDAY_BLOCKS);

    await tapDay(page, WED);
    await expectSwitch(page, 'grid');
    const wednesday = dayGrid(page, WED);
    await expect(wednesday).toBeVisible();
    await expect(page.locator('#main .daygrid'), 'only the selected day has a grid').toHaveCount(1);
    await expect(page.locator('#main .timeline')).toHaveCount(0);
    expect(await blocks(wednesday)).toEqual(WEDNESDAY_BLOCKS);
    await expectCollapsed(wednesday, '600');
    await expectCollapsed(wednesday, '780');
  });

  test('The choice survives a reload: reopening the Ignite planner shows the grid', async ({ page, context }) => {
    await openPlan(page);
    await showGrid(page);
    await expectSavedView(page, KEYS.ignite2026, 'grid');

    // Reopened as from the Home Screen: a new page at the planner's address, nothing in the URL.
    await page.close();
    const again = await context.newPage();
    await again.goto('/');
    await expectPlanBooted(again, 'ignite2026', { list: false });
    expect((await uiAtBoot(again, KEYS.ignite2026)).planView, 'the choice the planner booted with').toBe('grid');
    await expectSwitch(again, 'grid');
    const grid = dayGrid(again, TUE);
    await expect(grid).toBeVisible();
    await expect(again.locator('#main .timeline')).toHaveCount(0);
    expect(await blocks(grid)).toEqual(TUESDAY_BLOCKS);
  });

  // From the DOM contract rather than a scenario: open pills are not saved.
  test('The choice survives a reload: an open pill does not, it is collapsed again', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    await openThePill(grid, '600');
    await expectSavedView(page, KEYS.ignite2026, 'grid');

    await page.reload();
    await expectPlanBooted(page, 'ignite2026', { list: false });
    await expectSwitch(page, 'grid');
    await expectCollapsed(dayGrid(page, TUE), '600');
    await expect(page.locator('#main .g-row')).toHaveCount(0);
  });

  test('The choice does not leak to another conference: Grid in the Ignite planner leaves re:Invent on the list', async ({ page }) => {
    await openPlan(page);
    await showGrid(page);
    await expectSavedView(page, KEYS.ignite2026, 'grid');

    await switchConference(page, 'reinvent2026');
    await expectSwitch(page, 'list');
    expect(await dayView(page).locator('.timeline .t-item [data-card]').evaluateAll(els => els.map(e => e.dataset.card)))
      .toEqual(BOOTED.reinvent2026.timeline);
    await expect(page.locator('#main .daygrid')).toHaveCount(0);
    expect(['list', undefined], 're:Invent\'s saved choice').toContain((await savedUi(page, KEYS.reinvent2026)).planView);
    expect((await savedUi(page, KEYS.ignite2026)).planView, 'Ignite\'s saved choice').toBe('grid');

    // ...and Ignite kept its own choice: the list above is not "the choice was lost everywhere".
    await switchConference(page, 'ignite2026');
    await expectSwitch(page, 'grid');
    await expect(dayGrid(page, TUE)).toBeVisible();
  });

  test('The choice does not leak to another conference: Grid in the re:Invent planner leaves Ignite on the list', async ({ page }) => {
    await openPlan(page, { conf: 'reinvent2026' });
    await choose(page, 'grid');
    const grid = dayGrid(page, RIV_MON);
    await expect(grid).toBeVisible();
    expect(await blocks(grid)).toEqual([full('i-riv101', 'p-3'), full('i-riv102', 'p-2')]);
    await expectSavedView(page, KEYS.reinvent2026, 'grid');

    await switchConference(page, 'ignite2026');
    await expectSwitch(page, 'list');
    expect(await dayView(page).locator('.timeline .t-item [data-card]').evaluateAll(els => els.map(e => e.dataset.card)))
      .toEqual(BOOTED.ignite2026.timeline);
    await expect(page.locator('#main .daygrid')).toHaveCount(0);
    expect(['list', undefined], 'Ignite\'s saved choice').toContain((await savedUi(page, KEYS.ignite2026)).planView);
    expect((await savedUi(page, KEYS.reinvent2026)).planView, 're:Invent\'s saved choice').toBe('grid');

    await switchConference(page, 'reinvent2026');
    await expectSwitch(page, 'grid');
    await expect(dayGrid(page, RIV_MON)).toBeVisible();
  });

  test('A saved choice that is neither list nor grid: "week" shows the list', async ({ page }) => {
    await openPlan(page, { state: { ignite: { ui: { planView: 'week' } } } });
    expect((await uiAtBoot(page, KEYS.ignite2026)).planView, 'the saved choice').toBe('week');

    await expectSwitch(page, 'list');
    await expect(dayView(page).locator('.timeline')).toBeVisible();
    await expect(page.locator('#main .daygrid')).toHaveCount(0);
    // The switch still works from there, so the list above is a choice and not a dead page.
    await choose(page, 'grid');
    await expect(dayGrid(page, TUE)).toBeVisible();
    await expectSavedView(page, KEYS.ignite2026, 'grid');
  });

  // The two sides of "exactly grid" (grid.js planView): the label's spelling is not the value...
  test('A saved choice that is neither list nor grid: "Grid", the label and not the value, shows the list', async ({ page }) => {
    await openPlan(page, { state: { ignite: { ui: { planView: 'Grid' } } } });
    expect((await uiAtBoot(page, KEYS.ignite2026)).planView, 'the saved choice').toBe('Grid');

    await expectSwitch(page, 'list');
    await expect(dayView(page).locator('.timeline')).toBeVisible();
    await expect(page.locator('#main .daygrid')).toHaveCount(0);
  });

  // ...and the value itself opens the grid without a tap.
  test('A saved choice that is neither list nor grid: the other side, a saved "grid" opens on the grid', async ({ page }) => {
    await openPlan(page, { state: { ignite: { ui: { planView: 'grid' } } }, list: false });
    expect((await uiAtBoot(page, KEYS.ignite2026)).planView, 'the saved choice').toBe('grid');

    await expectSwitch(page, 'grid');
    const grid = dayGrid(page, TUE);
    await expect(grid).toBeVisible();
    await expect(page.locator('#main .timeline')).toHaveCount(0);
    expect(await blocks(grid)).toEqual(TUESDAY_BLOCKS);
  });
});

test.describe('Rule: The grid shows every timed pick of the day, chosen or not', () => {
  test('A pick the plan dropped is still on the grid, and still listed under "What you\'ll miss"', async ({ page }) => {
    await openPlan(page);
    // The plan attends BRK102 (Must, 10:00) and BRK106 (Must, 1:30); it dropped BRK101 (Maybe,
    // 10:00), BRK103 (Want, 10:00) and BRK107 (Want, 2:00): they are not in the list of the day.
    expect(await missed(page)).toEqual(['i-brk101', 'i-brk103', 'i-brk107']);

    const grid = await showGrid(page);
    // A dropped pick beside the pick the plan kept, both as blocks.
    await expect(block(grid, 'i-brk106')).toBeVisible();
    await expect(block(grid, 'i-brk107')).toBeVisible();
    await expect(block(grid, 'i-brk107').locator('.g-title')).toContainText('Governance at scale');
    // The Must in the plan and the Maybe it dropped, both 10:00 to 10:45: with the Want they
    // are the three of the 10:00 pill.
    await expectCollapsed(grid, '600');
    await openThePill(grid, '600');
    expect(await rowKeys(grid, '600')).toEqual(['i-brk102', 'i-brk103', 'i-brk101']);
    expect(await missed(page), 'still under "What you\'ll miss"').toEqual(['i-brk101', 'i-brk103', 'i-brk107']);
    await expect(page.locator('#main h2', { hasText: "What you'll miss on Tue, Nov 17" })).toBeVisible();
  });

  test('Blocked time and lunch are on the grid, each a block at its own time', async ({ page }) => {
    await openPlan(page);
    // Blocked time 9:00 to 10:00 and lunch 12:00 to 12:45, as the list shows them.
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.first()).toContainText('Booth duty');
    await expect(rows.first().locator('.t-time')).toHaveText('9:00 AM10:00 AM');
    await expect(page.locator('#main .timeline .t-lunch .t-time')).toHaveText('12:00 PM12:45 PM');

    const grid = await showGrid(page);
    const lines = await hourLines(grid);
    expect(lines[0], 'the grid starts at 9 AM').toEqual(line(540, '9 AM', 0));

    await expect(grid.locator('.g-band')).toHaveCount(2);
    await expect(band(grid, 'block')).toContainText('Booth duty');
    await expect(band(grid, 'lunch')).toContainText('Lunch');
    const booth = await box(band(grid, 'block'), 'blocked time');
    const lunch = await box(band(grid, 'lunch'), 'lunch');
    expectAt(booth, 0, 60, 'blocked time 9:00 to 10:00');
    expectAt(lunch, 180, 45, 'lunch 12:00 to 12:45');
    // The same against the hour lines the page drew: 9 AM to 10 AM, and from 12 PM.
    expect(booth.top).toBeCloseTo(topOf(lines, '9 AM'), 0);
    expect(booth.bottom).toBeCloseTo(topOf(lines, '10 AM'), 0);
    expect(lunch.top).toBeCloseTo(topOf(lines, '12 PM'), 0);
    // Neither is a session: no tap action, not a session block, not counted by the pill beside it.
    expect(await grid.locator('.g-band').evaluateAll(els => els.map(e => [e.dataset.band, e.dataset.act ?? null, e.matches('.g-block, [data-key]')])))
      .toEqual(expect.arrayContaining([['block', null, false], ['lunch', null, false]]));
    await expectCollapsed(grid, '600');
  });

  test('A pick without a time is not on the grid, and still listed under "Picks without a time yet"', async ({ page }) => {
    await openPlan(page);
    expect((await readPlan(page)).sections['Picks without a time yet']).toEqual(['i-brk401']);
    await expect(page.locator('#main [data-card="i-brk401"] .meta')).toContainText('Date & time TBA');

    await choose(page, 'grid');
    // Not on any day's grid, while each of those days does draw its timed picks.
    for (const [day, drawn] of [[TUE, TUESDAY_BLOCKS], [WED, WEDNESDAY_BLOCKS]]) {
      if (day !== TUE) await tapDay(page, day);
      const grid = dayGrid(page, day);
      await expect(grid).toBeVisible();
      expect(await blocks(grid), day).toEqual(drawn);
      await expect(dayView(page).locator('[data-key="i-brk401"]'), `BRK401 on ${day}`).toHaveCount(0);
      expect((await readPlan(page)).sections['Picks without a time yet'], `still listed on ${day}`).toEqual(['i-brk401']);
    }
    // ...not hidden in a pill either.
    await tapDay(page, TUE);
    const tuesday = dayGrid(page, TUE);
    await openThePill(tuesday, '600');
    expect(await rowKeys(tuesday, '600')).toEqual(['i-brk102', 'i-brk103', 'i-brk101']);
  });

  test('A watch-later pick is not on the grid', async ({ page }) => {
    await openPlan(page);
    // BRK104: a Want from 10:00 to 10:45 on Tuesday, on the watch-later list.
    expect((await readPlan(page)).sections['Watch later (1)']).toEqual(['i-brk104']);
    await expect(page.locator('#main [data-card="i-brk104"] .meta')).toContainText('Tue, Nov 17 · 10:00 AM–10:45 AM');

    const grid = await showGrid(page);
    // Three other picks share its time; were it drawn, the pill would count four.
    await expectCollapsed(grid, '600', '3 sessions at this time');
    expect(await dots(closedPill(grid, '600'))).toEqual(['p-3', 'p-2', 'p-1']);
    await expect(dayView(page).locator('[data-key="i-brk104"]')).toHaveCount(0);
    await openThePill(grid, '600');
    expect(await rowKeys(grid, '600')).toEqual(['i-brk102', 'i-brk103', 'i-brk101']);
    await expect(dayView(page).locator('[data-key="i-brk104"]')).toHaveCount(0);
    expect((await readPlan(page)).sections['Watch later (1)'], 'still on the watch-later list').toEqual(['i-brk104']);
  });

  // beyond the feature file: blocked time and lunch are bands. Each is drawn at its own time and
  // never joins a pair or a pill, so "N sessions at this time" only ever counts sessions.
  test('beyond the feature file: blocked time over two overlapping sessions leaves a pair, and lunch over one session leaves it full width', async ({ page }) => {
    await openPlan(page);
    await tapDay(page, THU);
    // Thursday: BRK301 (2:00-2:45) and BRK302 (2:15-3:00) are inside the 2:00-4:00 meeting;
    // BRK303 (12:15-12:45) lost to lunch (12:00-12:45). The plan dropped all three.
    await expect(page.locator('#main .sacrifices [data-card="i-brk301"] .reason')).toHaveText('During Customer meeting (blocked time)');
    await expect(page.locator('#main .sacrifices [data-card="i-brk302"] .reason')).toHaveText('During Customer meeting (blocked time)');
    await expect(page.locator('#main .sacrifices [data-card="i-brk303"] .reason')).toHaveText('Lower value than the rest of the day');
    await expect(page.locator('#main .timeline .t-lunch .t-time')).toHaveText('12:00 PM12:45 PM');
    await expect(page.locator('#main .timeline > .t-item').last().locator('.t-time')).toHaveText('2:00 PM4:00 PM');

    await choose(page, 'grid');
    const grid = dayGrid(page, THU);
    await expect(grid).toBeVisible();
    expect((await hourLines(grid))[0], 'the grid starts at 9 AM').toEqual(line(540, '9 AM', 0));

    // Two sessions and a band at the same time are a pair, not "3 sessions at this time".
    await expect(grid.locator('.g-pill')).toHaveCount(0);
    await expect(block(grid, 'i-brk301')).toHaveAttribute('data-cols', '2');
    await expect(block(grid, 'i-brk302')).toHaveAttribute('data-cols', '2');
    await expect(block(grid, 'i-brk301')).toHaveAttribute('data-col', '0');
    await expect(block(grid, 'i-brk302')).toHaveAttribute('data-col', '1');
    expectAt(await box(block(grid, 'i-brk301'), 'BRK301'), 300, 45, 'BRK301, 2:00 to 2:45');
    expectAt(await box(block(grid, 'i-brk302'), 'BRK302'), 315, 45, 'BRK302, 2:15 to 3:00');
    await expect(band(grid, 'block')).toContainText('Customer meeting');
    expectAt(await box(band(grid, 'block'), 'blocked time'), 300, 120, 'blocked time 2:00 to 4:00');

    // A session and lunch at the same time: the session stays full width, lunch at its own time.
    expectAt(await box(band(grid, 'lunch'), 'lunch'), 180, 45, 'lunch 12:00 to 12:45');
    await expect(block(grid, 'i-brk303')).toHaveAttribute('data-cols', '1');
    const overLunch = await box(block(grid, 'i-brk303'), 'BRK303');
    const alone = await box(block(grid, 'i-brk305'), 'BRK305');
    expectAt(overLunch, 195, 30, 'BRK303, 12:15 to 12:45');
    expect(overLunch.width, 'as wide as a session with nothing beside it').toBeCloseTo(alone.width, 0);
    expect(overLunch.left).toBeCloseTo(alone.left, 0);
    // The bands are not sessions: neither is a block, and neither can be tapped.
    expect(await grid.locator('.g-band').evaluateAll(els => els.map(e => [e.dataset.band, e.dataset.act ?? null, e.matches('.g-block, [data-key]')])))
      .toEqual(expect.arrayContaining([['block', null, false], ['lunch', null, false]]));
    await expect(grid.locator('.g-band')).toHaveCount(2);
  });

  // beyond the feature file: a run the plan gave up for another run of the same session is not
  // on that day's grid (it is attended elsewhere, not missed); every other dropped pick is.
  test('beyond the feature file: a run given up for another run of the same session is not on that day\'s grid', async ({ page }) => {
    await openPlan(page);
    await tapDay(page, THU);
    // BRK310 runs Thursday 3:15 (inside the meeting) and, as BRK310-R1, Wednesday 3:00: the
    // plan attends Wednesday's, so Thursday's is an "other run", not something missed.
    const otherRuns = page.locator('#main .panel', { hasText: 'Other runs:' });
    await expect(otherRuns).toContainText("BRK310 clashes with Customer meeting here, so you'll catch BRK310-R1 on Wed, Nov 18 at 3:00 PM");
    expect(await missed(page)).toEqual(['i-brk301', 'i-brk302', 'i-brk303']);

    await choose(page, 'grid');
    const thursday = dayGrid(page, THU);
    await expect(thursday).toBeVisible();
    // The picks dropped for blocked time (BRK301, BRK302) and for lunch (BRK303) are drawn...
    expect(await blocks(thursday)).toEqual(THURSDAY_BLOCKS);
    // ...the run given up for Wednesday's is not, as a block or inside a pill.
    await expect(dayView(page).locator('[data-key="i-brk310"]')).toHaveCount(0);
    await expect(thursday.locator('.g-pill')).toHaveCount(0);
    await expect(otherRuns, 'still explained under the day').toContainText('BRK310-R1 on Wed, Nov 18 at 3:00 PM');

    // The run the plan attends is on its own day's grid.
    await tapDay(page, WED);
    const run = block(dayGrid(page, WED), 'i-brk310-r1');
    await expect(run).toBeVisible();
    await expect(run.locator('.g-title')).toContainText('Hands-on with agents');
  });
});

test.describe('Rule: The grid runs from the hour before the first pick to the hour after the last', () => {
  // The scenario as written: the picks themselves run from 9:00 AM to 5:00 PM, with no blocked
  // time or lunch to set the range instead. Monday pins the same rule at another end (12:00 PM),
  // so a grid that is always drawn 9 AM to 5 PM does not pass.
  test('Picks that start and end on the hour: re:Invent Tuesday, picks only, 9:00 AM to 5:00 PM, has hour lines from 9 AM to 5 PM', async ({ page }) => {
    await openPlan(page, { conf: 'reinvent2026' });
    await expectPicksOnly(page, [['i-riv101', '9:00 AM10:00 AM'], ['i-riv102', '11:00 AM12:00 PM']]);
    await tapDay(page, RIV_TUE);
    await expectPicksOnly(page, [['i-riv104', '9:00 AM10:00 AM'], ['i-riv105', '4:00 PM5:00 PM']]);

    await choose(page, 'grid');
    const tuesday = dayGrid(page, RIV_TUE);
    await expect(tuesday).toBeVisible();
    await expect(page.locator('#main .daygrid')).toHaveCount(1);
    // No hour before 9 AM and none after 5 PM: a pick on the hour is its own first or last line.
    expect(await hourLines(tuesday)).toEqual(NINE_TO_FIVE);
    expect(await gridHeight(tuesday), 'the grid ends at the 5 PM line').toBeCloseTo(480, 0);
    expect(await blocks(tuesday), 'the two picks, and only they').toEqual([full('i-riv104', 'p-3'), full('i-riv105', 'p-2')]);
    await expect(tuesday.locator('.g-band, .g-pill'), 'nothing but picks on this grid').toHaveCount(0);
    const first = await box(block(tuesday, 'i-riv104'), 'RIV104'), last = await box(block(tuesday, 'i-riv105'), 'RIV105');
    expectAt(first, 0, 60, 'RIV104, 9:00 to 10:00: on the first hour line');
    expectAt(last, 420, 60, 'RIV105, 4:00 to 5:00');
    expect(last.bottom, 'RIV105 ends on the last hour line').toBeCloseTo(480, 0);

    // Monday's picks run from 9:00 AM to 12:00 PM: hour lines from 9 AM to 12 PM.
    await tapDay(page, RIV_MON);
    const monday = dayGrid(page, RIV_MON);
    await expect(monday).toBeVisible();
    expect(await hourLines(monday)).toEqual([line(540, '9 AM', 0), line(600, '10 AM', 60), line(660, '11 AM', 120), line(720, '12 PM', 180)]);
    expect(await gridHeight(monday), 'the grid ends at the 12 PM line').toBeCloseTo(180, 0);
    expect(await blocks(monday)).toEqual([full('i-riv101', 'p-3'), full('i-riv102', 'p-2')]);
    await expect(monday.locator('.g-band, .g-pill')).toHaveCount(0);
    expectAt(await box(block(monday, 'i-riv101'), 'RIV101'), 0, 60, 'RIV101, 9:00 to 10:00: on the first hour line');
    expect((await box(block(monday, 'i-riv102'), 'RIV102')).bottom, 'RIV102 ends on the last hour line').toBeCloseTo(180, 0);
  });

  // Ignite Tuesday also runs 9:00 AM to 5:00 PM, but its 9:00 start is blocked time, not a pick:
  // the first pick is at 10:00. grid.js counts blocked time and lunch toward the range like
  // sessions, so the hour lines are the same; the end at 5:00 PM is a pick's (BRK108).
  test('Picks that start and end on the hour: Ignite Tuesday, blocked time from 9:00 AM and a pick until 5:00 PM, has hour lines from 9 AM to 5 PM', async ({ page }) => {
    await openPlan(page);
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.first(), 'the day starts with blocked time').toContainText('Booth duty');
    await expect(rows.first().locator('[data-card]'), 'which is not a session').toHaveCount(0);
    await expect(rows.first().locator('.t-time'), 'blocked time starts the day at 9:00 AM').toHaveText('9:00 AM10:00 AM');
    expect((await timelineCards(page))[0], 'the first pick of the day').toBe('i-brk102');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk102"]') }).locator('.t-time'), 'the first pick starts at 10:00 AM').toHaveText('10:00 AM10:45 AM');
    await expect(rows.last().locator('[data-card]'), 'the day ends with a pick').toHaveAttribute('data-card', 'i-brk108');
    await expect(rows.last().locator('.t-time'), 'the last pick ends at 5:00 PM').toHaveText('4:00 PM5:00 PM');

    const grid = await showGrid(page);
    expect(await hourLines(grid)).toEqual(NINE_TO_FIVE);
    expect(await gridHeight(grid), 'the grid ends at the 5 PM line').toBeCloseTo(480, 0);
    await expect(band(grid, 'block')).toContainText('Booth duty');
    expectAt(await box(band(grid, 'block'), 'blocked time'), 0, 60, 'blocked time 9:00 to 10:00: on the first hour line');
    expect((await box(block(grid, 'i-brk108'), 'BRK108')).bottom, 'BRK108 ends on the last hour line').toBeCloseTo(480, 0);
  });

  test('Picks that start and end between hours: Wednesday, 9:14 AM to 4:40 PM, has hour lines from 9 AM to 5 PM', async ({ page }) => {
    await openPlan(page);
    await tapDay(page, WED);
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.first().locator('.t-time'), 'the day starts at 9:14 AM').toHaveText('9:14 AM9:50 AM');
    await expect(rows.last().locator('.t-time'), 'the day ends at 4:40 PM').toHaveText('3:55 PM4:40 PM');

    await choose(page, 'grid');
    const grid = dayGrid(page, WED);
    await expect(grid).toBeVisible();
    expect(await hourLines(grid)).toEqual(NINE_TO_FIVE);
    expect(await gridHeight(grid), 'the grid ends at the 5 PM line').toBeCloseTo(480, 0);
    // The first and last picks sit inside it, 14 units after 9 AM and 20 units before 5 PM.
    expectAt(await box(block(grid, 'i-brk201'), 'BRK201'), 14, 36, 'BRK201, 9:14 to 9:50');
    expect((await box(block(grid, 'i-brk207'), 'BRK207')).bottom, 'BRK207 ends at 4:40').toBeCloseTo(460, 0);
  });

  test('A day with no timed picks: the grid shows "Nothing planned" as the list does, with no hour lines', async ({ page }) => {
    await openPlan(page);
    await tapDay(page, FRI);
    // Friday: nothing picked, no blocked time, and so no lunch either.
    await expect(page.locator('#main .panel.empty h3')).toHaveText('Nothing planned on Fri, Nov 20');
    await expect(page.locator('#main .timeline')).toHaveCount(0);

    await tapDay(page, TUE);
    const tuesday = await showGrid(page);
    expect((await hourLines(tuesday)).length, 'a day with picks does draw hour lines').toBe(9);

    await tapDay(page, FRI);
    await expectSwitch(page, 'grid');
    await expect(dayView(page).locator('.panel.empty h3')).toHaveText('Nothing planned on Fri, Nov 20');
    await expect(page.locator('#main .panel.empty h3'), 'said once, not twice').toHaveCount(1);
    await expect(page.locator('#main .daygrid')).toHaveCount(0);
    await expect(page.locator('#main .g-hour')).toHaveCount(0);
    await expect(page.locator('#main .g-block, #main .g-band, #main .g-pill')).toHaveCount(0);
  });

  // The other side of "no timed picks, blocked time or lunch": blocked time alone is something.
  test('A day with no timed picks: the other side, a day with only blocked time and lunch is drawn as a grid', async ({ page }) => {
    const flight = { id: 'flight', day: FRI, start: 900, end: 960, label: 'Flight home', building: 'W' };
    await openPlan(page, { state: { ignite: { blocks: [...BLOCKS, flight] } } });
    await tapDay(page, FRI);
    // The list has no session to show, only the lunch it protects before the 3:00 PM block.
    await expect(page.locator('#main .panel.empty h3')).toHaveText('Nothing planned on Fri, Nov 20');
    await expect(page.locator('#main .timeline .t-lunch .t-time')).toHaveText('12:00 PM12:45 PM');

    await choose(page, 'grid');
    const grid = dayGrid(page, FRI);
    await expect(grid).toBeVisible();
    expect(await hourLines(grid)).toEqual([line(720, '12 PM', 0), line(780, '1 PM', 60), line(840, '2 PM', 120), line(900, '3 PM', 180), line(960, '4 PM', 240)]);
    await expect(grid.locator('.g-band')).toHaveCount(2);
    await expect(band(grid, 'block')).toContainText('Flight home');
    expectAt(await box(band(grid, 'lunch'), 'lunch'), 0, 45, 'lunch 12:00 to 12:45');
    expectAt(await box(band(grid, 'block'), 'blocked time'), 180, 60, 'blocked time 3:00 to 4:00');
    await expect(grid.locator('.g-block, .g-pill')).toHaveCount(0);
  });
});

test.describe('Rule: A session\'s block sits at its start time and is as tall as it is long', () => {
  test('A 50-minute session on a grid that starts at 9 AM: its block starts 60 units down, is 50 units tall and full width, and shows its time, title and room', async ({ page }) => {
    await openPlan(page);
    await tapDay(page, THU);
    // BRK305: a Must from 10:00 to 10:50 on Thursday, after a 9:20 session; nothing else at 10:00.
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.first().locator('.t-time')).toHaveText('9:20 AM9:50 AM');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk305"]') }).locator('.t-time')).toHaveText('10:00 AM10:50 AM');

    await choose(page, 'grid');
    const grid = dayGrid(page, THU);
    await expect(grid).toBeVisible();
    const lines = await hourLines(grid);
    expect(lines[0], 'the grid starts at 9 AM').toEqual(line(540, '9 AM', 0));

    const must = block(grid, 'i-brk305');
    const at = await box(must, 'BRK305');
    expectAt(at, 60, 50, 'BRK305, 10:00 to 10:50');
    expect(at.top, 'on the 10 AM line').toBeCloseTo(topOf(lines, '10 AM'), 0);
    await expect(must).toHaveAttribute('data-cols', '1');
    await expect(must).toHaveClass(/\bp-3\b/);

    // Its time is the whole of it: from 10:00 to 10:50 (a start alone, or another end, is not).
    await expectPainted(must.locator('.g-time'), 'BRK305: its time');
    await expect(must.locator('.g-time'), 'BRK305: 10:00 AM to 10:50 AM').toHaveText(timeRange('10:00', '10:50', 'AM'));
    await expectPainted(must.locator('.g-title'), 'BRK305: its title');
    await expect(must.locator('.g-title')).toContainText('Platform engineering keynote recap');
    await expectPainted(must.locator('.g-room'), 'BRK305: its room');
    await expect(must.locator('.g-room')).toContainText('Room 2035');
    // Each block shows its own: the session before it on the same grid is 9:20 to 9:50.
    const before = block(grid, 'i-brk304');
    await expect(before.locator('.g-time'), 'BRK304: 9:20 AM to 9:50 AM').toHaveText(timeRange('9:20', '9:50', 'AM'));
    await expect(before.locator('.g-title')).toContainText('Early bird Q&A');
    await expect(before.locator('.g-room')).toContainText('Room 2034');
    for (const part of ['.g-time', '.g-title', '.g-room']) await expectPainted(before.locator(part), `BRK304, 30 minutes: ${part}`);

    // Full width: it spans what both halves of a side-by-side pair span (Tuesday's BRK106 on
    // the left and BRK107 on the right; every day's grid is laid out across the same width).
    await tapDay(page, TUE);
    const tuesday = dayGrid(page, TUE);
    await expect(block(tuesday, 'i-brk106')).toHaveAttribute('data-col', '0');
    await expect(block(tuesday, 'i-brk107')).toHaveAttribute('data-col', '1');
    const left = await box(block(tuesday, 'i-brk106'), 'BRK106'), right = await box(block(tuesday, 'i-brk107'), 'BRK107');
    expect(at.left, 'starts where the left half starts').toBeCloseTo(left.left, 0);
    expect(at.right, 'ends where the right half ends').toBeCloseTo(right.right, 0);
    expect(at.width).toBeGreaterThan(left.width * 1.9);
  });
});

test.describe('Rule: Two sessions at the same time sit side by side; three or more collapse into one pill', () => {
  test('Two sessions that overlap: the two are side by side, each half width, each at its own start time', async ({ page }) => {
    await openPlan(page);
    // BRK106: a Must from 1:30 to 2:30. BRK107: a Want from 2:00 to 3:00 (the plan dropped it).
    await expect(page.locator('#main .timeline > .t-item').filter({ has: page.locator('[data-card="i-brk106"]') }).locator('.t-time')).toHaveText('1:30 PM2:30 PM');
    await expect(page.locator('#main .sacrifices [data-card="i-brk107"] .meta')).toContainText('2:00 PM–3:00 PM');

    const grid = await showGrid(page);
    const lines = await hourLines(grid);
    expect(lines[0], 'the grid starts at 9 AM').toEqual(line(540, '9 AM', 0));
    const must = block(grid, 'i-brk106'), want = block(grid, 'i-brk107');
    await expect(must).toHaveAttribute('data-cols', '2');
    await expect(want).toHaveAttribute('data-cols', '2');
    await expect(must, 'the earlier start is on the left').toHaveAttribute('data-col', '0');
    await expect(want).toHaveAttribute('data-col', '1');
    await expect(must).toHaveClass(/\bp-3\b/);
    await expect(want).toHaveClass(/\bp-2\b/);
    await expect(must.locator('.g-title')).toContainText('Zero trust for AI');
    await expect(want.locator('.g-title')).toContainText('Governance at scale');

    const a = await box(must, 'BRK106'), b = await box(want, 'BRK107');
    const whole = await box(block(grid, 'i-brk108'), 'BRK108, a full-width block');
    // Each at its own start: 1:30 PM is 270 units after 9 AM, 2:00 PM is 300 (the 2 PM line).
    expectAt(a, 270, 60, 'BRK106, 1:30 to 2:30');
    expectAt(b, 300, 60, 'BRK107, 2:00 to 3:00');
    expect(b.top).toBeCloseTo(topOf(lines, '2 PM'), 0);
    // Side by side: the left one ends where the right one begins or before, and together they
    // span what one full-width block spans.
    expect(a.right, 'they do not overlap each other').toBeLessThanOrEqual(b.left + 0.5);
    expect(a.left).toBeCloseTo(whole.left, 0);
    expect(b.right).toBeCloseTo(whole.right, 0);
    // Half width each: no more than half, and not a sliver.
    for (const [name, half] of [['BRK106', a], ['BRK107', b]]) {
      expect(half.width, `${name} is at most half width`).toBeLessThanOrEqual(whole.width / 2 + 0.5);
      expect(half.width, `${name} is about half width`).toBeGreaterThanOrEqual(whole.width * 0.4);
    }
    expect(a.width, 'the two halves are equal').toBeCloseTo(b.width, 0);
  });

  test('Two sessions that only touch: each is a full-width block', async ({ page }) => {
    await openPlan(page);
    // BRK109 (3:00 to 4:00) starts when BRK107 ends and ends when BRK108 (4:00 to 5:00) starts.
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk109"]') }).locator('.t-time')).toHaveText('3:00 PM4:00 PM');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk108"]') }).locator('.t-time')).toHaveText('4:00 PM5:00 PM');

    const grid = await showGrid(page);
    expect((await hourLines(grid))[0], 'the grid starts at 9 AM').toEqual(line(540, '9 AM', 0));
    await expect(block(grid, 'i-brk109')).toHaveAttribute('data-cols', '1');
    await expect(block(grid, 'i-brk108')).toHaveAttribute('data-cols', '1');
    const earlier = await box(block(grid, 'i-brk109'), 'BRK109'), later = await box(block(grid, 'i-brk108'), 'BRK108');
    expectAt(earlier, 360, 60, 'BRK109, 3:00 to 4:00');
    expectAt(later, 420, 60, 'BRK108, 4:00 to 5:00');
    expect(later.top, 'they touch').toBeCloseTo(earlier.bottom, 0);
    expect(later.left).toBeCloseTo(earlier.left, 0);
    expect(later.width).toBeCloseTo(earlier.width, 0);
    // Full width is twice a half: BRK109 also touches the end of BRK107, the right half of a pair.
    const leftHalf = await box(block(grid, 'i-brk106'), 'BRK106'), rightHalf = await box(block(grid, 'i-brk107'), 'BRK107');
    expect(earlier.top, 'BRK109 starts where BRK107 ends').toBeCloseTo(rightHalf.bottom, 0);
    expect(earlier.left).toBeCloseTo(leftHalf.left, 0);
    expect(earlier.right).toBeCloseTo(rightHalf.right, 0);
    expect(earlier.width).toBeGreaterThan(rightHalf.width * 1.9);
  });

  test('Three sessions at the same time: one pill at 10:00 that says "3 sessions at this time", with a Must, a Want and a Maybe dot, and no block for any of the three', async ({ page }) => {
    await openPlan(page);
    // BRK101 Maybe, BRK102 Must, BRK103 Want: all 10:00 to 10:45 (one clash card of three).
    expect((await readPlan(page)).clashes[0]).toBe('10:00 AM · 3 picks clash · ranked for you');

    const grid = await showGrid(page);
    const lines = await hourLines(grid);
    expect(lines[0], 'the grid starts at 9 AM').toEqual(line(540, '9 AM', 0));
    await expect(grid.locator('.g-pill'), 'one pill').toHaveCount(1);
    await expectCollapsed(grid, '600', '3 sessions at this time');
    const pill = closedPill(grid, '600');
    expect(await dots(pill), 'dots: Must, Want, Maybe').toEqual(['p-3', 'p-2', 'p-1']);
    expect((await box(pill, 'the pill')).top, 'at 10:00').toBeCloseTo(topOf(lines, '10 AM'), 0);

    for (const key of ['i-brk101', 'i-brk102', 'i-brk103']) await expect(grid.locator(`.g-block[data-key="${key}"]`), `${key} as a block`).toHaveCount(0);
    await expect(grid.locator('.g-row'), 'no rows while collapsed').toHaveCount(0);
    expect(await blocks(grid), 'the other sessions are blocks').toEqual(TUESDAY_BLOCKS);
  });

  test('A pair and a later single are separate: the first two are side by side and the third is a full-width block', async ({ page }) => {
    await openPlan(page);
    // BRK106 and BRK107 overlap (1:30 to 3:00); BRK109 follows at 3:00.
    expect(await timelineCards(page)).toEqual(BOOTED.ignite2026.timeline);

    const grid = await showGrid(page);
    expect(await blocks(grid)).toEqual(TUESDAY_BLOCKS);
    await expect(block(grid, 'i-brk106')).toHaveAttribute('data-col', '0');
    await expect(block(grid, 'i-brk107')).toHaveAttribute('data-col', '1');
    const left = await box(block(grid, 'i-brk106'), 'BRK106'), right = await box(block(grid, 'i-brk107'), 'BRK107');
    const single = await box(block(grid, 'i-brk109'), 'BRK109');
    expect(left.right, 'side by side').toBeLessThanOrEqual(right.left + 0.5);
    expect(single.left, 'the single spans both columns').toBeCloseTo(left.left, 0);
    expect(single.right).toBeCloseTo(right.right, 0);
    expect(single.top, 'and comes after the pair').toBeGreaterThanOrEqual(Math.max(left.bottom, right.bottom) - 0.5);
  });
});

test.describe('Rule: Tapping a pill opens it into a list of its sessions; tapping again closes it', () => {
  test('Opening a pill: it shows three rows, Must first, then Want, then Maybe, each with the session\'s title and room', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    await expectCollapsed(grid, '600');
    await expect(grid.locator('.g-row')).toHaveCount(0);

    await closedPill(grid, '600').click();
    await expect(openPill(grid, '600')).toBeVisible();
    await expect(pillHead(grid, '600')).toBeVisible();
    await expect(grid.locator('button.g-pill[data-pill="600"]'), 'the collapsed pill is replaced').toHaveCount(0);
    await expect(grid.locator('[data-pill="600"].g-pill'), 'still one pill').toHaveCount(1);

    // In the catalog and by code the order is Maybe (BRK101), Must (BRK102), Want (BRK103).
    const expected = [
      ['i-brk102', /\bp-3\b/, 'Copilot rollout playbook', 'Room 2002'],
      ['i-brk103', /\bp-2\b/, 'Securing AI agents', 'Room 2003'],
      ['i-brk101', /\bp-1\b/, 'Agents in production', 'Room 2001'],
    ];
    const rows = pillRows(grid, '600');
    await expect(rows).toHaveCount(3);
    expect(await rowKeys(grid, '600')).toEqual(expected.map(r => r[0]));
    for (const [i, [key, prio, title, room]] of expected.entries()) {
      const row = rows.nth(i);
      await expect(row, key).toBeVisible();
      await expect(row).toHaveClass(prio);
      await expectPainted(row.locator('.g-title'), `${key}: its title`);
      await expect(row.locator('.g-title')).toContainText(title);
      await expectPainted(row.locator('.g-room'), `${key}: its room`);
      await expect(row.locator('.g-room')).toContainText(room);
    }
    for (const key of expected.map(r => r[0])) await expect(grid.locator(`.g-block[data-key="${key}"]`)).toHaveCount(0);
  });

  test('Closing a pill: tapping its header makes it one pill that says "3 sessions at this time" again', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    await openThePill(grid, '600');
    await expect(pillRows(grid, '600'), 'it was open').toHaveCount(3);

    await pillHead(grid, '600').click();
    await expectCollapsed(grid, '600', '3 sessions at this time');
    expect(await dots(closedPill(grid, '600'))).toEqual(['p-3', 'p-2', 'p-1']);
    await expect(grid.locator('.g-pill')).toHaveCount(1);
    await expect(grid.locator('.g-row')).toHaveCount(0);
    await expect(grid.locator('.g-pill-head')).toHaveCount(0);
  });

  test('Changing day closes open pills: after the Wednesday tab and then the Tuesday tab, Tuesday\'s pill is collapsed', async ({ page }) => {
    await openPlan(page);
    const tuesday = await showGrid(page);
    await openThePill(tuesday, '600');
    await expect(pillRows(tuesday, '600'), 'Tuesday\'s pill was open').toHaveCount(3);
    expect(topOf(await hourLines(tuesday), '11 AM'), 'and had pushed 11 AM down').toBe(239);

    // Wednesday has a pill with the same start (and so the same id): it must not open with it.
    await tapDay(page, WED);
    const wednesday = dayGrid(page, WED);
    await expect(wednesday).toBeVisible();
    await expectCollapsed(wednesday, '600');
    await expectCollapsed(wednesday, '780');
    await expect(page.locator('#main .g-pill.open')).toHaveCount(0);

    await tapDay(page, TUE);
    await expect(tuesday).toBeVisible();
    await expectCollapsed(tuesday, '600');
    await expect(page.locator('#main .g-pill.open')).toHaveCount(0);
    await expect(tuesday.locator('.g-row')).toHaveCount(0);
    expect(topOf(await hourLines(tuesday), '11 AM'), '11 AM is back at its real time').toBe(120);
  });
});

test.describe('Rule: An open pill pushes everything after it down, hour lines included', () => {
  // Background, on Tuesday: the grid starts at 9 AM; a pill of three from 10:00 to 10:45
  // (BRK101, BRK102, BRK103); a Must from 11:00 to 11:45 (BRK105).
  async function tuesdayGrid(page) {
    await openPlan(page);
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk105"]') }).locator('.t-time'), 'the Must from 11:00 to 11:45').toHaveText('11:00 AM11:45 AM');
    const grid = await showGrid(page);
    expect(await hourLines(grid), 'the grid starts at 9 AM, every hour at its real time').toEqual(NINE_TO_FIVE);
    await expectCollapsed(grid, '600');
    return grid;
  }

  test('Collapsed, everything is at its real time: the pill is 45 units tall, the 11 AM line and the Must are 120 units down', async ({ page }) => {
    const grid = await tuesdayGrid(page);
    expectAt(await box(closedPill(grid, '600'), 'the pill'), 60, 45, 'the collapsed pill, 10:00 to 10:45');
    expect(topOf(await hourLines(grid), '11 AM'), 'the 11 AM hour line').toBe(120);
    expectAt(await box(block(grid, 'i-brk105'), 'BRK105'), 120, 45, 'the Must, 11:00 to 11:45');
  });

  test('Open, later sessions and hour lines move by the same amount: the pill is 164 units tall, the 11 AM line and the Must are 239 units down, the grid 119 taller', async ({ page }) => {
    const grid = await tuesdayGrid(page);
    const collapsed = { height: await gridHeight(grid), lines: await hourLines(grid), lunch: await box(band(grid, 'lunch'), 'lunch'), last: await box(block(grid, 'i-brk108'), 'BRK108') };

    await openThePill(grid, '600');
    const pill = await box(openPill(grid, '600'), 'the open pill');
    expectAt(pill, 60, 164, 'the open pill');
    const lines = await hourLines(grid);
    expect(topOf(lines, '11 AM'), 'the 11 AM hour line').toBe(239);
    expectAt(await box(block(grid, 'i-brk105'), 'BRK105'), 239, 45, 'the Must, 11:00 to 11:45');
    expect(await gridHeight(grid), 'the grid is 119 units taller').toBeCloseTo(collapsed.height + 119, 0);

    // The same amount for everything later: every hour line from 11 AM on, lunch, the last session.
    for (const l of collapsed.lines.filter(l => l.min >= 660)) expect(topOf(lines, l.label), `the ${l.label} hour line`).toBe(l.top + 119);
    expect(lines.map(l => l.label), 'no hour line is lost').toEqual(collapsed.lines.map(l => l.label));
    expect((await box(band(grid, 'lunch'), 'lunch')).top, 'lunch').toBeCloseTo(collapsed.lunch.top + 119, 0);
    const last = await box(block(grid, 'i-brk108'), 'BRK108');
    expect(last.top, 'the last session').toBeCloseTo(collapsed.last.top + 119, 0);
    expect(last.height, 'which keeps its length').toBeCloseTo(collapsed.last.height, 0);

    // 164 is 32 units of header plus 44 units for each of the three rows, in real pixels: the
    // header and rows are that tall and stacked, and fill the pill (give or take a 1px border).
    const below = await expectList(grid, '600', pill, 3);
    expect(Math.abs(below - pill.bottom), 'the rows end where the pill ends').toBeLessThanOrEqual(2);
    expect(pill.bottom, 'and the pill ends before the Must begins').toBeLessThanOrEqual(239);
  });

  test('Nothing before the end of the pill moves: the 10 AM line and the pill stay 60 units down', async ({ page }) => {
    const grid = await tuesdayGrid(page);
    const booth = await box(band(grid, 'block'), 'blocked time');

    await openThePill(grid, '600');
    const lines = await hourLines(grid);
    expect(topOf(lines, '11 AM'), 'what comes after the pill did move').toBe(239);
    expect(topOf(lines, '10 AM'), 'the 10 AM hour line').toBe(60);
    expect(topOf(lines, '9 AM'), 'the 9 AM hour line').toBe(0);
    expect((await box(openPill(grid, '600'), 'the open pill')).top, 'the pill').toBeCloseTo(60, 0);
    expect(await box(band(grid, 'block'), 'blocked time'), 'blocked time before the pill').toEqual(booth);
    expectAt(booth, 0, 60, 'blocked time 9:00 to 10:00');
  });

  test('Closing the pill puts everything back: the 11 AM line and the Must are 120 units down again', async ({ page }) => {
    const grid = await tuesdayGrid(page);
    const height = await gridHeight(grid);
    await openThePill(grid, '600');
    expect(topOf(await hourLines(grid), '11 AM'), 'open: the 11 AM hour line').toBe(239);
    expect((await box(block(grid, 'i-brk105'), 'BRK105')).top, 'open: the Must').toBeCloseTo(239, 0);

    await pillHead(grid, '600').click();
    await expectCollapsed(grid, '600');
    expect(await hourLines(grid), 'every hour line is back').toEqual(NINE_TO_FIVE);
    expect(topOf(await hourLines(grid), '11 AM'), 'the 11 AM hour line').toBe(120);
    expectAt(await box(block(grid, 'i-brk105'), 'BRK105'), 120, 45, 'the Must, 11:00 to 11:45');
    expectAt(await box(closedPill(grid, '600'), 'the pill'), 60, 45, 'the collapsed pill');
    expect(await gridHeight(grid), 'the grid is as tall as before').toBeCloseTo(height, 0);
  });

  test('Two open pills add up: with the 10:00 and the 1:00 pill both open, the Want from 2:00 to 2:45 starts 538 units down', async ({ page }) => {
    // Wednesday has the whole background (9 AM start, a pill 10:00-10:45, a Must 11:00-11:45)
    // plus a second pill of three from 1:00 to 1:45 and a Want (BRK214) from 2:00 to 2:45.
    await openPlan(page);
    await tapDay(page, WED);
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk206"]') }).locator('.t-time')).toHaveText('11:00 AM11:45 AM');
    await expect(rows.filter({ has: page.locator('[data-card="i-brk214"]') }).locator('.t-time')).toHaveText('2:00 PM2:45 PM');
    expect((await readPlan(page)).clashes).toEqual(['10:00 AM · 3 picks clash · ranked for you', '1:00 PM · 3 picks clash · ranked for you']);

    await choose(page, 'grid');
    const grid = dayGrid(page, WED);
    await expect(grid).toBeVisible();
    expect(await hourLines(grid), 'the grid starts at 9 AM').toEqual(NINE_TO_FIVE);
    const want = block(grid, 'i-brk214');
    expect((await box(want, 'BRK214')).top, 'both collapsed: 2:00 PM at its real time').toBeCloseTo(300, 0);

    await openThePill(grid, '600');
    expect((await box(want, 'BRK214')).top, 'one pill open').toBeCloseTo(419, 0);
    await openThePill(grid, '780');
    await expect(openPill(grid, '600'), 'the first pill stays open').toBeVisible();
    await expect(grid.locator('.g-pill.open')).toHaveCount(2);
    expect(await rowKeys(grid, '600')).toEqual(['i-brk205', 'i-brk203', 'i-brk204']);
    expect(await rowKeys(grid, '780')).toEqual(['i-brk213', 'i-brk212', 'i-brk211']);
    expect((await box(want, 'BRK214')).top, 'both pills open').toBeCloseTo(538, 0);
    expect(topOf(await hourLines(grid), '2 PM'), 'and the 2 PM hour line with it').toBe(538);
  });
});

test.describe('Rule: A pill that is already taller than its list does not shrink the day', () => {
  // re:Invent Wednesday (the fixture day kept for this scenario): picks only, so the grid starts
  // at 9 AM with the pill; three sessions linked by overlaps from 9:00 to 12:00; the day's one
  // Must (RIV204) from 12:00 to 12:45. The pill spans 180 units and its list of three is 164
  // (32 of header and three rows of 44): every other open pill in this suite is the other way
  // round, 45 units of time under a list of 164.
  test('Three sessions spread over three hours: the open pill is 180 units tall, the Must still starts 180 units down, and the day is no taller or shorter than with the pill collapsed', async ({ page }) => {
    await openPlan(page, { conf: 'reinvent2026' });
    await tapDay(page, RIV_WED);
    await expectPicksOnly(page, RIV_WEDNESDAY.rows, RIV_WEDNESDAY.dropped);
    // The Must is RIV204, the only one of the day: the three before it are two Wants and a Maybe.
    await expect(page.locator('#main .timeline [data-card="i-riv204"]'), 'RIV204 is a Must').toHaveClass(/\bp-3\b/);
    await expect(page.locator('#main .timeline [data-card="i-riv201"]'), 'RIV201 is a Want').toHaveClass(/\bp-2\b/);
    await expect(page.locator('#main .timeline [data-card="i-riv203"]'), 'RIV203 is a Want').toHaveClass(/\bp-2\b/);
    await expect(page.locator('#main .sacrifices [data-card="i-riv202"]'), 'RIV202 is a Maybe').toHaveClass(/\bp-1\b/);

    await choose(page, 'grid');
    const grid = dayGrid(page, RIV_WED);
    await expect(grid, `the grid for ${RIV_WED}`).toBeVisible();
    await expect(page.locator('#main .daygrid')).toHaveCount(1);

    // Given: the grid starts at 9 AM; one collapsed pill of three from 9:00 to 12:00; the Must
    // at 12:00. One unit a minute, so 12 PM is 180 units down and the day ends at 1 PM, 240 down.
    const REAL_TIME = [line(540, '9 AM', 0), line(600, '10 AM', 60), line(660, '11 AM', 120), line(720, '12 PM', 180), line(780, '1 PM', 240)];
    expect(await hourLines(grid), 'the grid starts at 9 AM, every hour at its real time').toEqual(REAL_TIME);
    await expect(grid.locator('.g-pill'), 'one pill').toHaveCount(1);
    await expectCollapsed(grid, '540', '3 sessions at this time');
    expect(await dots(closedPill(grid, '540')), 'three sessions: two Wants and a Maybe').toEqual(['p-2', 'p-2', 'p-1']);
    expectAt(await box(closedPill(grid, '540'), 'the pill'), 0, 180, 'the collapsed pill, 9:00 to 12:00');
    expect(await blocks(grid), 'the Must is the only session drawn on its own').toEqual([full('i-riv204', 'p-3')]);
    await expect(grid.locator('.g-band'), 'no blocked time or lunch on this grid').toHaveCount(0);
    const must = block(grid, 'i-riv204');
    expectAt(await box(must, 'RIV204'), 180, 45, 'the Must, 12:00 to 12:45, with the pill collapsed');
    const collapsedHeight = await gridHeight(grid);
    expect(collapsedHeight, 'collapsed, the grid ends at the 1 PM line').toBeCloseTo(240, 0);

    // When the pill is open: all three sessions, linked only through the one in the middle.
    await openThePill(grid, '540');
    await expect(grid.locator('button.g-pill[data-pill="540"]'), 'the collapsed pill is replaced').toHaveCount(0);
    expect(await rowKeys(grid, '540'), 'the rows: the Wants in time order, then the Maybe').toEqual(['i-riv201', 'i-riv203', 'i-riv202']);

    // Then the pill is 180 units tall and the Must starts 180 units down...
    const pill = await box(openPill(grid, '540'), 'the open pill');
    expectAt(pill, 0, 180, 'the open pill');
    expectAt(await box(must, 'RIV204'), 180, 45, 'the Must, 12:00 to 12:45, with the pill open');
    // ...and nothing else moved either way: the 12 PM line, every other hour line, the day's end.
    const lines = await hourLines(grid);
    expect(topOf(lines, '12 PM'), 'the 12 PM hour line').toBe(180);
    expect(lines, 'every hour line is where it was').toEqual(REAL_TIME);
    const openHeight = await gridHeight(grid);
    expect(openHeight, 'the grid is exactly as tall as when the pill was collapsed').toBeCloseTo(collapsedHeight, 0);
    expect(openHeight, 'which is the 1 PM line').toBeCloseTo(240, 0);

    // The pill really is taller than its list here: the header and the three rows are 164 units
    // and end about 16 units before the pill does (32 + 44 x 3 = 164; 180 - 164 = 16).
    const listEnd = await expectList(grid, '540', pill, 3);
    expect(pill.bottom - listEnd, 'units of the pill left under its list').toBeGreaterThanOrEqual(12);
    expect(pill.bottom, 'the pill ends where the Must begins').toBeCloseTo(180, 0);
  });
});

test.describe('Rule: Tapping a session opens the same details as the list', () => {
  // The outline's BRK101 stands for "the session tapped": one session cannot be all three at
  // once, so each example taps the fixture session that is drawn that way.
  test('Tapping a full-width block opens the session details for that session', async ({ page }) => {
    await openPlan(page);
    await expect(detail(page)).toBeHidden();
    const grid = await showGrid(page);
    await expect(block(grid, 'i-brk108')).toHaveAttribute('data-cols', '1');

    await block(grid, 'i-brk108').click();
    await expectDetails(page, 'BRK108', 'Closing panel on agents');
  });

  test('Tapping one of a side-by-side pair opens the session details for that session', async ({ page }) => {
    await openPlan(page);
    await expect(detail(page)).toBeHidden();
    const grid = await showGrid(page);
    await expect(block(grid, 'i-brk106')).toHaveAttribute('data-cols', '2');
    await expect(block(grid, 'i-brk107')).toHaveAttribute('data-cols', '2');

    // Each half opens its own session, not its neighbour's.
    await block(grid, 'i-brk107').click();
    await expectDetails(page, 'BRK107', 'Governance at scale');
    await closeDetails(page);
    await block(grid, 'i-brk106').click();
    await expectDetails(page, 'BRK106', 'Zero trust for AI');
  });

  test('Tapping a row in an open pill opens the session details for that session', async ({ page }) => {
    await openPlan(page);
    await expect(detail(page)).toBeHidden();
    const grid = await showGrid(page);
    await openThePill(grid, '600');
    expect(await rowKeys(grid, '600')).toEqual(['i-brk102', 'i-brk103', 'i-brk101']);

    // The second and third rows: neither is the pill's first session.
    await pillRows(grid, '600').nth(1).click();
    await expectDetails(page, 'BRK103', 'Securing AI agents');
    await closeDetails(page);
    await expect(openPill(grid, '600'), 'the pill is still open behind the details').toBeVisible();
    await pillRows(grid, '600').nth(2).click();
    await expectDetails(page, 'BRK101', 'Agents in production');
  });

  test('Blocked time and lunch have no details: tapping either opens nothing', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    await expect(grid.locator('.g-band')).toHaveCount(2);
    const opened = () => page.evaluate(() => document.querySelector('dialog#detail').open);

    // A tap at the middle of each band, whatever is drawn there.
    for (const kind of ['block', 'lunch']) {
      await expect(band(grid, kind)).toBeVisible();
      await band(grid, kind).click({ force: true });
      await expect(detail(page), `after tapping ${kind}`).toBeHidden();
      expect(await opened(), `after tapping ${kind}`).toBe(false);
      expect(new URL(page.url()).hash).toBe('#/plan');
    }
    // The same kind of tap on a session does open details, so the page was listening.
    await block(grid, 'i-brk105').click();
    await expectDetails(page, 'BRK105', 'Data platform roadmap');
    expect(await opened()).toBe(true);
  });
});

test.describe('the grid on a phone', () => {
  // Every part of the grid is inside the viewport, and the page does not scroll sideways.
  async function expectFits(page, viewport, parts, what) {
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      parts: [...document.querySelectorAll('#main .daygrid :is(.g-block, .g-band, .g-pill, .g-row)')].map(e => {
        const r = e.getBoundingClientRect();
        return { part: e.className, left: r.left, right: r.right, width: r.width };
      }),
      switch: (() => { const r = document.querySelector('#main [role="group"][aria-label="Day view"]').getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; })(),
    }));
    expect(m.parts.length, `${what}: parts drawn`).toBe(parts);
    expect(m.overflow, `${what}: the page overflows its ${viewport.width}px viewport by ${m.overflow}px`).toBeLessThanOrEqual(1);
    for (const p of [...m.parts, { part: 'the List / Grid switch', ...m.switch }]) {
      expect(p.width, `${what}: ${p.part} has a width`).toBeGreaterThan(0);
      expect(p.left, `${what}: ${p.part} starts off-screen`).toBeGreaterThanOrEqual(0);
      expect(p.right, `${what}: ${p.part} ends past the ${viewport.width}px viewport`).toBeLessThanOrEqual(viewport.width + 1);
    }
  }

  test('the grid does not overflow the viewport horizontally, with pills closed and open, pairs and bands', async ({ page, viewport }) => {
    await openPlan(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'the list fits').toBeLessThanOrEqual(1);

    // Tuesday: 5 blocks, 2 bands, 1 pill; open, the pill also has 3 rows.
    const tuesday = await showGrid(page);
    await expectFits(page, viewport, 8, 'Tuesday');
    await openThePill(tuesday, '600');
    await expectFits(page, viewport, 11, 'Tuesday with its pill open');

    // Wednesday, both pills open: 5 blocks, lunch, 2 pills with 3 rows each.
    await tapDay(page, WED);
    const wednesday = dayGrid(page, WED);
    await expect(wednesday).toBeVisible();
    await openThePill(wednesday, '600');
    await openThePill(wednesday, '780');
    await expectFits(page, viewport, 14, 'Wednesday with both pills open');
  });
});

// ================================================================ beyond the feature file
//
// What the page does that no scenario names: the way back to the list, the wrapper the switch
// owns, what a screen reader and a keyboard get, paint order, and the stylesheet's own promises.
// Each test guards lines of app.js or app.css that could be broken without any test above
// failing. Expected values are the fixture's times, the contract at the top of
// assets/js/grid.js, and what the list already shows for the same day.

// What is directly inside the day-view wrapper: 'timeline', 'daygrid', or the tag of anything else.
const dayViewHolds = page => dayView(page).evaluate(el => [...el.children]
  .map(c => (c.matches('.timeline') ? 'timeline' : c.matches('.daygrid') ? 'daygrid' : c.tagName.toLowerCase())));
// The elements straight before and straight after the wrapper.
const aroundDayView = page => dayView(page).evaluate(el => {
  const say = n => (!n ? null : n.matches('h2') ? `h2: ${n.textContent.trim()}` : n.matches('details[data-fill]') ? `details: ${n.querySelector('summary').textContent.trim()}` : n.tagName.toLowerCase());
  return { before: say(el.previousElementSibling), after: say(el.nextElementSibling) };
});
// The day's blocked time as it was saved when the app booted: "label start-end", in minutes.
const blockedAtBoot = (page, day) => page.evaluate(([k, d]) => JSON.parse(window.__savedAtBoot[k]).prefs.blocks
  .filter(b => b.day === d).map(b => `${b.label} ${b.start}-${b.end}`), [KEYS.ignite2026, day]);
// Blocks and pills as they follow each other in the page (what the Tab key walks).
const drawnOrder = grid => grid.locator(':scope > .g-block, :scope > .g-pill')
  .evaluateAll(els => els.map(e => e.dataset.key || `pill ${e.dataset.pill}`));

// Serves the Ignite fixture catalog with some records changed, for this page only: a page's
// route is asked before the context's, so everything else still goes through serveFixture.
// `changes` maps a session code to the fields to replace.
async function serveChanged(page, changes) {
  const doc = structuredClone(CATALOGS.ignite2026);
  for (const [code, fields] of Object.entries(changes)) {
    const rec = doc.sessions.find(s => s.code === code);
    expect(rec, `${code} is in the fixture catalog`).toBeTruthy();
    Object.assign(rec, fields);
  }
  await page.route('**/data/ignite2026/sessions.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) }));
}

test.describe('beyond the feature file: the switch and the part of the page it owns', () => {
  test('beyond the feature file: choosing List after Grid shows the list again, saves "list", and that survives a reload', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    expect(await blocks(grid)).toEqual(TUESDAY_BLOCKS);
    await expectSavedView(page, KEYS.ignite2026, 'grid');   // so "list" below replaces a saved "grid"

    await choose(page, 'list');
    expect(await dayView(page).locator('.timeline .t-item [data-card]').evaluateAll(els => els.map(e => e.dataset.card)), 'the list is back, inside the day view')
      .toEqual(BOOTED.ignite2026.timeline);
    await expect(page.locator('#main .daygrid'), 'the grid is gone').toHaveCount(0);
    await expectSavedView(page, KEYS.ignite2026, 'list');
    expect((await savedUi(page, KEYS.reinvent2026)).planView, 're:Invent\'s choice was never touched').toBeUndefined();

    await page.reload();
    await expectPlanBooted(page, 'ignite2026');
    expect((await uiAtBoot(page, KEYS.ignite2026)).planView, 'the choice the planner booted with').toBe('list');
    await expectSwitch(page, 'list');
    await expect(page.locator('#main .daygrid')).toHaveCount(0);
  });

  test('beyond the feature file: the switch reads List, then Grid', async ({ page }) => {
    await openPlan(page);
    await expectSwitch(page, 'list');
    const buttons = viewSwitch(page).locator('button');
    await expect(buttons).toHaveText(['List', 'Grid']);
    expect(await buttons.evaluateAll(els => els.map(e => e.dataset.view))).toEqual(['list', 'grid']);
    // ...and on screen: List is left of Grid, on the same line.
    const list = await viewButton(page, 'list').boundingBox(), grid = await viewButton(page, 'grid').boundingBox();
    expect(list.width, 'List has a width').toBeGreaterThan(0);
    expect(list.x + list.width, 'List ends where Grid begins, or before').toBeLessThanOrEqual(grid.x + 0.5);
    expect(list.y, 'on one line').toBeCloseTo(grid.y, 0);
  });

  // WCAG 2.5.5 / Apple's guideline, as for the tab bar in viewport.spec.js: 44px. Both phone
  // projects run this test.
  test('beyond the feature file: the List and Grid buttons are at least 44px tall on a phone', async ({ page }) => {
    await openPlan(page);
    await expectSwitch(page, 'list');
    for (const view of ['list', 'grid']) {
      const b = await viewButton(page, view).boundingBox();
      expect(b.height, `the ${view} button's height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('beyond the feature file: the selected button looks different from the other, and the look moves with the choice', async ({ page }) => {
    await openPlan(page);
    await expectSwitch(page, 'list');
    const look = view => viewButton(page, view).evaluate(e => { const c = getComputedStyle(e); return `${c.backgroundColor} on ${c.color}`; });
    const selected = await look('list'), plain = await look('grid');
    expect(selected, 'List (selected) does not look like Grid').not.toBe(plain);

    await choose(page, 'grid');
    expect(await look('grid'), 'Grid now looks as List did').toBe(selected);
    expect(await look('list'), 'and List as Grid did').toBe(plain);
  });

  test('beyond the feature file: keyboard focus stays on the switch button that was used', async ({ page }) => {
    await openPlan(page);
    await expectSwitch(page, 'list');
    // Grid is the second button: "focus the first button of the switch" is not enough.
    await viewButton(page, 'grid').focus();
    await expect(viewButton(page, 'grid')).toBeFocused();
    await page.keyboard.press('Enter');
    await expectSwitch(page, 'grid');
    await expect(dayGrid(page, TUE), 'the page was drawn again, as the grid').toBeVisible();
    await expect(viewButton(page, 'grid'), 'focus after choosing Grid').toBeFocused();

    await viewButton(page, 'list').focus();
    await page.keyboard.press('Enter');
    await expectSwitch(page, 'list');
    await expect(page.locator('#main .timeline'), 'the page was drawn again, as the list').toBeVisible();
    await expect(viewButton(page, 'list'), 'focus after choosing List').toBeFocused();
  });

  // The switch changes only what is inside [data-day-view], so that wrapper holds the day's
  // drawing and nothing else: the "unchanged around it" test sets the wrapper aside before it
  // compares, and would not notice a heading or a panel that had moved into it.
  test('beyond the feature file: the day view holds only the day\'s drawing; "Your day" is before it and "More sessions" after it', async ({ page }) => {
    await openPlan(page);
    const around = { before: 'h2: Your day', after: 'details: More sessions that fit around this day' };
    for (const view of ['list', 'grid']) {
      if (view === 'grid') await choose(page, 'grid');
      await expectSwitch(page, view);
      expect(await dayViewHolds(page), `${view}: what the day view holds`).toEqual([view === 'grid' ? 'daygrid' : 'timeline']);
      expect(await aroundDayView(page), `${view}: what is around the day view`).toEqual(around);
      // Each is on the page once, so "not in the wrapper" is not "nowhere".
      await expect(page.locator('#main h2', { hasText: /^Your day$/ }), `${view}: the heading`).toHaveCount(1);
      await expect(page.locator('#main details[data-fill]'), `${view}: the "More sessions" panel`).toHaveCount(1);
      await expect(page.locator('#main details[data-fill]')).toHaveAttribute('data-fill', `${TUE}:all`);
      await expect(dayView(page).locator('h2, details'), `${view}: neither is inside the day view`).toHaveCount(0);
    }
  });
});

test.describe('beyond the feature file: a day with nothing of the plan on it', () => {
  // "No sessions planned" belongs to a grid that has only blocked time and lunch. Tuesday, with
  // five sessions in the plan, is the other side: same page, same switch, no such note.
  test('beyond the feature file: "No sessions planned" is under a grid of only blocked time and lunch, and not under a grid with sessions', async ({ page }) => {
    const flight = { id: 'flight', day: FRI, start: 900, end: 960, label: 'Flight home', building: 'W' };
    await openPlan(page, { state: { ignite: { blocks: [...BLOCKS, flight] } } });
    expect(await blockedAtBoot(page, FRI)).toEqual(['Flight home 900-960']);

    const tuesday = await showGrid(page);
    expect(await blocks(tuesday), 'Tuesday has sessions on its grid').toEqual(TUESDAY_BLOCKS);
    expect(await dayViewHolds(page), 'Tuesday: the grid and nothing under it').toEqual(['daygrid']);
    await expect(page.locator('#main'), 'Tuesday').not.toContainText('No sessions planned');

    await tapDay(page, FRI);
    const friday = dayGrid(page, FRI);
    await expect(friday).toBeVisible();
    await expect(friday.locator('.g-band'), 'Friday: blocked time and lunch').toHaveCount(2);
    await expect(friday.locator('.g-block, .g-pill'), 'Friday: no session').toHaveCount(0);
    expect(await dayViewHolds(page), 'Friday: the grid and its note').toEqual(['daygrid', 'p']);
    const note = dayView(page).locator(':scope > p');
    await expect(note).toHaveText(/^No sessions planned on Fri, Nov 20\./);
    await expect(note).toBeVisible();
    const noteBox = await note.boundingBox(), gridBox = await friday.boundingBox();
    expect(noteBox.y, 'the note is under the grid').toBeGreaterThanOrEqual(gridBox.y + gridBox.height - 0.5);
  });

  // With nothing planned there is nothing to fold "More sessions" away behind: the sessions that
  // fit are listed open, straight under the day view. Friday's three unrated sessions (10:00,
  // 11:00, 1:00) all fit an empty day.
  test('beyond the feature file: a day with nothing planned lists the sessions that fit, open, in the list and in the grid', async ({ page }) => {
    await openPlan(page);
    // Tuesday has a plan: there the same sessions-that-fit are folded away in a closed panel.
    const folded = page.locator('#main details[data-fill]');
    await expect(folded, 'Tuesday: the "More sessions" panel').toHaveCount(1);
    expect(await folded.evaluate(el => el.open), 'Tuesday: the panel is closed').toBe(false);

    await tapDay(page, FRI);
    const fits = page.locator('#main [data-day-view] + .list [data-card]');
    for (const view of ['list', 'grid']) {
      if (view === 'grid') await choose(page, 'grid');
      await expectSwitch(page, view);
      await expect(dayView(page).locator('.panel.empty h3'), view).toHaveText('Nothing planned on Fri, Nov 20');
      await expect(page.locator('#main details[data-fill]'), `${view}: no folded panel`).toHaveCount(0);
      expect((await fits.evaluateAll(els => els.map(e => e.dataset.card))).sort(), `${view}: the sessions that fit, straight under the day view`)
        .toEqual(['i-brk501', 'i-brk502', 'i-brk503']);
      for (const key of ['i-brk501', 'i-brk502', 'i-brk503']) await expect(fits.and(page.locator(`[data-card="${key}"]`)), `${view}: ${key}`).toBeVisible();
    }
  });
});

test.describe('beyond the feature file: what is drawn on the grid', () => {
  // grid.js gridEntries: the bands are the day's blocked time, all of it. The plan's own chain
  // keeps only one of two blocked times that overlap each other, so the grid must not be fed
  // from the chain.
  test('beyond the feature file: two blocked times that overlap each other are both on the grid, each at its own time', async ({ page }) => {
    const second = { id: 'second', day: TUE, start: 570, end: 630, label: 'Second duty', building: 'W' };
    await openPlan(page, { state: { ignite: { blocks: [...BLOCKS, second] } }, list: false });
    expect(await blockedAtBoot(page, TUE), 'Tuesday\'s blocked time: 9:00-10:00 and 9:30-10:30').toEqual(['Booth duty 540-600', 'Second duty 570-630']);

    const grid = await showGrid(page);
    expect((await hourLines(grid))[0], 'the grid starts at 9 AM').toEqual(line(540, '9 AM', 0));
    await expect(band(grid, 'block'), 'two blocked-time bands').toHaveCount(2);
    const booth = band(grid, 'block').filter({ hasText: 'Booth duty' }), duty = band(grid, 'block').filter({ hasText: 'Second duty' });
    await expect(booth).toHaveCount(1);
    await expect(duty).toHaveCount(1);
    expectAt(await box(booth, 'Booth duty'), 0, 60, 'Booth duty, 9:00 to 10:00');
    expectAt(await box(duty, 'Second duty'), 30, 60, 'Second duty, 9:30 to 10:30');
    // Still bands, not sessions: the 10:00 pill counts three.
    await expectCollapsed(grid, '600', '3 sessions at this time');
  });

  test('beyond the feature file: lunch and blocked time each show their own icon, and neither is a button or a keyboard stop', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    await expect(grid.locator('.g-band')).toHaveCount(2);
    await expect(band(grid, 'lunch')).toContainText('Lunch');
    await expect(band(grid, 'lunch')).toContainText('🍽');
    await expect(band(grid, 'lunch')).not.toContainText('⛔');
    await expect(band(grid, 'block')).toContainText('Booth duty');
    await expect(band(grid, 'block')).toContainText('⛔');
    await expect(band(grid, 'block')).not.toContainText('🍽');

    // A band is plain text: not a button, a link or anything else the Tab key stops at...
    const STOPS = 'button, a, input, select, textarea, summary, [tabindex], [role="button"], [contenteditable]';
    expect(await grid.locator('.g-band').evaluateAll((els, stops) => els.map(e => [e.dataset.band, e.tagName, e.tabIndex, e.matches(stops)]), STOPS))
      .toEqual([['block', 'DIV', -1, false], ['lunch', 'DIV', -1, false]]);
    await expect(grid.locator('.g-band').locator(STOPS), 'and holds none').toHaveCount(0);
    // ...while a session on the same grid is one, so the check can tell the difference.
    expect(await block(grid, 'i-brk105').evaluate((e, stops) => [e.tagName, e.tabIndex, e.matches(stops)], STOPS)).toEqual(['BUTTON', 0, true]);
  });

  // grid.js: a band is y(endMin) - y(startMin) tall, and y() adds an open pill's extra height
  // from the pill's end on. A band that starts before the 10:00 pill ends (10:45) and ends after
  // it is therefore 119 taller while the pill is open (32 + 3 x 44 - 45 = 119).
  test('beyond the feature file: blocked time that spans the end of an open pill stretches with it', async ({ page }) => {
    const call = { id: 'call', day: TUE, start: 570, end: 690, label: 'Call', building: 'W' };
    await openPlan(page, { state: { ignite: { blocks: [...BLOCKS.filter(b => b.day !== TUE), call] } }, list: false });
    expect(await blockedAtBoot(page, TUE), 'Tuesday\'s blocked time: 9:30 to 11:30').toEqual(['Call 570-690']);
    const rows = page.locator('#main .timeline > .t-item');
    await expect(rows.first()).toContainText('Call');
    await expect(rows.first().locator('.t-time')).toHaveText('9:30 AM11:30 AM');

    const grid = await showGrid(page);
    expect(await hourLines(grid), 'the grid starts at 9 AM, every hour at its real time').toEqual(NINE_TO_FIVE);
    await expectCollapsed(grid, '600');
    const strip = band(grid, 'block');
    await expect(strip).toHaveCount(1);
    await expect(strip).toContainText('Call');
    expectAt(await box(strip, 'the call'), 30, 120, 'collapsed: 9:30 to 11:30');
    expectAt(await box(band(grid, 'lunch'), 'lunch'), 180, 45, 'collapsed: lunch 12:00 to 12:45');

    await openThePill(grid, '600');
    const lines = await hourLines(grid);
    expect(topOf(lines, '11 AM'), 'the 11 AM hour line moved 119').toBe(239);
    expect(topOf(lines, '12 PM'), 'the 12 PM hour line moved 119').toBe(299);
    // 9:30 is before the pill's end and did not move; 11:30 is after it and moved 119.
    const open = await box(strip, 'the call');
    expectAt(open, 30, 239, 'open: 9:30 to 11:30');
    expect(open.bottom, 'it ends half-way between the 11 AM and 12 PM lines').toBeCloseTo(269, 0);
    // Lunch is wholly after the pill: it moves and keeps its length.
    expectAt(await box(band(grid, 'lunch'), 'lunch'), 299, 45, 'open: lunch 12:00 to 12:45');
  });

  // The room a block shows is the app's label for it, as on a session card, not the catalog's
  // raw field: a timed session whose room is not announced yet says "Room TBA".
  test('beyond the feature file: a timed pick with no room yet shows "Room TBA", as its card in the list does', async ({ page }) => {
    await serveChanged(page, { BRK105: { room: null, roomTbd: true } });
    await openPlan(page);
    await expect(page.locator('#main .timeline [data-card="i-brk105"] .meta'), 'BRK105 in the list').toContainText('Room TBA');
    await expect(page.locator('#main .timeline [data-card="i-brk108"] .meta'), 'BRK108 in the list').toContainText('Moscone West, Level 2, Room 2008');

    const grid = await showGrid(page);
    await expect(block(grid, 'i-brk105').locator('.g-title')).toHaveText('Data platform roadmap');
    await expect(block(grid, 'i-brk105').locator('.g-room'), 'BRK105 on the grid').toHaveText('Room TBA');
    await expect(block(grid, 'i-brk108').locator('.g-room'), 'a session with a room shows the room').toHaveText('Moscone West, Level 2, Room 2008');
    await expectPainted(block(grid, 'i-brk105').locator('.g-room'), 'BRK105: "Room TBA"');
    await expectPainted(block(grid, 'i-brk108').locator('.g-room'), 'BRK108: its room');
  });

  // Titles and rooms come from the catalog and a blocked time's label from what was typed in
  // Settings: the grid shows each as the text it is. Each marker would set its global if its
  // markup were ever parsed (the image fails to load and its onerror runs); the last step parses
  // one on purpose, so "no marker ran" is not "markers never run here".
  test('beyond the feature file: markup in a title, a room or a blocked-time label is shown as text, in a block, a pill row and a band', async ({ page }) => {
    const marker = (n, name = '__xss') => `<img src=x onerror="window.${name}=${n}">`;
    const title = `${marker(1)}Data platform roadmap`, room = `${marker(2)}Room 2005`, rowTitle = `${marker(3)}Securing AI agents`, label = `${marker(4)}Booth duty`;
    await serveChanged(page, { BRK105: { title, room }, BRK103: { title: rowTitle } });
    await openPlan(page, { state: { ignite: { blocks: BLOCKS.map(b => (b.id === 'booth' ? { ...b, label } : b)) } } });
    // The page really holds them: the list shows the same four as text.
    expect(await blockedAtBoot(page, TUE)).toEqual([`${label} 540-600`]);
    await expect(page.locator('#main .timeline > .t-item').first()).toContainText(label);
    await expect(page.locator('#main .timeline [data-card="i-brk105"] .title')).toHaveText(title);
    await expect(page.locator('#main .timeline [data-card="i-brk105"] .meta')).toContainText(room);
    await expect(page.locator('#main .sacrifices [data-card="i-brk103"] .title')).toHaveText(rowTitle);

    const grid = await showGrid(page);
    await expect(block(grid, 'i-brk105').locator('.g-title'), 'a block\'s title').toHaveText(title);
    await expect(block(grid, 'i-brk105').locator('.g-room'), 'a block\'s room').toHaveText(room);
    await expect(band(grid, 'block'), 'a band\'s label').toContainText(label);
    await openThePill(grid, '600');
    expect(await rowKeys(grid, '600')).toEqual(['i-brk102', 'i-brk103', 'i-brk101']);
    await expect(pillRows(grid, '600').nth(1).locator('.g-title'), 'a pill row\'s title').toHaveText(rowTitle);

    await expect(grid.locator('img'), 'no image element anywhere in the grid').toHaveCount(0);
    await expect(grid.locator('.g-block, .g-band, .g-pill, .g-row'), 'while the grid is all there: 5 blocks, 2 bands, 1 pill, 3 rows').toHaveCount(11);
    await page.evaluate(html => document.body.insertAdjacentHTML('beforeend', `<div hidden>${html}</div>`), marker(5, '__control'));
    await expect.poll(() => page.evaluate(() => window.__control), { message: 'the same markup, parsed on purpose, does run' }).toBe(5);
    expect(await page.evaluate(() => window.__xss), 'no marker in the grid ran').toBeUndefined();
  });

  // Wednesday: a block at 9:14, the 10:00 pill, a block at 11:00, the 1:00 pill, then blocks at
  // 2:00, 3:00 and 3:55. In the page they follow each other in that order, pills among the
  // blocks, so the Tab key walks the day from top to bottom.
  test('beyond the feature file: blocks and pills are in time order in the page, and the Tab key follows it', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page, WED);
    expect(await blocks(grid)).toEqual(WEDNESDAY_BLOCKS);
    const order = ['i-brk201', 'pill 600', 'i-brk206', 'pill 780', 'i-brk214', 'i-brk310-r1', 'i-brk207'];
    expect(await drawnOrder(grid)).toEqual(order);

    await block(grid, 'i-brk201').focus();
    await expect(block(grid, 'i-brk201')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closedPill(grid, '600'), 'Tab from the 9:14 session').toBeFocused();
    await page.keyboard.press('Tab');
    await expect(block(grid, 'i-brk206'), 'Tab from the 10:00 pill').toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closedPill(grid, '780'), 'Tab from the 11:00 session').toBeFocused();

    // An open pill keeps its place.
    await openThePill(grid, '600');
    expect(await drawnOrder(grid), 'with the 10:00 pill open').toEqual(order);
  });

  // The rating is a colour on the grid; a screen reader gets it as a word before the rest.
  // Thursday has a Must, a Want and a Maybe drawn as blocks; Tuesday's pill has one of each.
  test('beyond the feature file: the rating is said in words, the right word, on blocks and on pill rows', async ({ page }) => {
    await openPlan(page);
    const thursday = await showGrid(page, THU);
    expect(await blocks(thursday)).toEqual(THURSDAY_BLOCKS);
    for (const [key, prio, word, reads] of [
      ['i-brk305', /\bp-3\b/, 'Must:', /^\s*Must:\s.*Platform engineering keynote recap/],
      ['i-brk302', /\bp-2\b/, 'Want:', /^\s*Want:\s.*Networking for AI workloads/],
      ['i-brk304', /\bp-1\b/, 'Maybe:', /^\s*Maybe:\s.*Early bird Q&A/],
    ]) {
      await expect(block(thursday, key), `${key}: its colour`).toHaveClass(prio);
      await expect(block(thursday, key).locator('.sr-only'), `${key}: its rating in words`).toHaveText(word);
      await expect(block(thursday, key), `${key}: the rating comes first, then the session`).toHaveText(reads);
    }

    await tapDay(page, TUE);
    const tuesday = dayGrid(page, TUE);
    await openThePill(tuesday, '600');
    expect(await rowKeys(tuesday, '600')).toEqual(['i-brk102', 'i-brk103', 'i-brk101']);
    await expect(pillRows(tuesday, '600')).toHaveClass([/\bp-3\b/, /\bp-2\b/, /\bp-1\b/]);
    await expect(pillRows(tuesday, '600').locator('.sr-only')).toHaveText(['Must:', 'Want:', 'Maybe:']);
    await expect(pillRows(tuesday, '600'), 'each row: the rating, then the session')
      .toHaveText([/^\s*Must:\s+Copilot rollout playbook/, /^\s*Want:\s+Securing AI agents/, /^\s*Maybe:\s+Agents in production/]);
  });
});

test.describe('beyond the feature file: pills', () => {
  // A pill is open by its start time. When the plan changes so that the pill is gone (one of its
  // three moved to watch later leaves a pair), "open" is forgotten with it: three again is a new,
  // collapsed pill.
  test('beyond the feature file: an open pill that leaves the grid and comes back, comes back collapsed', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    await openThePill(grid, '600');
    expect(await rowKeys(grid, '600')).toEqual(['i-brk102', 'i-brk103', 'i-brk101']);
    expect(topOf(await hourLines(grid), '11 AM'), 'open: 11 AM is pushed down').toBe(239);

    // BRK101 (the Maybe) goes to the watch-later list: two sessions are left at 10:00.
    await page.locator('#main .sacrifices [data-act="watch-later"][data-key="i-brk101"]').click();
    await expect(page.locator('#main h2', { hasText: 'Watch later (2)' })).toBeVisible();
    expect((await readPlan(page)).sections['Watch later (2)']).toEqual(['i-brk101', 'i-brk104']);
    await expect(grid.locator('[data-pill]'), 'no pill any more').toHaveCount(0);
    await expect(block(grid, 'i-brk102'), 'the two that are left are a pair').toHaveAttribute('data-cols', '2');
    await expect(block(grid, 'i-brk103')).toHaveAttribute('data-cols', '2');
    await expect(dayView(page).locator('[data-key="i-brk101"]'), 'BRK101 is off the grid').toHaveCount(0);

    // ...and back to the live plan: three again.
    await page.locator('#main [data-act="attend-live"][data-key="i-brk101"]').click();
    await expect(page.locator('#main h2', { hasText: 'Watch later (1)' })).toBeVisible();
    await expectCollapsed(grid, '600', '3 sessions at this time');
    await expect(grid.locator('.g-pill'), 'one pill').toHaveCount(1);
    await expect(grid.locator('.g-row, .g-pill-head'), 'no open list').toHaveCount(0);
    expect(topOf(await hourLines(grid), '11 AM'), '11 AM is at its real time').toBe(120);
    // It still opens: collapsed is a state, not a pill that stopped working.
    await openThePill(grid, '600');
    expect(await rowKeys(grid, '600')).toEqual(['i-brk102', 'i-brk103', 'i-brk101']);
  });

  test('beyond the feature file: an open pill is a group named by its label, and its header keeps the label and the dots', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    const named = grid.getByRole('group', { name: '3 sessions at this time', exact: true });
    await expectCollapsed(grid, '600', '3 sessions at this time');
    await expect(named, 'collapsed, the pill is one button and no group').toHaveCount(0);

    await openThePill(grid, '600');
    await expect(named, 'the open pill, by role and name').toHaveCount(1);
    await expect(named).toHaveAttribute('data-pill', '600');
    await expect(openPill(grid, '600')).toHaveAttribute('role', 'group');
    await expect(openPill(grid, '600')).toHaveAttribute('aria-label', '3 sessions at this time');
    // The header says what the collapsed pill said, with the same three dots: Must, Want, Maybe.
    await expect(pillHead(grid, '600')).toHaveText('3 sessions at this time');
    expect(await dots(pillHead(grid, '600')), 'the header\'s dots').toEqual(['p-3', 'p-2', 'p-1']);
    expect(await dots(openPill(grid, '600')), 'and no other dots in the open pill').toEqual(['p-3', 'p-2', 'p-1']);
  });

  // Wednesday's second pill (1:00 to 1:45) is 240 units down at its real time. The first pill,
  // open, is 119 taller than its 45 minutes (32 + 3 x 44 - 45), so everything from 10:45 on is
  // 119 further down: the second pill at 359, closed or open, on the 1 PM line.
  test('beyond the feature file: a second pill below an open pill is pushed down by it, closed and open', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page, WED);
    expect(await hourLines(grid), 'the grid starts at 9 AM, every hour at its real time').toEqual(NINE_TO_FIVE);
    await expectCollapsed(grid, '600');
    await expectCollapsed(grid, '780');
    expectAt(await box(closedPill(grid, '780'), 'the 1:00 pill'), 240, 45, 'both collapsed: the 1:00 pill at its real time');

    await openThePill(grid, '600');
    await expectCollapsed(grid, '780');
    expectAt(await box(closedPill(grid, '780'), 'the 1:00 pill'), 359, 45, 'the 1:00 pill, closed, under the open 10:00 pill');
    expect(topOf(await hourLines(grid), '1 PM'), 'the 1 PM hour line is there too').toBe(359);

    await openThePill(grid, '780');
    await expect(openPill(grid, '600'), 'the 10:00 pill is still open').toBeVisible();
    const second = await box(openPill(grid, '780'), 'the 1:00 pill, open');
    expectAt(second, 359, 164, 'the 1:00 pill, open, under the open 10:00 pill');
    expect(topOf(await hourLines(grid), '1 PM')).toBe(359);
    // The first pill itself has nothing open above it: it stays at 10:00.
    expectAt(await box(openPill(grid, '600'), 'the 10:00 pill, open'), 60, 164, 'the open 10:00 pill');
    await expectList(grid, '780', second, 3);
  });

  // Opening a pill replaces a button with a list whose header is another button. Focus goes to
  // the same pill's other form: on Wednesday the second pill (1:00), so "the first pill of the
  // day" is the wrong answer.
  test('beyond the feature file: keyboard focus stays on the pill that was opened or closed', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page, WED);
    await expectCollapsed(grid, '600');
    await expectCollapsed(grid, '780');

    await closedPill(grid, '780').focus();
    await expect(closedPill(grid, '780')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(openPill(grid, '780'), 'Enter opened the 1:00 pill').toBeVisible();
    await expectCollapsed(grid, '600');
    await expect(pillHead(grid, '780'), 'focus is on its header').toBeFocused();

    await page.keyboard.press('Enter');
    await expectCollapsed(grid, '780');
    await expect(closedPill(grid, '780'), 'Enter closed it again; focus is on the pill').toBeFocused();
  });
});

test.describe('beyond the feature file: the grid on screen', () => {
  // Bands are drawn first and sessions over them. toBeVisible() does not see what is on top, so
  // these are real taps: Playwright refuses to tap an element that something else covers.
  test('beyond the feature file: a session drawn over blocked time or over lunch can be tapped and opens its details', async ({ page }) => {
    await openPlan(page);
    await expect(detail(page)).toBeHidden();
    const grid = await showGrid(page, THU);
    // BRK301 (2:00-2:45) and BRK302 (2:15-3:00) are inside the 2:00-4:00 meeting, BRK303
    // (12:15-12:45) inside lunch (12:00-12:45).
    const meeting = await box(band(grid, 'block'), 'blocked time'), lunch = await box(band(grid, 'lunch'), 'lunch');
    for (const [key, over, what] of [['i-brk301', meeting, 'the meeting'], ['i-brk302', meeting, 'the meeting'], ['i-brk303', lunch, 'lunch']]) {
      const b = await box(block(grid, key), key);
      expect(b.top, `${key} starts inside ${what}`).toBeGreaterThanOrEqual(over.top - 0.5);
      expect(b.bottom, `${key} ends inside ${what}`).toBeLessThanOrEqual(over.bottom + 0.5);
      expect(b.left, `${key} is across ${what}`).toBeGreaterThanOrEqual(over.left);
      expect(b.right).toBeLessThanOrEqual(over.right);
    }

    await block(grid, 'i-brk301').click();
    await expectDetails(page, 'BRK301', 'Migration war stories');
    await closeDetails(page);
    await block(grid, 'i-brk302').click();
    await expectDetails(page, 'BRK302', 'Networking for AI workloads');
    await closeDetails(page);
    await block(grid, 'i-brk303').click();
    await expectDetails(page, 'BRK303', 'Lunchtime lightning demos');
  });

  // The stylesheet's --g-gap: the halves of a pair do not touch. Some gap a person can see
  // (2px or more), and still a gap rather than a missing column (8px at most).
  test('beyond the feature file: there is a gap between the two halves of a pair', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    await expect(block(grid, 'i-brk106')).toHaveAttribute('data-col', '0');
    await expect(block(grid, 'i-brk107')).toHaveAttribute('data-col', '1');
    const left = await box(block(grid, 'i-brk106'), 'BRK106'), right = await box(block(grid, 'i-brk107'), 'BRK107');
    expect(left.width, 'the left half has a width').toBeGreaterThan(50);
    expect(right.left - left.right, 'px between the left half and the right half').toBeGreaterThanOrEqual(2);
    expect(right.left - left.right, 'px between the left half and the right half').toBeLessThanOrEqual(8);
  });

  // The hour labels have the left of the grid to themselves: every band, block and pill starts
  // to the right of the widest label, with the pill closed and open.
  test('beyond the feature file: nothing is drawn over the hour labels', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page);
    const measure = () => grid.evaluate(g => {
      const from = g.getBoundingClientRect().left;
      const span = e => { const r = e.getBoundingClientRect(); return { left: r.left - from, right: r.right - from, width: r.width }; };
      return {
        labels: [...g.querySelectorAll('.g-hour span')].map(e => ({ text: e.textContent.trim(), ...span(e) })),
        parts: [...g.querySelectorAll('.g-block, .g-band, .g-pill')].map(e => ({ part: `${e.className} ${e.dataset.key || e.dataset.band || e.dataset.pill}`, ...span(e) })),
      };
    });
    for (const state of ['pill closed', 'pill open']) {
      if (state === 'pill open') await openThePill(grid, '600');
      const m = await measure();
      expect(m.labels.map(l => l.text), `${state}: the hour labels`).toEqual(['9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM']);
      for (const l of m.labels) expect(l.width, `${state}: the ${l.text} label has a width`).toBeGreaterThan(10);
      const labelsEnd = Math.max(...m.labels.map(l => l.right));
      expect(m.parts.length, `${state}: 5 blocks, 2 bands and 1 pill`).toBe(8);
      for (const p of m.parts) expect(p.left, `${state}: ${p.part} starts at ${p.left}px, the hour labels end at ${labelsEnd}px`).toBeGreaterThanOrEqual(labelsEnd);
    }
  });

  // The stylesheet's --g-inset: "a band stays visible on both sides of a session drawn over it".
  // The band's own left border is 3px, so 4px or more of it on each side is band, not border.
  test('beyond the feature file: a band shows on both sides of a session drawn over it', async ({ page }) => {
    await openPlan(page);
    const grid = await showGrid(page, THU);
    await expect(block(grid, 'i-brk301')).toHaveAttribute('data-col', '0');
    await expect(block(grid, 'i-brk302')).toHaveAttribute('data-col', '1');
    await expect(block(grid, 'i-brk303')).toHaveAttribute('data-cols', '1');
    const meeting = await box(band(grid, 'block'), 'blocked time'), lunch = await box(band(grid, 'lunch'), 'lunch');
    const leftHalf = await box(block(grid, 'i-brk301'), 'BRK301'), rightHalf = await box(block(grid, 'i-brk302'), 'BRK302'), whole = await box(block(grid, 'i-brk303'), 'BRK303');
    // The sessions really are over their bands (2:00-2:45 and 2:15-3:00 in 2:00-4:00; 12:15-12:45 in 12:00-12:45).
    for (const [b, over] of [[leftHalf, meeting], [rightHalf, meeting], [whole, lunch]]) {
      expect(b.top).toBeGreaterThanOrEqual(over.top - 0.5);
      expect(b.bottom).toBeLessThanOrEqual(over.bottom + 0.5);
    }
    expect(leftHalf.left - meeting.left, 'px of the meeting left of the pair').toBeGreaterThanOrEqual(4);
    expect(meeting.right - rightHalf.right, 'px of the meeting right of the pair').toBeGreaterThanOrEqual(4);
    expect(whole.left - lunch.left, 'px of lunch left of the session').toBeGreaterThanOrEqual(4);
    expect(lunch.right - whole.right, 'px of lunch right of the session').toBeGreaterThanOrEqual(4);
  });
});
