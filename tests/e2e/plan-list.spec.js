// My plan's List view on a day with no planned session, in a real browser (issue #156,
// specs/features/plan-day-list.feature): blocked time is listed at its own time there, as it
// is on a day that has sessions.
//
// Each test name starts with the title of the scenario it covers. Same conventions as
// plan-grid.spec.js: the fixture's catalogs and saved picks (plan-grid.fixture.js), a fixed
// clock, a browser time zone that is not the conference's, and no request leaves the local
// server. Friday has no pick in the fixture; lunch is pinned to 12:00-12:45 and walking is
// zeroed, so the rows depend only on the clock times given here.

import { test, expect as baseExpect } from '@playwright/test';
import { serveFixture, seedState, BLOCKS, FIXED_NOW, KEYS, TUE, FRI } from './plan-grid.fixture.js';

const expect = baseExpect.configure({ timeout: 4000 });
const BOOT_TIMEOUT = 15_000;

test.use({ timezoneId: 'Asia/Tokyo', locale: 'en-US', serviceWorkers: 'block', actionTimeout: 5000, navigationTimeout: 15_000 });

let traffic;      // what the page asked for (fixture serveFixture)
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
  // The page ran on the fixture alone: the only host it reached for besides the local server is
  // the conference site's (the live check, refused), the Ignite catalog is the one data file it
  // was served, and every other data file it asked for is one of Ignite's and was absent.
  expect([...new Set(traffic.blocked)].filter(host => host !== 'eventtools.event.microsoft.com'), 'other hosts the page asked for').toEqual([]);
  expect(traffic.data.filter(d => d.startsWith('200')), 'data files served').toEqual(['200 /data/ignite2026/sessions.json']);
  expect(traffic.data.filter(d => !d.startsWith('200') && !d.startsWith('404 /data/ignite2026/')), 'data files asked for outside the Ignite fixture').toEqual([]);
});

const dayView = page => page.locator('#main [data-day-view]');

// Every row of the day's list, in page order, as "kind | start-end | text": kind is the row's
// class (t-item: a session or blocked time; t-lunch; t-move, with how the move is rated: the
// walk between two rows; t-free: free time between two rows). A row without a time has an empty
// middle part.
const listRows = page => dayView(page).locator('.timeline > *').evaluateAll(els => els.map(e => {
  const time = e.querySelector(':scope > .t-time');
  const span = time ? `${time.firstChild.textContent.trim()}-${time.querySelector('small').textContent.trim()}` : '';
  const text = [...e.children].filter(c => c !== time).map(c => c.textContent).join(' ').replace(/\s+/g, ' ').trim();
  return `${e.className} | ${span} | ${text}`;
}));
// What the day view holds, in order: the "Nothing planned" panel and the list under it.
const dayViewHolds = page => dayView(page).evaluate(el => [...el.children]
  .map(c => (c.matches('.timeline') ? 'timeline' : c.matches('.panel.empty') ? 'nothing planned' : c.tagName.toLowerCase())));
// The sessions offered straight under the day view (open, not folded away), in page order.
const fits = page => page.locator('#main [data-day-view] + .list [data-card]').evaluateAll(els => els.map(e => e.dataset.card).sort());
// The day's blocked time as it was saved when the app booted: "label start-end", in minutes.
const blockedAtBoot = (page, day) => page.evaluate(([k, d]) => JSON.parse(window.__savedAtBoot[k]).prefs.blocks
  .filter(b => b.day === d).map(b => `${b.label} ${b.start}-${b.end}`), [KEYS.ignite2026, day]);

const LUNCH = 't-lunch | 12:00 PM-12:45 PM | 🍽 Lunch break (protected; change it in Settings)';
const blockedRow = (label, from, to) => `t-item | ${from}-${to} | ⛔ ${label} West (blocked time)`;

// Seeds the fixture's state with `blocks` as its blocked time, opens My plan (Tuesday, in the
// List view) and checks the harness: Tuesday's list as it is with or without this change, its
// blocked time among its sessions.
async function openPlan(page, blocks = BLOCKS) {
  await seedState(page.context(), { ignite: { blocks } });
  await page.goto('/#/plan');
  await expect(page).toHaveTitle('Ignite Planner', { timeout: BOOT_TIMEOUT });
  await expect(page.locator('#main h1')).toHaveText('My plan', { timeout: BOOT_TIMEOUT });
  await expect(dayView(page)).toHaveAttribute('data-day-view', 'list');
  await expect(page.locator(`#main .daytabs [data-day="${TUE}"]`)).toHaveAttribute('aria-pressed', 'true');
  const tuesday = await listRows(page);
  expect(tuesday.filter(r => r.startsWith('t-item')).length, 'Tuesday: blocked time and five sessions').toBe(6);
  expect(tuesday[0], 'Tuesday: blocked time on a day with sessions').toBe(blockedRow('Booth duty', '9:00 AM', '10:00 AM'));
  await expect(page.locator('#main .panel.empty'), 'Tuesday has sessions: no "Nothing planned"').toHaveCount(0);
}

async function showFriday(page) {
  const tab = page.locator(`#main .daytabs [data-act="day"][data-day="${FRI}"]`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
  await expect(dayView(page)).toHaveAttribute('data-day-view', 'list');
  // No session is planned on Friday: the tab counts none and the list has no session card.
  await expect(tab.locator('.n')).toHaveText('0');
  await expect(dayView(page).locator('[data-card]')).toHaveCount(0);
  await expect(dayView(page).locator('.panel.empty h3')).toHaveText('Nothing planned on Fri, Nov 20');
  await expect(dayView(page).locator('.panel.empty')).toBeVisible();
}

const blockedAt = (id, label, start, end) => ({ id, day: FRI, start, end, label, building: 'W' });
const FLIGHT = blockedAt('flight', 'Flight home', 900, 960);

test.describe('Rule: Blocked time is listed at its own time when no session is planned', () => {
  test('A day with only blocked time: it is listed from 3:00 PM to 4:00 PM under "Nothing planned", after lunch', async ({ page }) => {
    await openPlan(page, [...BLOCKS, FLIGHT]);
    expect(await blockedAtBoot(page, FRI)).toEqual(['Flight home 900-960']);

    await showFriday(page);
    expect(await dayViewHolds(page), 'the message, then the list').toEqual(['nothing planned', 'timeline']);
    expect(await listRows(page), 'lunch at noon, then the blocked time').toEqual([LUNCH, blockedRow('Flight home', '3:00 PM', '4:00 PM')]);
    // The row can be seen, under the message.
    const row = dayView(page).locator('.timeline > .t-item');
    await expect(row).toBeVisible();
    const rowBox = await row.boundingBox(), panelBox = await dayView(page).locator('.panel.empty').boundingBox();
    expect(rowBox.height, 'the row has a height').toBeGreaterThan(20);
    expect(rowBox.y, 'the row is under the message').toBeGreaterThanOrEqual(panelBox.y + panelBox.height - 0.5);
    // The day has no session, so the sessions that fit are still listed open under it: all
    // three of Friday's (10:00, 11:00 and 1:00), none of them during the flight.
    await expect(page.locator('#main details[data-fill]'), 'no folded panel').toHaveCount(0);
    expect(await fits(page)).toEqual(['i-brk501', 'i-brk502', 'i-brk503']);
  });

  test('Blocked time and lunch are listed in time order: 8:00 AM blocked time, lunch, 3:00 PM blocked time', async ({ page }) => {
    // Saved in the other order, so the order in the page is by time and not by how it was saved.
    await openPlan(page, [...BLOCKS, FLIGHT, blockedAt('call', 'Early call', 480, 540)]);
    expect(await blockedAtBoot(page, FRI)).toEqual(['Flight home 900-960', 'Early call 480-540']);

    await showFriday(page);
    expect(await dayViewHolds(page), 'the message, then the list').toEqual(['nothing planned', 'timeline']);
    // Every row, whole. Between the two blocked times the list has what it has between any two
    // rows of a day: the move (one building, walking zeroed), lunch, and the free time.
    expect(await listRows(page), 'blocked time, lunch, blocked time').toEqual([
      blockedRow('Early call', '8:00 AM', '9:00 AM'),
      't-move ok |  | Same room · 360 min break',
      LUNCH,
      't-free |  | Free 9:00 AM–3:00 PM What fits?',
      blockedRow('Flight home', '3:00 PM', '4:00 PM'),
    ]);
    for (const row of await dayView(page).locator('.timeline > .t-item').all()) await expect(row).toBeVisible();
  });

  test('A day with no blocked time: "Nothing planned" and no row is listed under it', async ({ page }) => {
    await openPlan(page);
    expect(await blockedAtBoot(page, FRI), 'Friday has no blocked time').toEqual([]);

    await showFriday(page);
    // Nothing is in the day's plan, so no lunch is placed in it either: the message stands alone.
    expect(await dayViewHolds(page), 'the message and no list').toEqual(['nothing planned']);
    await expect(page.locator('#main .timeline, #main .t-item, #main .t-lunch'), 'no row anywhere on the page').toHaveCount(0);
    await expect(page.locator('#main details[data-fill]'), 'no folded panel').toHaveCount(0);
    expect(await fits(page)).toEqual(['i-brk501', 'i-brk502', 'i-brk503']);
  });
});
