// Pure iCalendar (RFC 5545) building blocks shared by the bulk plan export and the single-
// session quick-add in app.js: escaping, line folding, date formatting, and diffing which
// previously-exported sessions have dropped out of the plan (issue #147).

export function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }

export function icsFold(line) {
  const out = [];
  let cur = '';
  const enc = new TextEncoder();
  for (const ch of line) {
    if (enc.encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function icsDate(iso) { return iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z?$/, 'Z'); }

// Lines for a VEVENT that republishes a previously-exported session as cancelled (RFC 5545
// STATUS:CANCELLED), so a calendar app that already imported it removes the stale entry
// instead of keeping an event for a session that's no longer in the plan. DTSTART/DTEND keep
// the originally-published occurrence; only the status and sequence differ from the publish.
export function cancelledEventLines({ uid, stamp, start, end, summary }) {
  return ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, 'SEQUENCE:1', 'STATUS:CANCELLED',
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape(summary)}`, 'END:VEVENT'];
}

// Which of the previously-exported entries (each { inst, uid, summary, start, end }, as saved
// by the last bulk export) are missing from this export's current session-instance ids, so
// they can be republished as cancelled. Guards against malformed saved state (an older schema,
// a hand-edited backup) rather than trusting it blindly.
export function droppedExports(previouslyExported, currentInsts) {
  const current = new Set(currentInsts);
  return (previouslyExported || []).filter(x => x && typeof x.inst === 'string' && !current.has(x.inst));
}
