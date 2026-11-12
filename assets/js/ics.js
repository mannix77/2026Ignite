// Pure iCalendar (RFC 5545) building blocks and assembly for the bulk plan export and the
// single-session quick-add in app.js: escaping, line folding, date formatting, tracking which
// previously-exported sessions have dropped out of the plan so they can be cancelled, which
// cancelled ones have returned so they supersede their own cancellation, and which active ones
// were rescheduled so their SEQUENCE rises too (issue #147). app.js owns no calendar-assembly
// logic itself: it gathers each session's fields and calls buildPlanIcs/buildSingleIcs, so the
// whole export path (not just these helpers) is unit-testable under Node.

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

function eventLines({ uid, stamp, start, end, summary, location, description, url, seq, alarm, cancelled }) {
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, ...(seq ? [`SEQUENCE:${seq}`] : [])];
  if (cancelled) lines.push('STATUS:CANCELLED');
  lines.push(`DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape(summary)}`);
  if (!cancelled) {
    lines.push(`LOCATION:${icsEscape(location || '')}`, `DESCRIPTION:${icsEscape(description || '')}`);
    if (url) lines.push(`URL:${url}`);
    if (alarm) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(alarm.description)}`, `TRIGGER:-PT${alarm.minutes}M`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

// Lines for a VEVENT that republishes a previously-exported session as cancelled (RFC 5545
// STATUS:CANCELLED), so a calendar app that already imported it removes the stale entry
// instead of keeping an event for a session that's no longer in the plan. DTSTART/DTEND keep
// the originally-published occurrence; only the status and sequence differ from the publish.
export function cancelledEventLines({ uid, stamp, start, end, summary, seq }) {
  return eventLines({ uid, stamp, start, end, summary, seq, cancelled: true });
}

// RFC 5546 §2.1.4/§2.1.5: the highest SEQUENCE seen for a UID obsoletes lower ones, and
// SEQUENCE must rise whenever STATUS changes or the occurrence (DTSTART/DTEND) changes. A
// session republished after being cancelled, or rescheduled while still active, must therefore
// use a SEQUENCE higher than its last tracked one, or a calendar app can keep the stale version.
// `prev` is this UID's last tracked record (undefined the first time it's ever published).
export function nextSeq(prev, { start, end }) {
  if (!prev) return 0;
  const changed = prev.cancelled || prev.start !== start || prev.end !== end;
  return changed ? (prev.seq || 0) + 1 : (prev.seq || 0);
}
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

// Builds the bulk plan .ics text and the tracked-export state for the next export, from
// already-gathered per-session fields:
//   items:        sessions actually being published this round, each
//                 { inst, uid, start, end, summary, location, description, url, alarm }
//   currentInsts: every session instance still in the plan, even ones not in `items` because
//                 their time isn't exportable yet (preview, missing) — broader than `items` on
//                 purpose, so those aren't mistaken for dropped and cancelled
//   previous:     store.icsExported(), the last export's tracked state
function trackedEntry(x, { seq, cancelled }) {
  return { inst: x.inst, uid: x.uid, summary: x.summary, start: x.start, end: x.end, seq, cancelled };
}

export function buildPlanIcs({ calname, stamp, items, currentInsts, previous }) {
  const prevByInst = new Map((previous || []).map(x => [x.inst, x]));
  const { stillCancelled, freshlyDropped } = classifyPrevious(previous, currentInsts);
  const current = new Set(currentInsts);
  const publishedInsts = new Set(items.map(x => x.inst));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ignite26-planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(calname)}`];
  const exported = [];
  for (const it of items) {
    const seq = nextSeq(prevByInst.get(it.inst), it);
    lines.push(...eventLines({ ...it, stamp, seq }));
    exported.push(trackedEntry(it, { seq, cancelled: false }));
  }
  // A session the last export published that isn't in this one (unlocked, re-rated down, or
  // dropped from the catalog entirely) is republished as cancelled, so the calendar app
  // removes it instead of keeping a stale entry around forever. One already cancelled last
  // time stays tracked (in case it returns) but isn't re-published.
  for (const d of freshlyDropped) {
    const seq = cancelSeq(d);
    lines.push(...cancelledEventLines({ ...d, stamp, seq }));
    exported.push(trackedEntry(d, { seq, cancelled: true }));
  }
  for (const d of stillCancelled) exported.push(trackedEntry(d, { seq: d.seq || 0, cancelled: true }));
  // Still in the plan (currentInsts) but not exportable this round (a preview or withdrawn
  // time): neither published nor dropped. Carry its last tracked record forward untouched, so
  // tracking doesn't silently lose it and its sequence stays correct whenever it becomes
  // exportable again.
  for (const p of (previous || [])) {
    if (p && typeof p.inst === 'string' && current.has(p.inst) && !publishedInsts.has(p.inst) && !exported.some(e => e.inst === p.inst)) {
      exported.push(trackedEntry(p, { seq: p.seq || 0, cancelled: !!p.cancelled }));
    }
  }
  lines.push('END:VCALENDAR');
  return { text: lines.map(icsFold).join('\r\n') + '\r\n', exported, cancelledCount: freshlyDropped.length };
}

// Builds a single-session .ics text and its tracked-export entry, from one already-gathered
// item ({ inst, uid, start, end, summary, location, description, url, alarm }) and the bulk
// export's tracked state (read to compute a non-regressing SEQUENCE, same as buildPlanIcs).
export function buildSingleIcs({ calname, stamp, item, previous }) {
  const prev = (previous || []).find(x => x.inst === item.inst);
  const seq = nextSeq(prev, item);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ignite26-planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(calname)}`,
    ...eventLines({ ...item, stamp, seq })];
  lines.push('END:VCALENDAR');
  return { text: lines.map(icsFold).join('\r\n') + '\r\n', entry: trackedEntry(item, { seq, cancelled: false }) };
}
