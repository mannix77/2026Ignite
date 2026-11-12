// Pure iCalendar building blocks shared by the bulk plan export and the single-session
// quick-add (issue #147). Run with: node tests/ics.test.js
import { icsEscape, icsFold, icsDate, cancelledEventLines, nextSeq, cancelSeq, classifyPrevious, buildPlanIcs, buildSingleIcs } from '../assets/js/ics.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ? `${msg}: ` : ''}expected ${B}, got ${A}`);
}

// ---- icsEscape

test('should escape backslash, semicolon, comma and newlines in that order', () => {
  eq(icsEscape('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf');
});
test('should turn a non-string into an empty field, not "undefined" or "null"', () => {
  eq(icsEscape(undefined), '');
  eq(icsEscape(null), '');
});

// ---- icsFold (RFC 5545 §3.1: no physical line over 75 octets, continuation starts with a
// single space that unfolding removes; pinned on both sides of the threshold, per byte count,
// and checked to reproduce the original exactly, not just "the same non-space characters").

const byteLen = s => new TextEncoder().encode(s).length;
// RFC 5545 unfolding: a CRLF immediately followed by a single space is removed (the one space
// that icsFold's own continuation lines add, not an arbitrary run of spaces in the content).
const unfold = folded => folded.replace(/\r\n /g, '');

test('should not fold a line at exactly this implementation\'s 74-octet physical-line limit', () => {
  const exact = 'x'.repeat(74);
  eq(icsFold(exact), exact);
});
test('should fold a line one octet over the limit', () => {
  const over = 'x'.repeat(75);
  const folded = icsFold(over);
  eq(folded.includes('\r\n'), true, 'expected a fold just past the limit');
  eq(byteLen(folded.split('\r\n')[0]), 74, 'the first physical line should use the full limit, not fold early');
  eq(unfold(folded), over, 'unfolding must exactly reproduce the original line');
});
test('should fold a long line into physical lines of at most 75 octets, reproducing the original exactly on unfold', () => {
  const long = 'SUMMARY:' + 'x'.repeat(90);
  const folded = icsFold(long);
  const parts = folded.split('\r\n');
  eq(parts.length > 1, true, 'expected more than one physical line');
  for (const p of parts) eq(byteLen(p) <= 75, true, `physical line exceeds 75 octets: ${byteLen(p)}`);
  for (const p of parts.slice(1)) eq(p[0], ' ', 'continuation line must start with a space');
  eq(unfold(folded), long, 'unfolding must exactly reproduce the original line');
});
test('should fold by UTF-8 octet count, not character count, for multi-byte text, reproducing the original exactly on unfold', () => {
  // Each '€' is 3 UTF-8 bytes; 30 of them is 90 octets, so this must still fold.
  const long = 'SUMMARY:' + '€'.repeat(30);
  const folded = icsFold(long);
  const parts = folded.split('\r\n');
  eq(parts.length > 1, true, 'a 90-octet multi-byte line must fold');
  for (const p of parts) eq(byteLen(p) <= 75, true, `physical line exceeds 75 octets: ${byteLen(p)}`);
  eq(unfold(folded), long, 'unfolding must exactly reproduce the original multi-byte line, not an empty string');
});

// ---- icsDate

test('should turn an ISO timestamp into RFC 5545 UTC basic format', () => {
  eq(icsDate('2026-11-18T18:30:00.000Z'), '20261118T183000Z');
});
test('should add a trailing Z when the input has none', () => {
  eq(icsDate('2026-11-18T18:30:00'), '20261118T183000Z');
});

// ---- cancelledEventLines

test('should publish a cancelled VEVENT with the original id, start, end and given sequence', () => {
  const lines = cancelledEventLines({ uid: 'u1@x', stamp: '20261112T000000Z', start: '2026-11-18T18:30:00.000Z',
    end: '2026-11-18T19:15:00.000Z', summary: '[BRK1] A talk', seq: 1 });
  eq(lines, ['BEGIN:VEVENT', 'UID:u1@x', 'DTSTAMP:20261112T000000Z', 'SEQUENCE:1', 'STATUS:CANCELLED',
    'DTSTART:20261118T183000Z', 'DTEND:20261118T191500Z', 'SUMMARY:[BRK1] A talk', 'END:VEVENT']);
});
test('should escape the summary in a cancellation the same as a normal event', () => {
  const lines = cancelledEventLines({ uid: 'u1@x', stamp: '20261112T000000Z', start: '2026-11-18T18:30:00.000Z',
    end: '2026-11-18T19:15:00.000Z', summary: 'A, talk; with\nstuff', seq: 1 });
  eq(lines.includes('SUMMARY:A\\, talk\\; with\\nstuff'), true);
});

// ---- nextSeq / cancelSeq (RFC 5546 §2.1.4/§2.1.5: SEQUENCE must rise whenever STATUS changes
// or the occurrence (DTSTART/DTEND) changes, and the highest SEQUENCE for a UID wins, so a
// revived or rescheduled session must outrank what a calendar app already saw for its UID)

const occ = { start: '2026-11-18T18:00:00Z', end: '2026-11-18T18:45:00Z' };

test('should publish a brand new session with no prior record at sequence 0 (no explicit SEQUENCE needed)', () => {
  eq(nextSeq(undefined, occ), 0);
});
test('should keep a still-active, unchanged session at its last sequence, not bump it on every export', () => {
  eq(nextSeq({ seq: 3, cancelled: false, ...occ }, occ), 3);
});
test('should raise a revived session\'s sequence past its own cancellation\'s', () => {
  eq(nextSeq({ seq: 1, cancelled: true, ...occ }, occ), 2);
});
test('should raise an active session\'s sequence when its start or end changed since last published', () => {
  eq(nextSeq({ seq: 2, cancelled: false, start: occ.start, end: occ.end }, { start: '2026-11-18T19:00:00Z', end: occ.end }), 3, 'start changed');
  eq(nextSeq({ seq: 2, cancelled: false, start: occ.start, end: occ.end }, { start: occ.start, end: '2026-11-18T19:45:00Z' }), 3, 'end changed');
});
test('should raise a cancellation\'s sequence past the session\'s last published one', () => {
  eq(cancelSeq({ seq: 0 }), 1);
  eq(cancelSeq({ seq: 2, cancelled: false }), 3);
  eq(cancelSeq(undefined), 1);
});

// ---- classifyPrevious

const prior = [
  { inst: 'i1', uid: 'i1@x', summary: '[A] One', start: '2026-11-18T18:00:00Z', end: '2026-11-18T18:45:00Z', seq: 0, cancelled: false },
  { inst: 'i2', uid: 'i2@x', summary: '[B] Two', start: '2026-11-18T19:00:00Z', end: '2026-11-18T19:45:00Z', seq: 1, cancelled: true },
];

test('should classify a previously-active instance missing from the current export as freshly dropped', () => {
  eq(classifyPrevious(prior, ['i2']), { stillCancelled: [], freshlyDropped: [prior[0]] });
});
test('should classify an already-cancelled instance still missing from the current export as still cancelled, not re-dropped', () => {
  eq(classifyPrevious(prior, ['i1']), { stillCancelled: [prior[1]], freshlyDropped: [] });
});
test('should classify nothing when every prior instance is in the current export', () => {
  eq(classifyPrevious(prior, ['i1', 'i2']), { stillCancelled: [], freshlyDropped: [] });
});
test('should classify nothing when nothing was exported before', () => {
  eq(classifyPrevious([], ['i1']), { stillCancelled: [], freshlyDropped: [] });
  eq(classifyPrevious(null, ['i1']), { stillCancelled: [], freshlyDropped: [] });
});
test('should ignore malformed saved entries rather than throw', () => {
  eq(classifyPrevious([null, 'junk', 42, { uid: 'no-inst' }, prior[0]], ['nothing-current']),
    { stillCancelled: [], freshlyDropped: [prior[0]] });
});

// ---- boundary and regression cases for the extracted calendar helpers

test('should preserve empty text and ordinary spaces when escaping', () => {
  eq(icsEscape(''), '');
  eq(icsEscape('  A talk about AI  '), '  A talk about AI  ');
});

test('should keep literal backslash-n distinct from an actual newline', () => {
  eq(icsEscape('literal\\n\nnext'), 'literal\\\\n\\nnext');
});

test('should preserve an empty line and a line at the RFC octet limit', () => {
  eq(icsFold(''), '');
  const line = 'x'.repeat(75);
  const folded = icsFold(line);
  eq(folded.replace(/\r\n /g, ''), line);
  for (const part of folded.split('\r\n')) {
    eq(new TextEncoder().encode(part).length <= 75, true, 'physical line fits RFC 5545');
  }
});

test('should leave a line just below the RFC limit intact', () => {
  const line = 'x'.repeat(74);
  eq(icsFold(line), line);
});

test('should fold a line just beyond the RFC limit without losing text', () => {
  const line = 'x'.repeat(76);
  const folded = icsFold(line);
  eq(folded.includes('\r\n '), true);
  eq(folded.replace(/\r\n /g, ''), line);
  for (const part of folded.split('\r\n')) eq(new TextEncoder().encode(part).length <= 75, true);
});

test('should preserve spaces and whole Unicode characters across repeated folds', () => {
  const line = 'SUMMARY:  ' + 'AI 🧠 café € 漢字  '.repeat(25);
  const parts = icsFold(line).split('\r\n');
  eq(parts.length > 2, true, 'exercise multiple continuation lines');
  eq(parts.join('\r\n').replace(/\r\n /g, ''), line, 'only fold whitespace is removed');
  for (const [i, part] of parts.entries()) {
    eq(new TextEncoder().encode(part).length <= 75, true, `line ${i} byte limit`);
    eq(part.isWellFormed(), true, `line ${i} must not split a surrogate pair`);
    if (i) eq(part[0], ' ', `line ${i} continuation marker`);
  }
});

test('should move a four-byte character to a continuation when it cannot fit', () => {
  const line = 'x'.repeat(73) + '🧠';
  eq(icsFold(line), 'x'.repeat(73) + '\r\n 🧠');
});

test('should format midnight, leap day and fractional seconds without a local timezone', () => {
  eq(icsDate('2028-02-29T00:00:00Z'), '20280229T000000Z');
  eq(icsDate('2026-12-31T23:59:59.123456Z'), '20261231T235959Z');
  eq(icsDate('2026-11-18T18:30:00.5'), '20261118T183000Z');
});

test('should classify active and already-cancelled exports when the current plan is empty', () => {
  eq(classifyPrevious(prior, []), { stillCancelled: [prior[1]], freshlyDropped: [prior[0]] });
});

test('should match exact instance ids rather than uid, prefix or repeat group', () => {
  const repeats = [
    { ...prior[0], inst: 'BRK1', uid: 'first@x' },
    { ...prior[1], inst: 'BRK1-R1', uid: 'repeat@x' },
  ];
  eq(classifyPrevious(repeats, ['BRK1-R1', 'first@x', 'brk1']), { stillCancelled: [], freshlyDropped: [repeats[0]] });
});

test('should keep dropped metadata in publication order without mutating either input', () => {
  const previous = Object.freeze(prior.map(x => Object.freeze({ ...x })));
  const current = Object.freeze(['new-instance', 'new-instance']);
  eq(classifyPrevious(previous, current), { stillCancelled: [prior[1]], freshlyDropped: [prior[0]] });
  eq(previous, prior);
  eq(current, ['new-instance', 'new-instance']);
});

test('should ignore non-string instance ids while retaining valid cancellations', () => {
  eq(classifyPrevious([{ inst: null }, { inst: 1 }, { inst: {} }, { inst: ['i1'] }, prior[0]], []), { stillCancelled: [], freshlyDropped: [prior[0]] });
  eq(classifyPrevious(undefined, []), { stillCancelled: [], freshlyDropped: [] });
});

test('should serialize a dropped session with its original occurrence and escaped summary', () => {
  const previous = [{ inst: 'gone', uid: 'gone@ignite2026.ignite26-planner',
    start: '2026-11-18T18:00:00Z', end: '2026-11-18T18:45:00Z', summary: 'A\\B; C, D\r\nNext' }];
  const { freshlyDropped: [dropped], stillCancelled } = classifyPrevious(previous, ['new']);
  eq(stillCancelled, []);
  eq(cancelledEventLines({ ...dropped, stamp: '20261112T000000Z', seq: cancelSeq(dropped) }), [
    'BEGIN:VEVENT', 'UID:gone@ignite2026.ignite26-planner', 'DTSTAMP:20261112T000000Z',
    'SEQUENCE:1', 'STATUS:CANCELLED', 'DTSTART:20261118T180000Z', 'DTEND:20261118T184500Z',
    'SUMMARY:A\\\\B\\; C\\, D\\nNext', 'END:VEVENT',
  ]);
  eq(previous[0].summary, 'A\\B; C, D\r\nNext', 'saved metadata stays unescaped');
});

// ---- buildPlanIcs / buildSingleIcs: the full export path (app.js keeps only input-gathering
// and the shareOrDownload call, so this is what actually proves the cancellation, revival and
// reschedule logic reach the published text, not just the helpers in isolation)

const item1 = { inst: 'i1', uid: 'i1@x', start: '2026-11-18T18:00:00Z', end: '2026-11-18T18:45:00Z',
  summary: '[A] One', location: 'Room 1', description: 'desc', url: 'https://x/1', alarm: { minutes: 15, description: 'leave now' } };

test('should publish an active session with no SEQUENCE the first time it is exported', () => {
  const { text, exported, cancelledCount } = buildPlanIcs({ calname: 'My plan', stamp: '20261112T000000Z', items: [item1], currentInsts: ['i1'], previous: [] });
  eq(text.includes('SEQUENCE:'), false, 'a brand new session needs no explicit SEQUENCE');
  eq(text.includes('UID:i1@x'), true);
  eq(text.includes('BEGIN:VALARM'), true);
  eq(text.includes('STATUS:CANCELLED'), false);
  eq(exported, [{ inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 0, cancelled: false, source: 'plan' }]);
  eq(cancelledCount, 0);
});

test('should republish a dropped session as cancelled and keep tracking it', () => {
  const previous = [{ ...item1, inst: 'i1', uid: 'i1@x', seq: 0, cancelled: false, source: 'plan' }];
  const { text, exported, cancelledCount } = buildPlanIcs({ calname: 'My plan', stamp: '20261112T000000Z', items: [], currentInsts: [], previous });
  eq(text.includes('STATUS:CANCELLED'), true);
  eq(text.includes('SEQUENCE:1'), true);
  eq(exported, [{ inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 1, cancelled: true, source: 'plan' }]);
  eq(cancelledCount, 1);
});

test('should not re-cancel or re-publish a session already tracked as cancelled', () => {
  const previous = [{ inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 1, cancelled: true, source: 'plan' }];
  const { text, exported, cancelledCount } = buildPlanIcs({ calname: 'My plan', stamp: '20261112T000000Z', items: [], currentInsts: [], previous });
  eq(text.includes('CANCELLED'), false, 'no second cancellation for the same UID');
  eq(exported, previous, 'still tracked, unchanged, in case it returns');
  eq(cancelledCount, 0);
});

test('should revive a cancelled session above its cancellation\'s sequence', () => {
  const previous = [{ inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 1, cancelled: true, source: 'plan' }];
  const { text, exported } = buildPlanIcs({ calname: 'My plan', stamp: '20261112T000000Z', items: [item1], currentInsts: ['i1'], previous });
  eq(text.includes('SEQUENCE:2'), true);
  eq(text.includes('STATUS:CANCELLED'), false);
  eq(exported[0], { inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 2, cancelled: false, source: 'plan' });
});

test('should bump SEQUENCE when an exported, still-active session is rescheduled', () => {
  const previous = [{ inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 0, cancelled: false, source: 'plan' }];
  const moved = { ...item1, start: '2026-11-18T19:00:00Z', end: '2026-11-18T19:45:00Z' };
  const { text, exported } = buildPlanIcs({ calname: 'My plan', stamp: '20261112T000000Z', items: [moved], currentInsts: ['i1'], previous });
  eq(text.includes('SEQUENCE:1'), true);
  eq(text.includes('DTSTART:20261118T190000Z'), true);
  eq(exported[0], { inst: 'i1', uid: 'i1@x', summary: '[A] One', start: moved.start, end: moved.end, seq: 1, cancelled: false, source: 'plan' });
});

test('should not count a session with an unexportable time as dropped (preview, withdrawn, or never had one)', () => {
  // currentInsts is the broader "still picked" set app.js passes even when a session has no
  // exportable time at all (preview, withdrawn, or routed to plan.tba with no day); items (what's
  // actually published) can be narrower without the difference being mistaken for the session
  // leaving the plan.
  const previous = [{ inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 0, cancelled: false, source: 'plan' }];
  const { text, exported, cancelledCount } = buildPlanIcs({ calname: 'My plan', stamp: '20261112T000000Z', items: [], currentInsts: ['i1'], previous });
  eq(text.includes('CANCELLED'), false, 'still picked, just not exportable this round: must not be cancelled');
  eq(exported, previous, 'tracked record is untouched, ready to resume once exportable again');
  eq(cancelledCount, 0);
});

test('should never auto-cancel a manually quick-added session, even when it was never picked at all', () => {
  // A quick-add can be for any session, picked or not, so it's never in currentInsts the way a
  // plan-tracked one would be; classifyPrevious must still never offer it up for cancellation.
  const manual = { inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 0, cancelled: false, source: 'manual' };
  const { text, exported, cancelledCount } = buildPlanIcs({ calname: 'My plan', stamp: '20261112T000000Z', items: [], currentInsts: [], previous: [manual] });
  eq(text.includes('CANCELLED'), false, 'a manual entry is never the bulk export\'s to cancel');
  eq(exported, [manual], 'carried forward exactly as it was');
  eq(cancelledCount, 0);
});

test('should take over a manually quick-added session once it\'s genuinely in the resolved plan', () => {
  const manual = { inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 0, cancelled: false, source: 'manual' };
  const { exported } = buildPlanIcs({ calname: 'My plan', stamp: '20261112T000000Z', items: [item1], currentInsts: ['i1'], previous: [manual] });
  eq(exported[0].source, 'plan', 'now bulk-managed, including future cancellation if it later drops out');
});

test('should build a single-session file with no SEQUENCE the first time, and escape the custom alarm', () => {
  const item = { ...item1, alarm: { minutes: 15, description: 'A, session; starts\nsoon' } };
  const { text, entry } = buildSingleIcs({ calname: 'My plan', stamp: '20261112T000000Z', item, previous: [] });
  eq(text.includes('SEQUENCE:'), false);
  eq(text.includes('DESCRIPTION:A\\, session\\; starts\\nsoon'), true);
  eq(entry, { inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 0, cancelled: false, source: 'manual' });
});

test('should revive a session the bulk export cancelled when quick-added on its own', () => {
  const previous = [{ inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 1, cancelled: true, source: 'plan' }];
  const { text, entry } = buildSingleIcs({ calname: 'My plan', stamp: '20261112T000000Z', item: item1, previous });
  eq(text.includes('SEQUENCE:2'), true);
  eq(entry, { inst: 'i1', uid: 'i1@x', summary: '[A] One', start: item1.start, end: item1.end, seq: 2, cancelled: false, source: 'manual' });
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
