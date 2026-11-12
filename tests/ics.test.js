// Pure iCalendar building blocks shared by the bulk plan export and the single-session
// quick-add (issue #147). Run with: node tests/ics.test.js
import { icsEscape, icsFold, icsDate, cancelledEventLines, reviveSeq, cancelSeq, classifyPrevious } from '../assets/js/ics.js';

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

// ---- reviveSeq / cancelSeq (RFC 5546 §2.1.4/§2.1.5: SEQUENCE must rise whenever STATUS
// changes, and the highest SEQUENCE for a UID wins, so a revived session must outrank its own
// cancellation or a calendar app that applied the cancellation can leave it cancelled)

test('should publish a brand new session with no prior record at sequence 0 (no explicit SEQUENCE needed)', () => {
  eq(reviveSeq(undefined), 0);
});
test('should keep an still-active session at its last sequence, not bump it on every export', () => {
  eq(reviveSeq({ seq: 3, cancelled: false }), 3);
});
test('should raise a revived session\'s sequence past its own cancellation\'s', () => {
  eq(reviveSeq({ seq: 1, cancelled: true }), 2);
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
  const { freshlyDropped, stillCancelled } = classifyPrevious(prior, ['i2']);
  eq(freshlyDropped.map(x => x.inst), ['i1']);
  eq(stillCancelled, []);
});
test('should classify an already-cancelled instance still missing from the current export as still cancelled, not re-dropped', () => {
  const { freshlyDropped, stillCancelled } = classifyPrevious(prior, ['i1']);
  eq(freshlyDropped, []);
  eq(stillCancelled.map(x => x.inst), ['i2']);
});
test('should classify nothing when every prior instance is in the current export', () => {
  eq(classifyPrevious(prior, ['i1', 'i2']), { stillCancelled: [], freshlyDropped: [] });
});
test('should classify nothing when nothing was exported before', () => {
  eq(classifyPrevious([], ['i1']), { stillCancelled: [], freshlyDropped: [] });
  eq(classifyPrevious(null, ['i1']), { stillCancelled: [], freshlyDropped: [] });
});
test('should ignore malformed saved entries rather than throw', () => {
  const { freshlyDropped } = classifyPrevious([null, 'junk', 42, { uid: 'no-inst' }, prior[0]], ['nothing-current']);
  eq(freshlyDropped.map(x => x.inst), ['i1']);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
