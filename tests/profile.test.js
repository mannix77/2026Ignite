// Preferences that rank and trim a large catalog (specs/features/rating-preferences.feature).
// Run with: node tests/profile.test.js
import { sleep } from './shim.js';

const { createRanker, partition, sanitizeProfile, blankProfile, profileGroups, profileConfig } = await import('../assets/js/profile.js');
const store = await import('../assets/js/store.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}`);
}

let n = 0;
function session(extra = {}) {
  n++;
  return { id: `s${n}`, key: `s${n}`, group: `G${n}`, code: `BRK${n}`, title: 'A session', desc: '', type: 'Breakout', level: 200,
    topics: [], tags: [], audience: [], speakers: [], ...extra };
}
const profile = patch => ({ ...blankProfile(), offTypes: [], ...patch });
const rank = (p, s, conf = 'ignite2026') => createRanker(p, conf).evaluate(s);

// ---- quick-start answers rank the catalog
await test('should rank a session on a chosen interest above one on another topic', () => {
  const p = profile({ interests: ['Cloud & AI'] });
  eq(rank(p, session({ topics: ['Cloud & AI'] })).score > rank(p, session({ topics: ['Windows'] })).score, true);
});
await test('should explain an interest match', () => {
  eq(rank(profile({ interests: ['Cloud & AI'] }), session({ topics: ['Cloud & AI'] })).why.includes('Interest: Cloud & AI'), true);
});
await test('should rank a session about executive presence above an otherwise equal one', () => {
  const p = profile({ goals: ['leadership'] });
  eq(rank(p, session({ title: 'Executive presence for architects' })).score > rank(p, session({ title: 'Patch management basics' })).score, true);
});
// role-ranking.feature: the whole shortlist order, from sessions modelled on the real catalogs.
// They are listed in reverse code order, so neither the input order nor the code tie-break
// alone gives the expected order.
const shortlistCodes = (p, sessions, conf) =>
  partition(sessions, createRanker(p, conf), { isRated: () => false, size: 100 }).shortlist.map(e => e.s.code);
await test('should rank an Enterprise architect role match first at Gartner', () => {
  const p = profile({ roles: ['Enterprise architect'] });
  const g = (code, title, type, tags, topics) => session({ id: code, code, title, type, tags, topics, level: null });
  const sessions = [
    g('SPS62', 'DXC: From Scaling People to Orchestrating Agents - Transforming Managed Services', // a vendor tag starting with "D", not track D
      'Solution Provider Sessions', ['DXC'], ['Agentic AI', 'AI Operationalization and Governance', 'Cybersecurity and Enterprise Resilience']),
    g('SPS57', "SAP LeanIX: Governing AI at Scale: Inside Dell's Enterprise Architecture", 'Solution Provider Sessions', ['SAP LeanIX'], // topic only
      ['Agentic AI', 'AI Operationalization and Governance', 'Enterprise Architecture and Applications']),
    g('SPS4', 'ThreatLocker: Implementing Zero Trust Controls, A Case Study', 'Solution Provider Sessions', ['ThreatLocker'], // security without track D
      ['Cybersecurity and Enterprise Resilience', 'Operating Models', 'Strategic Planning and Execution']),
    g('SPN4', 'EA Leaders Peer Speed Networking', 'Networking Session', ['Spotlight: Enterprise Architecture'], []), // spotlight only
    g('CXB9', 'CIO Boardroom: Architecting Value in the Agentic AI Era', 'CIO Boardrooms', ['Nutanix'], // a goal keyword, no goal chosen
      ['Agentic AI', 'AI Operationalization and Governance', 'AI Value and Cost Management']),
    g('22e', 'Where Agentic AI Works, Will Soon Work and May Never Work', 'Track Sessions', // AI leader's tracks
      ['A: Agentic AI, Emerging Tech & Operationalization', 'Spotlight: AI Leaders'], ['Agentic AI']),
    g('22b', 'Preparing for the Postquantum Era: A Strategic Roadmap for CIOs', 'Track Sessions', // track D only
      ['D: Cybersecurity, Architecture, and Engineering'], ['Cybersecurity and Enterprise Resilience']),
    g('21c', "Don't Ask If AI Can Do This Job", 'Track Sessions', ['E: Talent, Skills & AI Literacy'], ['Talent and Skills']),
    g('12c', 'Top Data and Analytics Trends 2027', 'Track Sessions', // track H, whose name holds a "D"
      ['H: Data, Analytics & Digital Product Experience'], ['Data and Analytics']),
  ];
  eq(shortlistCodes(p, sessions, 'gartner2026'), ['22b', 'SPN4', 'SPS57', '12c', '21c', '22e', 'CXB9', 'SPS4', 'SPS62']);
});

await test('should rank an architect-audience session first for an Enterprise architect at re:Invent', () => {
  const p = profile({ roles: ['Enterprise architect'] });
  const r = (code, title, type, audience, topics) => session({ id: code, code, title, type, audience, topics, level: 300 });
  const sessions = [
    r('SNR302', "A leader's guide to the AI you haven't seen yet", 'Mainstage',
      ['Business Executive', 'IT Executive'], ['Artificial Intelligence', 'Compute']),
    r('SEC359', 'From static to dynamic - modernizing bidirectional federation', 'Breakout session',
      ['Solution / Systems Architect'], ['Security & Identity']),
    r('MAM220', 'A Unified AWS Data and AI Strategy for SAP Customers', 'Breakout session',
      ['Data Engineer', 'Data Scientist'], ['Artificial Intelligence', 'Migration & Modernization']),
    r('CMP202', 'Amazon EC2: New silicon, new instances, new possibilities', 'Breakout session', // IT / business leader's audiences
      ['Business Executive', 'Developer / Engineer', 'IT Professional / Technical Manager'], ['Compute']),
    r('ANT313', 'Architect your metadata hub with AWS Glue Data Catalog', 'Breakout session', [], ['Analytics']), // a goal keyword, no goal chosen
  ];
  eq(shortlistCodes(p, sessions, 'reinvent2026'), ['SEC359', 'SNR302', 'ANT313', 'CMP202', 'MAM220']);
});

// role-ranking.feature: sessions that rank equal are listed earliest first, then by code.
// Every session here ranks the same for this profile (asserted), so only the tie order decides.
const tied = (...sessions) => {
  const p = profile({ roles: ['Enterprise architect'] });
  eq(new Set(sessions.map(s => rank(p, s).score)).size, 1, 'precondition: the sessions rank equal');
  return shortlistCodes(p, sessions, 'ignite2026');
};
await test('should list the earlier of two equal sessions first, even with the higher code', () => {
  eq(tied(session({ code: 'BRK100', start: '2026-11-18T20:00:00Z' }), session({ code: 'BRK200', start: '2026-11-18T17:00:00Z' })),
    ['BRK200', 'BRK100']);
});
await test('should list equal sessions at the same time by code', () => {
  eq(tied(session({ code: 'BRK300', start: '2026-11-18T17:00:00Z' }), session({ code: 'BRK250', start: '2026-11-18T17:00:00Z' })),
    ['BRK250', 'BRK300']);
});
await test('should list an equal session with no time after one with a time', () => {
  eq(tied(session({ code: 'BRK050' }), session({ code: 'BRK060', start: 'not a time' }), session({ code: 'BRK400', start: '2026-11-21T01:00:00Z' })),
    ['BRK400', 'BRK050', 'BRK060']);
});
await test('should place an equal session that runs twice by its first run', () => {
  // its runs are listed 20:00, 15:00, 22:00: neither the run seen first nor the one seen last is
  // the earliest, and both are after the other session's 18:00
  const run = start => session({ code: 'BRK500', group: 'R', start });
  eq(tied(run('2026-11-18T20:00:00Z'), session({ code: 'BRK450', start: '2026-11-18T18:00:00Z' }), run('2026-11-18T15:00:00Z'), run('2026-11-18T22:00:00Z')),
    ['BRK500', 'BRK450']);
});

// ---- skipping a whole group hides sessions without rating them
await test('should hide a session in a skipped group', () => {
  eq(rank(profile({ groups: { 'topic:Windows': -1 } }), session({ topics: ['Windows'] })).hidden, 'group');
});
await test('should keep a session that a wanted group also matches', () => {
  const p = profile({ groups: { 'topic:Windows': -1, 'topic:Security': 1 } });
  eq(rank(p, session({ topics: ['Windows', 'Security'] })).hidden, null);
});
await test('should list a skipped group again once the choice is cleared', () => {
  store.load('profile-clear-group');
  const windows = session({ topics: ['Windows'] });
  store.setProfileGroup('topic:Windows', -1);
  const skipped = rank(store.profile(), windows).hidden;
  store.setProfileGroup('topic:Windows', 0);
  eq([skipped, rank(store.profile(), windows).hidden], ['group', null]);
});
// rating-preferences.feature: "none … counts as a Skip" and "A session rated Must stays in the plan"
await test('should leave every rating untouched when a group is skipped', () => {
  store.load('profile-skip-keeps-ratings');
  store.mutatePicks(p => { p.WIN1 = { p: 3, lock: null, note: '', at: 1 }; });
  const before = JSON.stringify(store.get().picks);
  store.setProfileGroup('topic:Windows', -1);
  eq(JSON.stringify(store.get().picks), before);
});
await test('should hide a session in a format you do not attend', () => {
  eq(rank(profile({ offTypes: ['Theater'] }), session({ type: 'Theater' })).hidden, 'format');
});
await test("should hide the conference's default formats until you choose your own", () => {
  const prerecorded = session({ type: 'Pre-recorded' });
  eq([rank(blankProfile(), prerecorded).hidden, rank(profile({ offTypes: [] }), prerecorded).hidden], ['format', null]);
});
await test('should hide exam prep by default at re:Invent', () => {
  eq(rank(blankProfile(), session({ type: 'Exam prep' }), 'reinvent2026').hidden, 'format');
});
await test('should hide a session outside the levels you chose', () => {
  eq(rank(profile({ levels: [300, 400] }), session({ level: 100 })).hidden, 'level');
});

// ---- a rating given one by one always wins
await test('should keep a rated session out of the hidden list even in a skipped group', () => {
  const s = session({ topics: ['Windows'] });
  const r = createRanker(profile({ groups: { 'topic:Windows': -1 } }), 'ignite2026');
  const rated = partition([s], r, { isRated: () => true, size: 100 }), unrated = partition([s], r, { isRated: () => false, size: 100 });
  eq([rated.rated.length, rated.hidden.length, unrated.hidden.length], [1, 0, 1]); // the skip applies unless it's rated
});

// ---- only a short list is left to rate
await test('should offer only the shortlist size and park the rest', () => {
  const sessions = Array.from({ length: 600 }, () => session());
  const r = createRanker(profile({}), 'ignite2026');
  const out = partition(sessions, r, { isRated: () => false, size: 100 });
  eq([out.shortlist.length, out.parked.length], [100, 500]);
});
await test('should count one entry per repeat group', () => {
  const a = session(), b = { ...session(), group: a.group };
  eq(partition([a, b], createRanker(profile({}), 'ignite2026'), { isRated: () => false, size: 100 }).shortlist.length, 1);
});

// ---- group choices list the catalog's facets
await test('should list Gartner tracks as a group to rate', () => {
  const groups = profileGroups(profileConfig('gartner2026'), [session({ tags: ['D: Cybersecurity, Architecture, and Engineering'] })]);
  eq(groups.find(g => g.key === 'track').items[0][0], 'D: Cybersecurity, Architecture, and Engineering');
});

// ---- untrusted saved or imported profiles
await test('should drop malformed profile values', () => {
  eq(sanitizeProfile({ roles: ['Enterprise architect', 5], groups: { 'topic:A': 1, 'topic:B': 9 }, size: -4, levels: ['x', 300] }),
    { ...blankProfile(), roles: ['Enterprise architect'], groups: { 'topic:A': 1 }, levels: [300] });
});

// ---- starting preferences come from the shipped profile
await test('should start a fresh device from the shipped profile', () => {
  localStorage.clear();
  store.load('fresh');
  store.seedProfile({ profile: { roles: ['Enterprise architect'] }, version: 'v1' });
  eq(store.profile().roles, ['Enterprise architect']);
});
await test('should keep preferences already saved on the device', async () => {
  localStorage.clear();
  store.load('kept');
  store.updateProfile({ roles: ['Developer / engineer'] });
  await sleep(200);
  store.load('kept');
  store.seedProfile({ profile: { roles: ['Enterprise architect'] }, version: 'v1' });
  eq(store.profile().roles, ['Developer / engineer']);
});
await test('should include preferences in a backup', () => {
  localStorage.clear();
  store.load('backup');
  store.updateProfile({ interests: ['Security'] });
  eq(store.exportData().profile.interests, ['Security']);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
