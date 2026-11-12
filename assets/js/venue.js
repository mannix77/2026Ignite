// Venue model: turn a catalog location string into a building/floor, and estimate
// door-to-door walking minutes between two locations. A venue is created from a
// conference definition (see conferences.js); the Moscone one is the module default.

// ---------------------------------------------------------------- generic helpers

// A room that is not a room yet: test rooms ("zTest78"), TBD/TBA, and "Rescheduling 3" /
// "Rescheduling Room", where Microsoft parks a session while it moves it. The browser's one copy:
// live.js normalizes with it; scripts/venues.py PLACEHOLDER is the Python one, spelled out so that
// it reads every character as this does (tests/test_sync.py checks every BMP character).
export const PLACEHOLDER_ROOM = /^(ztest\S*|tbd|tba|rescheduling(\s.*)?)$/i;

// Same physical room: identical real room names. Placeholders like "zTest78" are shared by
// many unrelated sessions, so they never count. (A real room in a building we don't
// recognize still counts.)
export function sameRoom(a, b) {
  return !!(a && b && !a.placeholder && !b.placeholder && a.label && a.label === b.label);
}

// Minutes a floor adds to a walk that leaves or enters its building: a pair in walk.pairs is
// door to door for a typical floor, and walk.floorExtra[building][floor] holds the floors that
// sit further in (Moscone South's exhibit-level Hub, its Upper Mezzanine). Not user-editable.
// Exported for the walk from a GPS position outside the venue (app.js), which has no pair.
export function floorExtra(loc, walk) {
  const v = walk?.floorExtra?.[loc?.building]?.[loc?.floor];
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// ------------------------------------------------------- where in a building you are (issue 99)

const EARTH_M = 6371000;
// Great-circle distance in metres between two [lat, lon] points. Also used for the walk from a
// GPS position outside the venue (app.js), and for picking a side below.
export function haversine([a1, o1], [a2, o2]) {
  const r = Math.PI / 180;
  const h = Math.sin(((a2 - a1) * r) / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(((o2 - o1) * r) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

// A GPS fix vaguer than this cannot be trusted to tell one side of a building from the other, so
// it is left unknown rather than guessed (issue 99: a precise fix picks a side; a vague one does not).
export const SIDE_FIX_ACCURACY_M = 50;

// Which of walk.sides[building] a GPS fix is nearest to: null when the venue defines no sides
// for that building, there is no fix, or the fix is not accurate enough to tell sides apart.
// Not used for a manually chosen side (app.js), which needs no accuracy check.
export function sideOf(walk, building, geo, accuracy) {
  const sides = walk?.sides?.[building];
  if (!sides || !geo || !(accuracy <= SIDE_FIX_ACCURACY_M)) return null;
  let best = null;
  for (const [id, side] of Object.entries(sides)) {
    if (!side.geo) continue;
    const d = haversine(geo, side.geo);
    if (!best || d < best.distance) best = { id, distance: d };
  }
  return best?.id ?? null;
}

// The minutes a's own chosen/located side gives to b's building, when the venue defines one for
// it (issue 99: the Dolphin's Swan-facing end is a shorter walk to the Swan than its far end,
// which the flat building-to-building pair cannot say on its own). null when a has no side, the
// venue defines none for a's building, or none covers b's building: walkMinutes then falls back
// to the ordinary pair, exactly as before a side was known.
function sideMinutes(a, b, walk) {
  const v = walk.sides?.[a.building]?.[a.side]?.pairs?.[b.building];
  return Number.isFinite(v) ? v : null;
}

// The walking matrix in force: the venue's defaults under what was saved in Settings. Settings
// saves the whole matrix, so a saved pair that still equals the default it was saved with
// (walk.previous.pairs, the defaults before a recalibration) was never tuned and takes the new
// default; a pair that differs was tuned and stays. Scalars (sameFloor…) follow the saved values;
// floorExtra and previous always come from the venue.
export function mergeWalk(def, saved) {
  if (!saved || typeof saved !== 'object') return def;
  const out = { ...def, ...saved, pairs: { ...def.pairs }, floorExtra: def.floorExtra, previous: def.previous, sides: def.sides };
  const previous = def.previous?.pairs || {};
  for (const [key, v] of Object.entries(saved.pairs && typeof saved.pairs === 'object' ? saved.pairs : {})) {
    if (!Number.isFinite(v)) continue;
    if (Object.hasOwn(previous, key) && v === previous[key]) continue;   // saved along with the old default
    out.pairs[key] = v;
  }
  return out;
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
  // A side's own pair is already door to door for that side (e.g. the Dolphin's Swan end), so it
  // gets the same floorExtra treatment as the ordinary pair below, not a free pass around it.
  const sided = sideMinutes(a, b, walk);
  if (sided != null) return sided + floorExtra(a, walk) + floorExtra(b, walk);
  const key = [a.building, b.building].sort().join('|');
  const pair = walk.pairs[key];
  return pair == null ? walk.unknown : pair + floorExtra(a, walk) + floorExtra(b, walk);
}

export function createVenue(def) {
  const buildings = def.buildings.map(b => ({ ...b }));
  const BUILDING = Object.fromEntries(buildings.map(b => [b.id, b]));
  BUILDING.U = { id: 'U', name: 'Location TBA', short: 'TBA' };
  BUILDING.O = BUILDING.O || { id: 'O', name: 'Online only', short: 'Online' };
  const placeholder = def.placeholder || PLACEHOLDER_ROOM;

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
    // The generic fallback (an exhibit hall, the first digit of a room number) is for Moscone;
    // a venue with its own floorHints skips it unless it asks for both (genericFloors).
    if (floor == null && (def.genericFloors || !def.floorHints)) {
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

// Published locations look like (Ignite 2025 and 2026, same venue):
//   "Moscone West, Level 3, Room 3016"     "Moscone South, The Hub, Theater A"
//   "Moscone South, Level 3, Room 301"     "Marriott Marquis, Yerba Buena Ballroom, BO2"
//   "AMC Metreon | Level 3, Theater 9"     "The Aviary, Labs" (the Metreon's rooftop, level 4)
//   "Dimes Gallery" (667 Howard St)        "Rescheduling 3" (a holding room while a session moves: a placeholder)
//   "Chase Center" (keynote)
// The building patterns are mirrored in scripts/venues.py (tests/test_venues.py keeps them equal).
export const MOSCONE_DEF = {
  id: 'moscone',
  buildings: [
    { id: 'W', name: 'Moscone West', short: 'West', re: /moscone\s*west|^west\b/i, geo: [37.78306, -122.40410] },
    { id: 'S', name: 'Moscone South', short: 'South', re: /moscone\s*south|^south\b|esplanade/i, geo: [37.78360, -122.40120] },
    { id: 'N', name: 'Moscone North', short: 'North', re: /moscone\s*north|^north\b/i, geo: [37.78470, -122.40250] },
    { id: 'M', name: 'Marriott Marquis', short: 'Marriott', re: /marriott|marquis/i, geo: [37.78543, -122.40449] },
    { id: 'C', name: 'Chase Center', short: 'Chase Ctr', re: /chase\s*center/i, geo: [37.76790, -122.38742], keynote: true },
    // 135 4th St, between Mission and Howard: AMC theaters on level 3, The Aviary (rooftop) on 4.
    { id: 'E', name: 'Metreon', short: 'Metreon', re: /metreon|\baviary\b/i, geo: [37.78440, -122.40310] },
    // 667 Howard St, across Howard from Moscone South (sponsor event space, lightning talks).
    { id: 'D', name: 'Dimes Gallery', short: 'Dimes', re: /dimes\s*gallery/i, geo: [37.78570, -122.39990] },
    { id: 'H', name: 'Other off-site', short: 'Off-site', re: /intercontinental|hilton|hyatt|westin|park central|four seasons|st\.? regis|yerba buena (center|gardens)|sfmoma|\bw hotel/i, offsite: true },
    { id: 'O', name: 'Online only', short: 'Online', re: /^(online|virtual|on[- ]demand$)/i },
  ],
  // Door-to-door minutes at a changeover: the walk itself plus about 3 minutes for the badge/bag
  // check Ignite runs at every building entrance and the crowds on 4th St / Howard St (typical,
  // not worst case: add ~50% right after a keynote). The walks between Moscone West, South and the
  // Metreon are calibrated against routes drawn by Ignite's official indoor map on 2026-11-07
  // (accessible routes, about 1.4 m/s): South Level 2 to West Level 3 4 min 9 s, Metreon Theater 9
  // to West 5 min 39 s, South Level 2 to the Metreon 6 min 12 s, the Hub to West 7 min 57 s, the
  // Esplanade tables to the Metreon 7 min 31 s. The map does not route to the Marriott, Dimes
  // Gallery or Chase Center, so those stay estimates. All pairs are editable in Settings.
  walk: {
    sameRoom: 0,
    sameFloor: 3,
    diffFloor: 5,     // e.g. South Hub (exhibit level) <-> South Level 3; West Level 2 <-> 3 is 2.4 min walked, plus the escalator queue
    pairs: {
      'N|S': 7, 'N|W': 10, 'S|W': 7,
      'M|W': 13, 'M|S': 14, 'M|N': 13,
      'E|W': 8, 'E|M': 5, 'E|S': 9, 'E|N': 9,
      'D|S': 5, 'D|N': 7, 'D|W': 8, 'D|E': 8, 'D|M': 10,
      'C|W': 40, 'C|S': 40, 'C|N': 40, 'C|M': 40, 'C|E': 40, 'C|D': 40,
      'H|W': 12, 'H|S': 12, 'H|N': 12, 'H|M': 12, 'E|H': 12, 'D|H': 12, 'C|H': 40, 'H|H': 12,
    },
    // Floors that sit further in than the pair assumes, added when a walk leaves or enters them:
    // Moscone South's Hub (exhibit level) is about 4 minutes further from every other building
    // than a Level 2 room, the Upper Mezzanine (Esplanade tables) about 1.
    floorExtra: { S: { Hub: 4, UM: 1 } },
    // The defaults these pairs replaced (2026-11-07). A matrix saved from Settings holds every
    // pair; one still equal to its old default was never tuned and follows the new value
    // (mergeWalk). Update this map whenever a pair above changes.
    previous: { pairs: { 'S|W': 12, 'E|W': 5, 'E|S': 8, 'E|N': 8 } },
    unknown: 12,      // room not published yet: assume a building change
  },
  // The Aviary rooms carry no level ("The Aviary, Labs") and the Esplanade tables name a mezzanine;
  // the Hub and room-number rules still apply (genericFloors).
  floorHints: [[/\baviary\b/i, '4'], [/upper mezzanine/i, 'UM']],
  genericFloors: true,
  startFrom: 'W',
  geoRadius: 180,   // metres from a building's centre that still counts as "at" it
  notes: 'Includes the badge/bag check at building entrances. Moscone North and South connect inside; West is across 4th St; the Metreon (AMC theaters, The Aviary on its roof) is a block north of West on 4th St, across from the Marriott Marquis; Chase Center (keynotes) is about 2 miles away, so plan on the shuttle.',
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
