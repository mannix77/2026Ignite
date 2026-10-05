// Venue model: turn a catalog location string into a building/floor, and estimate
// door-to-door walking minutes between two locations.
//
// Published locations look like (Ignite 2025, same venue):
//   "Moscone West, Level 3, Room 3016"     "Moscone South, The Hub, Theater A"
//   "Moscone South, Level 3, Room 301"     "Marriott Marquis, Yerba Buena Ballroom, BO2"
//   "Chase Center" (keynote)

export const BUILDINGS = [
  { id: 'W', name: 'Moscone West', short: 'West', re: /moscone\s*west|^west\b/i },
  { id: 'S', name: 'Moscone South', short: 'South', re: /moscone\s*south|^south\b|esplanade/i },
  { id: 'N', name: 'Moscone North', short: 'North', re: /moscone\s*north|^north\b/i },
  { id: 'M', name: 'Marriott Marquis', short: 'Marriott', re: /marriott|marquis/i },
  { id: 'C', name: 'Chase Center', short: 'Chase Ctr', re: /chase\s*center/i },
  { id: 'H', name: 'Other off-site', short: 'Off-site', re: /intercontinental|hilton|hyatt|westin|park central|four seasons|st\.? regis|yerba buena (center|gardens)|metreon|sfmoma|\bw hotel/i },
  { id: 'O', name: 'Online only', short: 'Online', re: /^(online|virtual|on[- ]demand$)/i },
];

export const BUILDING = Object.fromEntries(BUILDINGS.map(b => [b.id, b]));
BUILDING.U = { id: 'U', name: 'Location TBA', short: 'TBA' };

// Door-to-door minutes at a changeover, including the badge/ID/bag check Ignite 2025 ran at
// every building entrance and the crowds on 4th St / Howard St (typical, not worst case:
// add ~50% right after a keynote). Derived from floor plans, walking routes and the 2025
// schedule. All editable in Settings.
export const DEFAULT_WALK = {
  sameRoom: 0,
  sameFloor: 3,
  diffFloor: 5,     // e.g. South Hub (exhibit level) <-> South Level 3
  pairs: {
    'N|S': 7, 'N|W': 10, 'S|W': 12,
    'M|W': 13, 'M|S': 14, 'M|N': 13,
    'C|W': 40, 'C|S': 40, 'C|N': 40, 'C|M': 40,
    'H|W': 12, 'H|S': 12, 'H|N': 12, 'H|M': 12, 'C|H': 40, 'H|H': 12,
  },
  unknown: 12,      // room not published yet: assume a building change
};

export const PAIR_KEYS = Object.keys(DEFAULT_WALK.pairs);

export function parseLocation(label, overrides = {}) {
  const raw = (label || '').trim();
  if (!raw || /^ztest/i.test(raw) || /^(tbd|tba)$/i.test(raw)) {
    return { label: raw, building: 'U', floor: null, known: false };
  }
  let building = overrides[raw] || null;
  if (!building) {
    for (const b of BUILDINGS) {
      if (b.re.test(raw)) { building = b.id; break; }
    }
  }
  let floor = null;
  const lv = /(?:level|lvl|floor)\s*(\d)/i.exec(raw);
  if (lv) floor = lv[1];
  else if (/the hub|expo|exhibit/i.test(raw)) floor = 'Hub';
  else {
    const room = /(?:room|rm\.?)\s*(\d{3,4})/i.exec(raw);
    if (room) floor = room[1][0];
  }
  return { label: raw, building: building || 'U', floor, known: !!building && building !== 'U' };
}

export function walkMinutes(a, b, walk = DEFAULT_WALK) {
  if (!a || !b) return walk.unknown;
  if (a.building === 'O' || b.building === 'O') return 0;
  if (a.label && a.label === b.label) return walk.sameRoom;
  if (!a.known || !b.known) return walk.unknown;
  if (a.building === b.building) {
    if (a.building === 'H') return walk.pairs['H|H'] ?? walk.unknown;
    if (a.floor == null || b.floor == null || a.floor === b.floor) return walk.sameFloor;
    return walk.diffFloor;
  }
  const key = [a.building, b.building].sort().join('|');
  return walk.pairs[key] ?? walk.unknown;
}

export function buildingLabel(loc) {
  return (BUILDING[loc?.building] || BUILDING.U).short;
}
