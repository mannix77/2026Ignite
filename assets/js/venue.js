// Venue model: turn a catalog location string into a building/floor, and estimate
// door-to-door walking minutes between two locations. A venue is created from a
// conference definition (see conferences.js); the Moscone one is the module default.

// ---------------------------------------------------------------- generic helpers

// Same physical room: identical real room names. Placeholders like "zTest78" are shared by
// many unrelated sessions, so they never count. (A real room in a building we don't
// recognize still counts.)
export function sameRoom(a, b) {
  return !!(a && b && !a.placeholder && !b.placeholder && a.label && a.label === b.label);
}

export function walkMinutes(a, b, walk = current.walk) {
  if (!a || !b) return walk.unknown;
  if (a.building === 'O' || b.building === 'O') return 0;
  if (sameRoom(a, b)) return walk.sameRoom;
  if (!a.known || !b.known) return walk.unknown;
  if (a.building === b.building) {
    const same = walk.pairs[`${a.building}|${a.building}`];
    if (same != null) return same;                       // e.g. "other off-site" venues
    if (a.floor == null || b.floor == null || a.floor === b.floor) return walk.sameFloor;
    return walk.diffFloor;
  }
  const key = [a.building, b.building].sort().join('|');
  return walk.pairs[key] ?? walk.unknown;
}

export function createVenue(def) {
  const buildings = def.buildings.map(b => ({ ...b }));
  const BUILDING = Object.fromEntries(buildings.map(b => [b.id, b]));
  BUILDING.U = { id: 'U', name: 'Location TBA', short: 'TBA' };
  BUILDING.O = BUILDING.O || { id: 'O', name: 'Online only', short: 'Online' };
  const placeholder = def.placeholder || /^(ztest\S*|tbd|tba)$/i;

  function parseLocation(label, overrides = {}) {
    const raw = (label || '').trim();
    if (!raw || placeholder.test(raw)) return { label: raw, building: 'U', floor: null, known: false, placeholder: true };
    let building = overrides[raw] || null;
    if (!building) {
      for (const b of buildings) {
        if (b.re && b.re.test(raw)) { building = b.id; break; }
      }
    }
    let floor = null;
    const lv = /(?:level|lvl|floor)\s*(\d)/i.exec(raw);
    if (lv) floor = lv[1];
    else if (def.floorHints) {
      for (const [re, name] of def.floorHints) if (re.test(raw)) { floor = name; break; }
    }
    if (floor == null && !def.floorHints) {
      if (/the hub|expo|exhibit/i.test(raw)) floor = 'Hub';
      else {
        const room = /(?:room|rm\.?)\s*(\d{3,4})/i.exec(raw);
        if (room) floor = room[1][0];
      }
    }
    return { label: raw, building: building || 'U', floor, known: !!building && building !== 'U' };
  }

  const buildingLabel = loc => (BUILDING[loc?.building] || BUILDING.U).short;
  return {
    id: def.id, buildings, BUILDING, walk: JSON.parse(JSON.stringify(def.walk)), startFrom: def.startFrom,
    ids: buildings.map(b => b.id), parseLocation, buildingLabel, notes: def.notes || '', geoRadius: def.geoRadius || 220,
    keynoteBuildings: buildings.filter(b => b.keynote).map(b => b.id),   // entering one costs keynoteExtra
  };
}

// ---------------------------------------------------------------- Moscone (Ignite)

// Published locations look like (Ignite 2025, same venue):
//   "Moscone West, Level 3, Room 3016"     "Moscone South, The Hub, Theater A"
//   "Moscone South, Level 3, Room 301"     "Marriott Marquis, Yerba Buena Ballroom, BO2"
//   "Chase Center" (keynote)
export const MOSCONE_DEF = {
  id: 'moscone',
  buildings: [
    { id: 'W', name: 'Moscone West', short: 'West', re: /moscone\s*west|^west\b/i, geo: [37.78306, -122.40410] },
    { id: 'S', name: 'Moscone South', short: 'South', re: /moscone\s*south|^south\b|esplanade/i, geo: [37.78360, -122.40120] },
    { id: 'N', name: 'Moscone North', short: 'North', re: /moscone\s*north|^north\b/i, geo: [37.78470, -122.40250] },
    { id: 'M', name: 'Marriott Marquis', short: 'Marriott', re: /marriott|marquis/i, geo: [37.78543, -122.40449] },
    { id: 'C', name: 'Chase Center', short: 'Chase Ctr', re: /chase\s*center/i, geo: [37.76790, -122.38742], keynote: true },
    { id: 'H', name: 'Other off-site', short: 'Off-site', re: /intercontinental|hilton|hyatt|westin|park central|four seasons|st\.? regis|yerba buena (center|gardens)|metreon|sfmoma|\bw hotel/i, offsite: true },
    { id: 'O', name: 'Online only', short: 'Online', re: /^(online|virtual|on[- ]demand$)/i },
  ],
  // Door-to-door minutes at a changeover, including the badge/ID/bag check Ignite 2025 ran
  // at every building entrance and the crowds on 4th St / Howard St (typical, not worst
  // case: add ~50% right after a keynote). Derived from floor plans, walking routes and
  // the 2025 schedule. All editable in Settings.
  walk: {
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
  },
  startFrom: 'W',
  geoRadius: 180,   // metres from a building's centre that still counts as "at" it
  notes: 'Includes the badge/bag check at building entrances. Moscone North and South connect inside; West is across 4th St; the Marriott Marquis is a block north of West; Chase Center (keynotes) is about 2 miles away, so plan on the shuttle.',
};

export const MOSCONE = createVenue(MOSCONE_DEF);

// Module-level defaults bound to Moscone (tests and the Ignite sync use these).
export const BUILDINGS = MOSCONE.buildings;
export const BUILDING = MOSCONE.BUILDING;
export const DEFAULT_WALK = MOSCONE.walk;
export const PAIR_KEYS = Object.keys(DEFAULT_WALK.pairs);
export function parseLocation(label, overrides = {}, venue = MOSCONE) { return venue.parseLocation(label, overrides); }
export function buildingLabel(loc, venue = current) { return venue.buildingLabel(loc); }

// The venue of the conference being shown (set by the app at boot / on switch).
let current = MOSCONE;
export function setVenue(v) { current = v; }
export function venue() { return current; }
