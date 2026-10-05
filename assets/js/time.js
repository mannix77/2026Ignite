// Conference-local time helpers. Everything in the planner is expressed as
// { day: 'YYYY-MM-DD', min: minutes since local midnight } in the event timezone,
// so the plan reads correctly no matter what timezone the phone is set to.

export const TZ = 'America/Los_Angeles';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function localParts(date) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = value;
  return { day: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

export function fromISO(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : localParts(d);
}

export function nowLocal(sim) {
  if (sim && sim.day && Number.isFinite(sim.min)) return { day: sim.day, min: sim.min };
  return localParts(new Date());
}

// "19:50 - 21:20" -> { start: 1190, end: 1280 } (end may exceed 1440 when it wraps midnight)
export function parseSlot(slot) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(slot || '');
  if (!m) return null;
  const a = +m[1] * 60 + +m[2];
  let b = +m[3] * 60 + +m[4];
  if (b < a) b += 1440;
  return { start: a, end: b };
}

export function fmtTime(min) {
  if (!Number.isFinite(min)) return '';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

export function fmtRange(a, b) {
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}

const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const dayLongFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

function dayDate(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function fmtDay(day, long = false) {
  if (!day) return 'Date TBA';
  return (long ? dayLongFmt : dayFmt).format(dayDate(day));
}

export function addDays(day, n) {
  const d = dayDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function fmtDuration(min) {
  if (!Number.isFinite(min)) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return 'unknown';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Stable 32-bit hash for deterministic preview-mode assignments.
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
