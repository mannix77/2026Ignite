// Small rendering helpers shared by the views. Views build HTML strings; every
// interpolated value goes through esc() (or attr()) first.

import { fmtTime, fmtDay, fmtDuration } from './time.js';
import { BUILDING, buildingLabel } from './venue.js';
import { PRIORITY } from './planner.js';

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const attr = esc;

export function icon(name, cls = '') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function bldgChip(loc) {
  const b = loc?.building || 'U';
  const name = (BUILDING[b] || BUILDING.U).name;
  return `<span class="chip bldg" style="--bc: var(--b-${b})" title="${attr(name)}">${esc(buildingLabel(loc))}</span>`;
}

export function rsvpChip(s) {
  if (!s.rsvp) return '';
  const when = typeof s.rsvp === 'string' ? new Date(s.rsvp) : null;
  const t = when && !Number.isNaN(when.getTime())
    ? `RSVP required. Seats are limited; RSVPs open ${when.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PT`
    : 'RSVP required. Seats are limited';
  return `<span class="chip rsvp" title="${attr(t)}">RSVP</span>`;
}

export function recChip(s) {
  if (s.recorded === true) return `<span class="chip rec" title="Will be recorded: you can watch it later">${icon('rec')}Recorded</span>`;
  if (s.recorded === false) return `<span class="chip norec" title="Will not be recorded: in person is your only chance">${icon('norec')}Not recorded</span>`;
  return '';
}

export function prioPill(p) {
  if (p == null) return '';
  return `<span class="pill p-${p}">${PRIORITY[p]}</span>`;
}

export function whenText(s) {
  if (s.onlineOnly) return 'Online / on demand';
  if (!s.day) return 'Date & time TBA';
  return `${fmtDay(s.day)} · ${fmtTime(s.startMin)}–${fmtTime(s.endMin)}`;
}

export function prioControl(id, p, big = false) {
  const opts = [[3, 'Must'], [2, 'Want'], [1, 'Maybe'], [0, 'Skip']];
  return `<div class="prio${big ? ' big' : ''}" role="group" aria-label="Priority">${opts.map(([v, label]) =>
    `<button type="button" class="p-${v}" data-act="prio" data-id="${attr(id)}" data-p="${v}" aria-pressed="${p === v}">${label}</button>`).join('')}</div>`;
}

export function speakersLine(s, max = 3) {
  const sp = s.speakers || [];
  if (!sp.length) return '';
  const names = sp.slice(0, max).map(p => p[1] && p[1] !== 'Microsoft' ? `${p[0]} (${p[1]})` : p[0]);
  return esc(names.join(', ') + (sp.length > max ? ` +${sp.length - max}` : ''));
}

// A session card. opts: { p, isNew, extra (html), compact }
export function sessionCard(s, opts = {}) {
  const p = opts.p ?? null;
  const cls = ['card', 's-card', p != null ? `p-${p}` : '', p === 0 ? 'skipped' : ''].join(' ');
  const timeChip = s.timeSource === 'preview' ? '<span class="chip preview" title="Simulated time/room (preview mode)">Preview</span>' : '';
  return `<article class="${cls}" data-card="${attr(s.id)}">
    <div class="top"><span class="code">${esc(s.code)}</span>·<span>${esc(s.type)}</span>${s.level ? `·<span>${esc(s.level)}</span>` : ''}${s.dur ? `·<span>${fmtDuration(s.dur)}</span>` : ''}
      ${opts.isNew ? '<span class="chip new">New</span>' : ''}${s.repeats?.length ? `<span class="chip" title="Also runs as ${attr(s.repeats.join(', '))}">Repeats</span>` : ''}</div>
    <a class="title" href="#/session/${encodeURIComponent(s.code)}" data-act="open" data-key="${attr(s.key)}">${esc(s.title)}</a>
    <div class="meta">${timeChip}<span>${esc(whenText(s))}</span>${!s.onlineOnly ? `${s.loc.known ? bldgChip(s.loc) : ''}<span class="muted">${esc(s.roomLabel || '')}</span>` : ''}${recChip(s)}${rsvpChip(s)}</div>
    ${!opts.compact && s.speakers?.length ? `<div class="who">${speakersLine(s)}</div>` : ''}
    ${opts.extra || ''}
    ${opts.noActions ? '' : `<div class="actions">${prioControl(s.id, p)}</div>`}
  </article>`;
}

let toastTimer = null;
export function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = esc(msg) + (action ? ` <button type="button">${esc(action.label)}</button>` : '');
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.run(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 3000);
}

// On iPhone, plain downloads are unreliable inside a Home Screen app; the share sheet
// offers "Save to Files" / Calendar instead. Falls back to a normal download.
export async function shareOrDownload(filename, text, type) {
  try {
    const file = new File([text], filename, { type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
  }
  download(filename, text, type);
  return 'downloaded';
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
