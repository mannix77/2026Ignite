// Sessions like the ones you picked (specs/features/suggestions.feature).
// Run with: node tests/suggest.test.js
import './shim.js';

const { buildSuggester } = await import('../assets/js/suggest.js');
const { buildModel } = await import('../assets/js/data.js');
const { CONFERENCES } = await import('../assets/js/conferences.js');
const { createVenue } = await import('../assets/js/venue.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}`);
}

// A session as the model holds it (data.js buildModel): list fields are arrays, title and
// desc are strings, speakers are [name, company] pairs. Code is the literal id; the key (one
// run) and the group (all runs of it) differ from it and from each other, so a mix-up shows.
const session = (id, extra = {}) => ({ id, key: `${id}-1`, group: `${id}/g`, code: id, title: '', desc: '', type: 'Breakout',
  tags: [], topics: [], audience: [], speakers: [], vendors: [], ...extra });

// Unrelated sessions so that words used once in the catalog carry weight (idf > 0).
const fillers = ['Harbor', 'Meadow', 'Glacier', 'Canyon', 'Prairie', 'Lagoon', 'Tundra', 'Orchard']
  .map((w, i) => session(`FIL${i + 1}`, { title: `${w} walk`, type: 'Keynote' }));

// Two picks that share nothing with each other. Candidates are 'Theater' sessions, a format
// neither pick has, so each one matches the picks on exactly the feature it is built for.
const ops = session('BRK101', { title: 'Terraform fleet operations', tags: ['Cloud'], topics: ['Security'],
  speakers: [['Ada Lovelace', 'Contoso']], vendors: ['Contoso'] });
const quantum = session('BRK102', { title: 'Quantum chemistry primer', tags: ['Science'], topics: ['Research'] });
const cand = (id, extra) => session(id, { type: 'Theater', ...extra });
const bySpeaker = cand('THR201', { title: 'Gardening tips', speakers: [['Ada Lovelace', 'Fabrikam']] });
const byTrack = cand('THR202', { title: 'Pottery basics', tags: ['Cloud'] });
const byTopic = cand('THR203', { title: 'Knitting circle', topics: ['Security'] });
const byVendor = cand('THR204', { title: 'Origami hour', vendors: ['Contoso'] });
const byWords = cand('THR205', { title: 'Terraform fleet upgrades' });
const byMany = cand('THR207', { title: 'Mountain drills', tags: ['Cloud'], topics: ['Security'], speakers: [['Ada Lovelace', 'Contoso']] });
const unrelated = cand('THR299', { title: 'Watercolour sketching', tags: ['Arts'], topics: ['Hobbies'],
  speakers: [['Grace Hopper', 'Northwind']], vendors: ['Northwind'] });
const catalog = [ops, quantum, bySpeaker, byTrack, byTopic, byVendor, byWords, byMany, unrelated, ...fillers];
const NOTHING = { score: 0, reasons: [] };
const NOT_READY = { score: 0, reasons: [], fit: false };

// ---- suggestions start once two sessions are picked
await test('should not suggest anything from a single pick', () => {
  const sg = buildSuggester(catalog, [{ s: ops, w: 3 }]);
  eq(sg.ready, false);
  eq(sg.score(bySpeaker), NOT_READY);
});
await test('should start suggesting at two picks', () => {
  const sg = buildSuggester(catalog, [{ s: ops, w: 3 }, { s: quantum, w: 3 }]);
  eq(sg.ready, true);
  eq(sg.score(bySpeaker), { score: 23, reasons: ['Speaker you picked elsewhere: Ada Lovelace'] });
});
await test('should suggest nothing, without throwing, with no picks', () => {
  for (const sessions of [catalog, []]) {
    const sg = buildSuggester(sessions, []);
    eq(sg.ready, false);
    eq(sg.score(bySpeaker), NOT_READY);
    eq(sg.picked('BRK101/g'), false);
  }
});

// ---- a session that shares something with a pick ranks above an unrelated one
const liked = () => buildSuggester(catalog, [{ s: ops, w: 3 }, { s: quantum, w: 3 }]);
await test('should leave a session that shares nothing with the picks unscored', () => {
  eq(liked().score(unrelated), NOTHING);
});
await test('should suggest a session by a speaker of a pick', () => {
  eq(liked().score(bySpeaker), { score: 23, reasons: ['Speaker you picked elsewhere: Ada Lovelace'] });
});
await test('should suggest a session on the track of a pick', () => {
  eq(liked().score(byTrack), { score: 8, reasons: ['Track you favor: Cloud (50% of your picks)'] });
});
await test('should suggest a session on the topic of a pick', () => {
  eq(liked().score(byTopic), { score: 6, reasons: ['Topic you favor: Security (50% of your picks)'] });
});
await test('should suggest a session with a vendor of a pick', () => {
  eq(liked().score(byVendor), { score: 17, reasons: ['Vendor in your picks: Contoso'] });
});
await test('should suggest a session worded like a pick', () => {
  eq(liked().score(byWords), { score: 19, reasons: ['Wording like your picks: terraform, fleet'] });
});
await test('should rank sessions by how much they share with the picks, unrelated last', () => {
  const sg = liked();
  const order = [unrelated, byTopic, byTrack, byWords, byVendor, bySpeaker, byMany]
    .map(s => [s.code, sg.score(s).score]).sort((a, b) => b[1] - a[1]);
  eq(order, [['THR207', 37], ['THR201', 23], ['THR205', 19], ['THR204', 17], ['THR202', 8], ['THR203', 6], ['THR299', 0]]);
});

// ---- a pick Minesh wants more pulls harder
await test('should let the more wanted pick pull harder, whichever it is', () => {
  const sci = cand('THR206', { title: 'Lab safety', tags: ['Science'] });
  const all = [...catalog, sci];
  const cloudMore = buildSuggester(all, [{ s: ops, w: 3 }, { s: quantum, w: 1 }]);
  eq([cloudMore.score(byTrack), cloudMore.score(sci)], [
    { score: 12, reasons: ['Track you favor: Cloud (75% of your picks)'] },
    { score: 4, reasons: ['Track you favor: Science (25% of your picks)'] },
  ]);
  const scienceMore = buildSuggester(all, [{ s: ops, w: 1 }, { s: quantum, w: 3 }]);
  eq([scienceMore.score(byTrack), scienceMore.score(sci)], [
    { score: 4, reasons: ['Track you favor: Cloud (25% of your picks)'] },
    { score: 12, reasons: ['Track you favor: Science (75% of your picks)'] },
  ]);
});
// The speaker and vendor terms add half a pick's share as a bonus and stop at 1, so they only
// show the weight when the pick that brings them is outweighed: at 1:3 its share is 25%.
await test('should let a speaker or vendor pull less when its pick is outweighed', () => {
  const opsLess = buildSuggester(catalog, [{ s: ops, w: 1 }, { s: quantum, w: 3 }]);
  const even = liked();
  eq([opsLess.score(bySpeaker), even.score(bySpeaker)], [
    { score: 17, reasons: ['Speaker you picked elsewhere: Ada Lovelace'] },
    { score: 23, reasons: ['Speaker you picked elsewhere: Ada Lovelace'] },
  ]);
  eq([opsLess.score(byVendor), even.score(byVendor)], [
    { score: 13, reasons: ['Vendor in your picks: Contoso'] },
    { score: 17, reasons: ['Vendor in your picks: Contoso'] },
  ]);
});

// ---- the reasons shown are the three strongest, strongest first
await test('should list every reason of a session that shares three things, strongest first', () => {
  eq(liked().score(byMany), { score: 37, reasons: [
    'Speaker you picked elsewhere: Ada Lovelace',
    'Track you favor: Cloud (50% of your picks)',
    'Topic you favor: Security (50% of your picks)',
  ] });
});
await test('should drop the weakest of four reasons', () => {
  // track at 75% and topic at 25% of the picks; speaker and vendor count as 100%
  const byFour = cand('THR208', { title: 'Origami drills', tags: ['Cloud'], topics: ['Research'],
    speakers: [['Ada Lovelace', 'Contoso']], vendors: ['Contoso'] });
  const sg = buildSuggester([...catalog, byFour], [{ s: ops, w: 3 }, { s: quantum, w: 1 }]);
  eq(sg.score(byFour), { score: 56, reasons: [
    'Speaker you picked elsewhere: Ada Lovelace',
    'Vendor in your picks: Contoso',
    'Track you favor: Cloud (75% of your picks)',
  ] });
});

// ---- wording counts only above a small similarity (cos > 0.08)
// One word shared with a pick ("Terraform"), diluted by words used nowhere else: with six of
// them the session is just above the cut-off, with seven just below it.
const diluted = n => cand(`THR29${n}`, { title: `Terraform ${['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'ginkgo'].slice(0, n).join(' ')}` });
await test('should count wording just above the cut-off and not just below it', () => {
  // each in its own catalog, so both see the same word counts
  const scored = s => buildSuggester([...catalog, s], [{ s: ops, w: 3 }, { s: quantum, w: 3 }]).score(s);
  eq([scored(diluted(6)), scored(diluted(7))], [{ score: 5, reasons: ['Wording like your picks: terraform'] }, NOTHING]);
});

// ---- only the sessions Minesh wants shape the suggestions
// app.js drops Skip-rated picks before calling the suggester; a pick that still arrives with
// no weight must not attract on its track, topic, program, format or wording.
const patch = session('BRK103', { title: 'Patch rollout cadence', type: 'Lab', tags: ['Windows'], topics: ['Devices'], audience: ['Partner'] });
const likePatch = [
  cand('THR311', { title: 'Choir practice', tags: ['Windows'] }),
  cand('THR312', { title: 'Chess openings', topics: ['Devices'] }),
  cand('THR313', { title: 'Bread baking', audience: ['Partner'] }),
  session('LAB314', { title: 'Kite flying', type: 'Lab' }),
  cand('THR315', { title: 'Patch rollout cadence review' }),
];
const withPatch = w => buildSuggester([...catalog, patch, ...likePatch], [{ s: ops, w: 3 }, { s: quantum, w: 3 }, { s: patch, w }]);
await test('should not let a pick with no weight attract on its track, topic, program, format or wording', () => {
  eq(likePatch.map(s => withPatch(0).score(s)), likePatch.map(() => NOTHING));
  // ...while the same pick with a little weight attracts on each of them
  eq(likePatch.map(s => withPatch(1).score(s)), [
    { score: 2, reasons: ['Track you favor: Windows (14% of your picks)'] },
    { score: 2, reasons: ['Topic you favor: Devices (14% of your picks)'] },
    { score: 1, reasons: ['Program: Partner (14% of your picks)'] },
    { score: 1, reasons: ['Format you favor: Lab (14% of your picks)'] },
    { score: 9, reasons: ['Wording like your picks: patch, rollout, cadence'] },
  ]);
});
// picked() is part of buildSuggester's result. app.js does not call it: the Suggested list
// leaves out rated sessions itself (prioOf in suggestions() and the browse filter), untested.
await test('should know which sessions are picked and which are not', () => {
  const sg = liked();
  eq([sg.picked('BRK101/g'), sg.picked('BRK102/g'), sg.picked('THR201/g'), sg.picked('FIL1/g')], [true, true, false, false]);
});

// ---- damaged catalog records are skipped, never fatal
await test('should score every session of a catalog with malformed records', () => {
  const ignite = CONFERENCES.ignite2026;
  const doc = { sessions: [
    null, 'junk', 42, { title: 'No id at all' },
    { id: 'J1', title: 42, desc: { text: 'x' }, type: 7, tags: 5, topics: { a: 1 }, audience: 'Partner', speakers: 'Ada Lovelace', vendors: [null, '', 7] },
    { id: 'J2', type: null, speakers: [[], [null, 'Org'], 'x', [42, 'Org']], vendors: 'Contoso' },
    { id: 'J3' },
    { ...ops, speakers: [...ops.speakers, [], [null, 'Org']] },
    { ...quantum, type: undefined },
    bySpeaker, unrelated, ...fillers,
  ] };
  const model = buildModel(doc, { overrides: {} }, null, ignite, createVenue(ignite.venue));
  const ids = model.sessions.map(s => s.id);
  // the odd records with an id are in the model, the ones without are dropped, the good ones all kept
  eq(ids, ['J1', 'J2', 'J3', 'BRK101', 'BRK102', 'THR201', 'THR299', ...fillers.map(s => s.id)]);
  const byId = id => model.sessions.find(s => s.id === id);
  const sg = buildSuggester(model.sessions, [{ s: byId('BRK101'), w: 3 }, { s: byId('BRK102'), w: 0.5 }]);
  const bad = model.sessions.map(s => [s.id, sg.score(s)])
    .filter(([, r]) => !(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100 && Array.isArray(r.reasons) && r.reasons.every(x => typeof x === 'string')));
  eq(bad, []);
  eq(sg.score(byId('THR201')), { score: 23, reasons: ['Speaker you picked elsewhere: Ada Lovelace'] });
  // J2's vendor came as a bare string, which the model reads as a one-item list
  eq(['J1', 'J2', 'J3'].map(id => sg.score(byId(id))), [NOTHING, { score: 17, reasons: ['Vendor in your picks: Contoso'] }, NOTHING]);
});
await test('should skip list fields missing from a session', () => {
  const bare = (id, title) => ({ id, key: `${id}-1`, group: `${id}/g`, code: id, title, desc: '' });
  const barePick = bare('BAR401', 'Lonely heron'), bareCand = bare('BAR402', 'Silent marsh');
  const sg = buildSuggester([...catalog, barePick, bareCand], [{ s: ops, w: 3 }, { s: barePick, w: 3 }]);
  eq(sg.ready, true);
  eq(sg.score(bareCand), NOTHING);
  eq(sg.score(bySpeaker), { score: 23, reasons: ['Speaker you picked elsewhere: Ada Lovelace'] });
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
