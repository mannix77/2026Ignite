// Will your picks last? Picks live only in the browser (or installed app) that shows the
// planner, so the app says how they're being kept and nudges people to install it and
// keep a backup before it matters.

// level: installed | protected | at-risk | not-saved
export function storageStatus({ standalone, persisted, saveFailing }) {
  if (saveFailing) return { level: 'not-saved', text: "Changes aren't being saved on this device: storage is full, blocked or in a private window." };
  if (standalone) return { level: 'installed', text: 'Saved in this installed app. It keeps its own storage and the browser won\'t clear it.' };
  if (persisted) return { level: 'protected', text: 'Saved on this device, protected from automatic cleanup.' };
  return { level: 'at-risk', text: 'Saved in this browser tab, which may clear it: Safari does after 7 days without a visit, and a private window loses everything when it closes. Install the app to keep your picks.' };
}

const DAY = 86400000;
export const REMIND_CHANGES = 20;
export const REMIND_DAYS = 7;

const prevDay = day => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// When to suggest saving a backup. at: last backup (ms) or null; changes: pick edits since;
// dismissed: { at, changes } when the reminder was last waved away; today: conference-local
// day. Returns null or { reason: never | changes | age | conference }.
export function backupReminder({ hasPicks, at, changes, dismissed, now, conferenceStart, today }) {
  if (!hasPicks) return null;
  let reason = null;
  if (changes > 0 && conferenceStart && (today === prevDay(conferenceStart) || today === conferenceStart)) reason = 'conference';
  else if (!at && changes > 0) reason = 'never';
  else if (changes >= REMIND_CHANGES) reason = 'changes';
  else if (at && changes > 0 && now - at >= REMIND_DAYS * DAY) reason = 'age';
  if (!reason) return null;
  // A dismissal holds until 20 more changes or a week passes. The conference reminder
  // overrides an earlier dismissal, but "Not now" on the day itself is respected.
  if (dismissed && reason === 'conference') return dismissed.day === today ? null : { reason };
  if (dismissed && changes - dismissed.changes < REMIND_CHANGES && now - dismissed.at < REMIND_DAYS * DAY) return null;
  return { reason };
}

// Calendar days on this device (not 24-hour periods): 11:50 PM yesterday is "yesterday".
export function backupAge(at, now) {
  if (!at) return 'never';
  const midnight = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((midnight(now) - midnight(at)) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}
