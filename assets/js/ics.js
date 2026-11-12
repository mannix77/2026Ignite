// Pure iCalendar (RFC 5545) building blocks shared by the bulk plan export and the single-
// session quick-add in app.js: escaping, line folding, date formatting, and tracking which
// previously-exported sessions have dropped out of the plan so they can be cancelled, and
// which cancelled ones have returned so they supersede their own cancellation (issue #147).

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
export function cancelledEventLines({ uid, stamp, start, end, summary, seq }) {
  return ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `SEQUENCE:${seq}`, 'STATUS:CANCELLED',
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape(summary)}`, 'END:VEVENT'];
}

// RFC 5545 §2.1.4/§2.1.5 (via RFC 5546): the highest SEQUENCE seen for a UID obsoletes lower
// ones, and SEQUENCE must increase whenever STATUS changes. A session republished after being
// cancelled must therefore use a SEQUENCE higher than its cancellation's, or a calendar app
// that already applied the cancellation can ignore the "revival" and leave it cancelled.
// `prev` is this UID's last tracked record (undefined the first time it's ever published).
export function reviveSeq(prev) { return prev?.cancelled ? (prev.seq || 0) + 1 : (prev?.seq || 0); }
export function cancelSeq(prev) { return (prev?.seq || 0) + 1; }

// Classifies the previously-exported entries (each { inst, uid, summary, start, end, seq,
// cancelled }, as saved by the last bulk export) against this export's current session-
// instance ids:
//  - stillCancelled: already published as cancelled last time, still not in the plan — nothing
//    to re-publish, just keep tracking it in case it returns.
//  - freshlyDropped: was active last time, isn't in the plan now — publish as cancelled.
// (A currently-active instance isn't returned here; look it up directly by inst to revive it.)
export function classifyPrevious(previouslyExported, currentInsts) {
  const current = new Set(currentInsts);
  const usable = (previouslyExported || []).filter(x => x && typeof x.inst === 'string' && !current.has(x.inst));
  return { stillCancelled: usable.filter(x => x.cancelled), freshlyDropped: usable.filter(x => !x.cancelled) };
}
