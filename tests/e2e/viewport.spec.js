import { test, expect } from '@playwright/test';

const TABS = ['browse', 'triage', 'plan', 'now', 'changes', 'settings'];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#tabs a', { timeout: 10_000 });
});

for (const tab of TABS) {
  test(`the ${tab} tab has no horizontal overflow`, async ({ page, viewport }) => {
    await page.locator(`#tabs a[data-tab="${tab}"]`).click();
    await expect(page.locator(`#tabs a[data-tab="${tab}"]`)).toHaveAttribute('aria-current', 'page');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${tab} overflows its own ${viewport.width}px viewport by ${overflow}px`).toBeLessThanOrEqual(1);
  });
}

test('the bottom tab bar fits six tabs without overlap, each a touch-sized target', async ({ page, viewport }) => {
  const tabs = page.locator('#tabs a');
  await expect(tabs).toHaveCount(6);
  const boxes = [];
  for (const tab of await tabs.all()) {
    const box = await tab.boundingBox();
    expect(box, 'every tab must be laid out, not display:none').not.toBeNull();
    boxes.push(box);
  }
  // Apple's minimum touch target is 44pt, squeezed here by six tabs across a narrow phone.
  for (const [i, box] of boxes.entries()) {
    expect(box.width, `tab ${i} is only ${box.width}px wide`).toBeGreaterThanOrEqual(44);
    expect(box.x, `tab ${i} starts off-screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `tab ${i} right edge exceeds the ${viewport.width}px viewport`).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y, `tab ${i} starts above the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `tab ${i} bottom edge exceeds the ${viewport.height}px viewport`).toBeLessThanOrEqual(viewport.height + 1);
  }
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].x, `tab ${i} overlaps tab ${i - 1}`).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 1);
  }
});

test('a session detail dialog fits the viewport and its close control is reachable', async ({ page, viewport }) => {
  await page.locator('#tabs a[data-tab="browse"]').click();
  const open = page.locator('[data-act="open"]').first();
  await open.waitFor({ state: 'visible', timeout: 10_000 });
  await open.click();
  const dialog = page.locator('dialog#detail');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.x, 'dialog starts left of the viewport').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `dialog is wider (${box.width}px) than the ${viewport.width}px viewport`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y, 'dialog starts above the viewport').toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, `dialog is taller (${box.height}px) than the ${viewport.height}px viewport`).toBeLessThanOrEqual(viewport.height + 1);
  const close = page.locator('dialog#detail .d-close');
  await expect(close).toBeVisible();
  const closeBox = await close.boundingBox();
  expect(closeBox.x, 'close control starts off-screen').toBeGreaterThanOrEqual(0);
  expect(closeBox.x + closeBox.width, 'close control right edge exceeds the viewport').toBeLessThanOrEqual(viewport.width + 1);
  expect(closeBox.y, 'close control starts above the viewport').toBeGreaterThanOrEqual(0);
  expect(closeBox.y + closeBox.height, 'close control bottom edge exceeds the viewport').toBeLessThanOrEqual(viewport.height + 1);
});
