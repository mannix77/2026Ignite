// Pure iCalendar building blocks shared by the bulk plan export and the single-session
// quick-add (issue #147). Run with: node tests/ics.test.js
import { icsEscape, icsFold, icsDate, cancelledEventLines, droppedExports } from '../assets/js/ics.js';

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

// ---- icsFold (RFC 5545 §3.1: lines folded at 75 octets, continuation starts with a space)

test('should not fold a short line', () => {
  eq(icsFold('SUMMARY:short'), 'SUMMARY:short');
});
test('should fold a line over 75 octets, continuation lines starting with a space', () => {
  const long = 'SUMMARY:' + 'x'.repeat(90);
  const folded = icsFold(long);
  const parts = folded.split('\r\n');
  eq(parts.length > 1, true, 'expected more than one line');
  for (const p of parts.slice(1)) eq(p[0], ' ', 'continuation line must start with a space');
  eq(parts.join('').replace(/ /g, ''), long.replace(/ /g, ''), 'folding must not drop characters');
});
test('should fold by UTF-8 octet count, not character count, for multi-byte text', () => {
  // Each '€' is 3 UTF-8 bytes; 30 of them is 90 octets, so this must still fold.
  const long = 'SUMMARY:' + '€'.repeat(30);
  const folded = icsFold(long);
  eq(folded.includes('\r\n'), true, 'a 90-octet multi-byte line must fold');
});

// ---- icsDate

test('should turn an ISO timestamp into RFC 5545 UTC basic format', () => {
  eq(icsDate('2026-11-18T18:30:00.000Z'), '20261118T183000Z');
});
test('should add a trailing Z when the input has none', () => {
  eq(icsDate('2026-11-18T18:30:00'), '20261118T183000Z');
});

// ---- cancelledEventLines

test('should publish a cancelled VEVENT with the original id, start and end', () => {
  const lines = cancelledEventLines({ uid: 'u1@x', stamp: '20261112T000000Z', start: '2026-11-18T18:30:00.000Z',
    end: '2026-11-18T19:15:00.000Z', summary: '[BRK1] A talk' });
  eq(lines, ['BEGIN:VEVENT', 'UID:u1@x', 'DTSTAMP:20261112T000000Z', 'SEQUENCE:1', 'STATUS:CANCELLED',
    'DTSTART:20261118T183000Z', 'DTEND:20261118T191500Z', 'SUMMARY:[BRK1] A talk', 'END:VEVENT']);
});
test('should escape the summary in a cancellation the same as a normal event', () => {
  const lines = cancelledEventLines({ uid: 'u1@x', stamp: '20261112T000000Z', start: '2026-11-18T18:30:00.000Z',
    end: '2026-11-18T19:15:00.000Z', summary: 'A, talk; with\nstuff' });
  eq(lines.includes('SUMMARY:A\\, talk\\; with\\nstuff'), true);
});

// ---- droppedExports

const prior = [
  { inst: 'i1', uid: 'i1@x', summary: '[A] One', start: '2026-11-18T18:00:00Z', end: '2026-11-18T18:45:00Z' },
  { inst: 'i2', uid: 'i2@x', summary: '[B] Two', start: '2026-11-18T19:00:00Z', end: '2026-11-18T19:45:00Z' },
];

test('should report a previously-exported instance missing from the current export', () => {
  eq(droppedExports(prior, ['i2']).map(x => x.inst), ['i1']);
});
test('should report nothing dropped when every prior instance is still exported', () => {
  eq(droppedExports(prior, ['i1', 'i2']), []);
});
test('should report nothing dropped when nothing was exported before', () => {
  eq(droppedExports([], ['i1']), []);
  eq(droppedExports(null, ['i1']), []);
});
test('should ignore malformed saved entries rather than throw', () => {
  eq(droppedExports([null, 'junk', 42, { uid: 'no-inst' }, prior[0]], ['nothing-current']).map(x => x.inst), ['i1']);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
