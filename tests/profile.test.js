// Preferences that rank and trim a large catalog (specs/features/rating-preferences.feature).
// Run with: node tests/profile.test.js
import { sleep } from './shim.js';

const { createRanker, partition, sanitizeProfile, blankProfile, profileGroups, profileConfig } = await import('../assets/js/profile.js');
const store = await import('../assets/js/store.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ? `${msg}: ` : ''}expected ${B}, got ${A}`);
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

// ---- a link that sets Triage preferences (specs/features/preferences-link.feature)
const { parsePrefsLink, applyPrefs, prefsSummary, prefsLinkFrom, prefsLinkTarget } = await import('../assets/js/profile.js');
const igniteCfg = profileConfig('ignite2026');
const linkCatalog = [
  session({ topics: ['AI'], type: 'Breakout', level: 200 }),
  session({ topics: ['Security'], type: 'Pre-recorded', level: 300 }),
  session({ topics: ['AI'], type: 'Lab', level: 400, tags: ['Copilot'] }),
];
const parseLink = str => parsePrefsLink(str, { cfg: igniteCfg, sessions: linkCatalog });

await test('should read every preference a link can carry', () => {
  const r = parseLink('role=Enterprise%20architect&interest=AI&goal=ai&goal=security&level=200&level=400&hide=Pre-recorded&want=topic:AI&skip=type:Lab&size=150');
  eq(r.set, { roles: ['Enterprise architect'], interests: ['AI'], goals: ['ai', 'security'], levels: [200, 400], offTypes: ['Pre-recorded'], size: 150 });
  eq(r.groups, { 'topic:AI': 1, 'type:Lab': -1 });
  eq(r.ignored, []);
});
await test('should leave out values the conference does not have, and name each one', () => {
  const r = parseLink('role=Astronaut&goal=ai&goal=flying&interest=Gardening&level=250&hide=Opera&want=topic:Gardening&skip=colour:red&size=9&mood=happy');
  eq(r.set, { goals: ['ai'] });
  eq(r.groups, {});
  eq(r.ignored, ['role: Astronaut', 'goal: flying', 'interest: Gardening', 'level: 250', 'hide: Opera', 'want: topic:Gardening', 'skip: colour:red', 'size: 9', 'mood: happy']);
});
await test('should leave out a level at a conference without levels, and keep it at one with them', () => {
  const gartnerCfg = profileConfig('gartner2026');
  eq(parsePrefsLink('level=200', { cfg: gartnerCfg, sessions: linkCatalog }).ignored, ['level: 200']);
  eq(parseLink('level=200').set, { levels: [200] });
});
await test('should read a + or an encoded space as a space, and a later want or skip of the same group wins', () => {
  const r = parseLink('role=Enterprise+architect&want=type:Lab&skip=type:Lab');
  eq([r.set.roles, r.groups], [['Enterprise architect'], { 'type:Lab': -1 }]);
});
await test('should accept a shortlist size from 25 to 2000 and refuse one just outside', () => {
  eq(['24', '25', '2000', '2001'].map(n => parseLink(`size=${n}`).set.size ?? null), [null, 25, 2000, null]);
  eq(parseLink('size=24&size=2001').ignored, ['size: 24', 'size: 2001']);
});
await test('should take the conference and the preferences from pasted text', () => {
  eq(prefsLinkFrom('https://mannix77.github.io/2026Ignite/?conf=gartner2026#/prefs/goal=ai&skip=type:Roundtables'), { conf: 'gartner2026', query: 'goal=ai&skip=type:Roundtables' });
  eq(prefsLinkFrom('  #/prefs/goal=ai '), { conf: null, query: 'goal=ai' }, 'no conference named: the one being planned');
  eq(prefsLinkFrom('https://x.test/?data=a#/prefs/goal=ai'), { conf: null, query: 'goal=ai' });
  eq([prefsLinkFrom('https://x.test/?conf=ignite2026#/import/K1.3'), prefsLinkFrom(''), prefsLinkFrom('goal=ai')], [null, null, null], 'not a preferences link');
});
await test('should read nothing from an empty or malformed link', () => {
  for (const s of ['', '&&', '=', 'role=']) eq(parseLink(s), { set: {}, groups: {}, ignored: s === 'role=' ? ['role: (empty)'] : [] });
});

await test('should replace the fields a link names and add its group choices to the ones already there', () => {
  const before = profile({ goals: ['architecture', 'strategy'], interests: ['Security'], groups: { 'topic:AI': 1 } });
  const after = applyPrefs(before, parseLink('goal=ai&skip=type:Pre-recorded'));
  eq([after.goals, after.interests, after.groups], [['ai'], ['Security'], { 'topic:AI': 1, 'type:Pre-recorded': -1 }]);
});
await test('should hide a skipped group without rating any of its sessions', () => {
  store.load('profile-prefs-link-no-ratings');
  store.mutatePicks(p => { p.BRK1 = { p: 3, lock: null, note: '', at: 1 }; });
  const before = JSON.stringify(store.get().picks);
  const after = applyPrefs(profile({}), parseLink('skip=type:Lab'));
  store.updateProfile(after);
  const saved = store.profile();   // what was kept, not the value handed in
  eq(saved.groups, { 'type:Lab': -1 }, 'the skipped group is stored');
  const lab = linkCatalog[2];
  eq(createRanker(saved, 'ignite2026').evaluate(lab).hidden, 'group');
  eq(createRanker(saved, 'ignite2026').evaluate(linkCatalog[0]).hidden, null, 'another type is not hidden');
  eq(JSON.stringify(store.get().picks), before, 'applying the link writes no ratings');
});
await test('should say which conference a pasted preferences link is for, when it names a different one', () => {
  const gartnerLink = `https://mannix77.github.io/2026Ignite/?conf=gartner2026#/prefs/goal=ai`;
  eq(prefsLinkTarget(gartnerLink, 'ignite2026', CONFERENCES), { apply: false, name: CONFERENCES.gartner2026.name });
  eq(prefsLinkTarget(`https://x.test/?conf=madeupconf#/prefs/goal=ai`, 'ignite2026', CONFERENCES), { apply: false, name: 'madeupconf' }, 'falls back to the raw id when unknown');
});
// A link copied from a chat or an email comes with words around it (#126 review).
await test('should find the conference a link names when it is pasted inside a message', () => {
  const link = 'https://mannix77.github.io/2026Ignite/?conf=gartner2026#/prefs/goal=ai';
  for (const text of [`Here is your link: ${link}`, `Here is your link: ${link} — thanks`, `(${link})`, `Link:\n${link}`]) {
    eq(prefsLinkFrom(text)?.conf, 'gartner2026', JSON.stringify(text));
    eq(prefsLinkTarget(text, 'ignite2026', CONFERENCES), { apply: false, name: CONFERENCES.gartner2026.name }, JSON.stringify(text));
  }
  eq(prefsLinkTarget('Here: https://x.test/?conf=ignite2026#/prefs/goal=ai', 'ignite2026', CONFERENCES), { apply: true, query: 'goal=ai' }, 'the open conference, in a message');
  eq(prefsLinkTarget('Here: https://x.test/?conf=ignite2026#/prefs/goal=ai — thanks', 'ignite2026', CONFERENCES), { apply: true, query: 'goal=ai' }, 'words after the link are not part of it');
  eq(prefsLinkFrom('Here: https://x.test/?data=a#/prefs/goal=ai'), { conf: null, query: 'goal=ai' }, 'a link in a message that names no conference');
});
await test('should apply a link naming no conference, or the one open; and pass through what is not a preferences link', () => {
  eq(prefsLinkTarget('#/prefs/goal=ai', 'ignite2026', CONFERENCES), { apply: true, query: 'goal=ai' });
  eq(prefsLinkTarget(`https://x.test/?conf=ignite2026#/prefs/goal=ai`, 'ignite2026', CONFERENCES), { apply: true, query: 'goal=ai' });
  eq(prefsLinkTarget(`https://x.test/?conf=ignite2026#/import/K1.3`, 'ignite2026', CONFERENCES), null, 'not a preferences link');
});
await test('should describe what the link sets and what it leaves out, for the confirmation', () => {
  const lines = prefsSummary(parseLink('role=Astronaut&goal=ai&level=200&hide=Pre-recorded&want=topic:AI&skip=type:Lab'));
  eq(lines, ['Goals: AI & agents', 'Levels: 200', 'Hide formats: Pre-recorded', 'Want all: topic AI', 'Skip all: type Lab', 'Left out (not in this conference): role: Astronaut']);
  eq(prefsSummary(parseLink('mood=happy')), ['Nothing this conference knows', 'Left out (not in this conference): mood: happy']);
});

await test("should read the guide's worked preferences example against the committed Gartner catalog with nothing left out", async () => {
  const { readFileSync } = await import('node:fs');
  const guide = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
  const link = guide.split('\n').find(l => l.includes('?conf=gartner2026#/prefs/'));
  eq(!!link, true);
  const catalog = JSON.parse(readFileSync(new URL('../data/gartner2026/sessions.json', import.meta.url), 'utf8')).sessions;
  const r = parsePrefsLink(link.split('#/prefs/')[1], { cfg: profileConfig('gartner2026'), sessions: catalog });
  eq(r.ignored, []);
  eq([r.set, r.groups], [{ roles: ['Enterprise architect'], interests: ['Agentic AI'], goals: ['architecture'] }, { 'type:Solution Provider Sessions': -1, 'type:Roundtables': -1 }]);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
