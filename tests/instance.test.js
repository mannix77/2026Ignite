// A colleague's copy of the site (e.g. /gino/) shares the browser storage of the main site,
// so every key it uses carries its name. Run with: node tests/instance.test.js
// The copy's name comes from a meta tag read once when instance.js loads, so this file
// fakes the page of Gino's copy before importing anything.
import { sleep } from './shim.js';

let copyDefault = ''; // the planner-default-conference meta tag the deploy stamps on the copy
globalThis.document = {
  querySelector: sel => (sel === 'meta[name="planner-instance"]' ? { content: ' Gino ' }
    : sel === 'meta[name="planner-default-conference"]' ? { content: copyDefault } : null),
};
const { INSTANCE } = await import('../assets/js/instance.js');
const store = await import('../assets/js/store.js');
const { rememberConference, currentConferenceId } = await import('../assets/js/conferences.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}`);
}
const SAVE = 200; // longer than the store's save delay
const MAIN_SITE_PLAN = 'ignite26.planner.v1:gartner2026';
const mainSitePlan = JSON.stringify({ v: 1, picks: { S1: { p: 3, lock: 'S1', note: 'main site', at: 1 } } });

await test("should read the copy's name from the page", () => {
  eq(INSTANCE, 'gino');
});

await test("should not show the main site's picks in a colleague's copy", () => {
  localStorage.clear();
  localStorage.setItem(MAIN_SITE_PLAN, mainSitePlan);
  store.load('gartner2026');
  eq(store.pick('S1'), null);
});

await test("should leave the main site's picks untouched when a colleague's copy saves", async () => {
  localStorage.clear();
  localStorage.setItem(MAIN_SITE_PLAN, mainSitePlan);
  store.load('gartner2026');
  store.mutatePicks(p => { p.S1 = { p: 0, lock: null, note: '', at: 2 }; });
  await sleep(SAVE);
  eq(localStorage.getItem(MAIN_SITE_PLAN), mainSitePlan);
});

// specs/features/catalog-gaps.feature: "Gino added the reception to his copy … Minesh opens his own copy"
await test("should keep a session added in a colleague's copy out of the main site", async () => {
  localStorage.clear();
  store.load('gartner2026');
  store.setSetting('custom', [{ id: 'c1', title: 'Partner reception', day: '2026-10-20', start: 1140, end: 1260, building: 'Y' }]);
  await sleep(SAVE);
  const copyPlan = JSON.parse(localStorage.getItem('ignite26.planner.v1@gino:gartner2026') || '{}');
  eq([localStorage.getItem(MAIN_SITE_PLAN), copyPlan.prefs?.custom?.[0]?.title], [null, 'Partner reception']);
});

await test("should remember a colleague's conference choice only for that copy", () => {
  localStorage.clear();
  rememberConference('gartner2026');
  eq([localStorage.getItem('ignite26.planner.conference'), localStorage.getItem('ignite26.planner.conference@gino')], [null, 'gartner2026']);
});

// ---- which conference opens: ?conf= in the link, then the saved choice, then the copy's default
function opens({ link = '', saved = null, pageDefault = '' } = {}) {
  localStorage.clear();
  if (saved) rememberConference(saved);
  location.search = link;
  copyDefault = pageDefault;
  return currentConferenceId();
}

await test('should open the conference named in the link over the saved choice', () => {
  eq(opens({ link: '?conf=reinvent2026', saved: 'gartner2026' }), 'reinvent2026');
});

await test('should open the saved choice when the link names no conference', () => {
  eq(opens({ saved: 'gartner2026', pageDefault: 'reinvent2026' }), 'gartner2026');
});

await test('should ignore an unknown conference in the link', () => {
  eq(opens({ link: '?conf=ignite2025', saved: 'gartner2026' }), 'gartner2026');
});

await test('should ignore a link naming a property every object has', () => {
  eq(opens({ link: '?conf=toString', saved: 'gartner2026' }), 'gartner2026');
});

await test("should open the copy's default conference when nothing is saved", () => {
  eq(opens({ pageDefault: 'gartner2026' }), 'gartner2026');
});

await test("should open the copy's default when the saved choice no longer exists", () => {
  eq(opens({ saved: 'ignite2025', pageDefault: 'gartner2026' }), 'gartner2026');
});

await test('should ignore a saved choice naming a property every object has', () => {
  eq(opens({ saved: 'constructor', pageDefault: 'gartner2026' }), 'gartner2026');
});

await test('should open Ignite when the copy has no default and nothing is saved', () => {
  eq(opens(), 'ignite2026');
});
location.search = '';

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
