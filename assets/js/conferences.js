// The conferences this planner knows about. Each has its own catalog folder, timezone,
// venue model and storage namespace; the planner itself is conference-agnostic.

import { MOSCONE_DEF } from './venue.js';
import { nsKey } from './instance.js';

// Walt Disney World Swan & Dolphin (Gartner IT Symposium/Xpo). Rooms look like
//   "Upper Peninsula 4, WDW Dolphin Hotel"   "Stage 1, IT Xpo, Atlantic Hall, WDW Dolphin Hotel"
//   "Swan Ballroom 6, WDW Swan Hotel"        "Lark 1, WDW Swan Hotel"
//   "Grand Harbor Salon 1, Disney's Yacht & Beach Resort"   "Asbury D, Disney's Yacht & Beach Resort"
//   "Dolphin Central Pavilion"               "Atlantic Dance Hall, BoardWalk Inn"
// Buildings are tested in order: the Dolphin first because its venues name other hotels
// ("Cabana Bar and Beach Club, WDW Dolphin Hotel"), the Reserve before the Swan.
export const SWAN_DOLPHIN_DEF = {
  id: 'swan-dolphin',
  buildings: [
    { id: 'D', name: 'WDW Dolphin', short: 'Dolphin', re: /dolphin|atlantic hall|pacific (hall|terrace)|hemisphere|central pavilion|(upper|lower) peninsula|peninsula|oceanic|\b(asia|europe|australia)\s*\d|\bamericas\b|\bbay room\b|it ?xpo/i, geo: [28.36727, -81.56047] },
    { id: 'R', name: 'Swan Reserve', short: 'Reserve', re: /swan\s*reserve|\boasis\b|\binlet\b|\breef\b|\blagoon\b|\bvue\b|\bharbor\s*[1-5]\b/i, geo: [28.36453, -81.56182] },
    { id: 'S', name: 'WDW Swan', short: 'Swan', re: /\bswan\b|\b(lark|mockingbird|osprey|pelican|toucan|macaw|parrot|peacock|cockatoo|hummingbird)\b|\b(dove|egret|heron|ibis|sandpiper|teal)\b|eagle boardroom|lake view/i, geo: [28.36531, -81.55984] },
    { id: 'Y', name: "Yacht & Beach Club", short: 'Yacht&Beach', re: /yacht|beach (club|resort)|grand harbor|\b(asbury|cape cod|newport|hampton|saybrook|seaview|bourne|stonington|wellfleet|eastham|nantucket|martha)\b/i, geo: [28.37120, -81.55830] },
    { id: 'B', name: 'BoardWalk Inn', short: 'BoardWalk', re: /boardwalk/i, geo: [28.36720, -81.55563] },
    { id: 'H', name: 'Other off-site', short: 'Off-site', re: /hollywood studios|epcot|magic kingdom|animal kingdom|disney springs|west pavill?ion/i, geo: [28.35725, -81.56062], offsite: true },
    { id: 'O', name: 'Online only', short: 'Online', re: /^(online|virtual|on[- ]demand$)/i },
  ],
  // Minutes door to door at a changeover, from the hotels' floor plans, measured routes
  // and attendee reports (allow 10–15 between venues; Yacht Club rear exit to the Dolphin
  // is ~2,200 ft). The Swan and Dolphin face each other across a covered causeway; the
  // Reserve is across the internal street from the Swan; the Yacht & Beach Club convention
  // center is a walk around Crescent Lake on an exposed path. Refine in Settings.
  walk: {
    sameRoom: 0,
    sameFloor: 3,
    diffFloor: 5,     // Dolphin: convention level <-> lobby/ballroom levels by escalator
    pairs: {
      'D|S': 10, 'D|R': 12, 'R|S': 6,
      'D|Y': 15, 'S|Y': 18, 'R|Y': 22,
      'B|D': 15, 'B|S': 14, 'B|R': 16, 'B|Y': 10,
      'D|H': 25, 'H|S': 25, 'H|R': 25, 'H|Y': 25, 'B|H': 25, 'H|H': 15,
    },
    unknown: 10,
  },
  // Dolphin levels: the IT Xpo (Atlantic/Pacific Halls) and the new Peninsula wing are on
  // the convention level; Oceanic/Europe/Asia/Australia rooms and the Central Pavilion on
  // the lobby level; the Hemisphere ballrooms and Americas Seminar one level up.
  floorHints: [
    [/atlantic hall|pacific hall|pacific terrace|it ?xpo|peninsula/i, 'Convention'],
    [/hemisphere|\bamericas\b/i, 'Ballroom'],
    [/oceanic|\b(asia|europe|australia)\s*\d|central pavilion|meal pavilion/i, 'Lobby'],
  ],
  startFrom: 'D',
  geoRadius: 260,   // the Dolphin alone is ~300 m long
  notes: 'Swan and Dolphin: 7–10 min across the covered causeway (10–15 from the Xpo level). Swan Reserve: across the street from the Swan. Yacht & Beach Club convention center: 12–20 min around Crescent Lake on an exposed path (the Friendship boats are no faster). Add a few minutes at keynote and lunch changeovers; October afternoons are hot and showery.',
};

// Las Vegas Strip resorts (AWS re:Invent). Rooms are "<Venue> | <Floor> | <Room>", with two more
// segments for theaters inside a Content Hub or the Expo:
//   "MGM Grand | Level 1 | Grand 122"          "Caesars Palace | Promenade Level | Roman I"
//   "Caesars Forum | Level 1 | Forum 120 | Content Hub | Purple Theater"
//   "Wynn/Encore | Upper Convention Promenade | Cristal 2 | Content Hub | Blue Theater"
//   "Venetian | Level 2 | Hall B | Expo | Industry Theater"
// The building is the first segment (anchored, so Caesars Forum never reads as the Palace); the
// floor is "Level N" or one of the named levels below. Theaters in one hub or Expo hall are a
// ~2-minute walk apart: same floor, different room.
export const LAS_VEGAS_DEF = {
  id: 'las-vegas',
  buildings: [
    // Coordinates are approximate (resort centres from public maps); verify on site.
    { id: 'V', name: 'Venetian / Palazzo (Venetian Expo)', short: 'Venetian', re: /^\s*(venetian|palazzo)/i, geo: [36.1215, -115.1696] },
    { id: 'W', name: 'Wynn / Encore', short: 'Wynn', re: /^\s*(wynn|encore)/i, geo: [36.1265, -115.1657] },
    { id: 'C', name: 'Caesars Palace', short: 'Caesars', re: /^\s*caesars\s+palace/i, geo: [36.1162, -115.1745] },
    { id: 'F', name: 'Caesars Forum', short: 'Forum', re: /^\s*caesars\s+forum/i, geo: [36.1180, -115.1688] },
    { id: 'M', name: 'MGM Grand', short: 'MGM', re: /^\s*mgm/i, geo: [36.1024, -115.1700] },
    { id: 'O', name: 'Online only', short: 'Online', re: /^(online|virtual|on[- ]demand$)/i },
  ],
  // Door-to-door minutes at a changeover: editable estimates, not measurements. Venetian,
  // Wynn, Caesars Palace and Caesars Forum are a walk (skybridges, casino floors); the MGM
  // Grand is ~2 miles south, so any move to or from it means the re:Invent shuttle.
  walk: {
    sameRoom: 0,
    sameFloor: 5,     // these resorts are huge: hallways alone run several minutes
    diffFloor: 8,
    pairs: {
      'V|W': 15, 'F|V': 15, 'C|F': 10, 'C|V': 15, 'C|W': 25, 'F|W': 20,
      'C|M': 35, 'F|M': 35, 'M|V': 35, 'M|W': 35,
    },
    unknown: 15,
  },
  floorHints: [
    [/upper convention promenade/i, 'Upper Convention Promenade'],
    [/lower convention promenade/i, 'Lower Convention Promenade'],
    [/convention promenade/i, 'Convention Promenade'],
    [/promenade south/i, 'Promenade South'],
    [/promenade level/i, 'Promenade Level'],
    [/emperors level/i, 'Emperors Level'],
  ],
  startFrom: 'V',
  geoRadius: 350,   // a resort plus its convention wing runs 500 m+
  notes: 'Estimates for re:Invent 2026, not measured: Venetian–Wynn, Venetian–Forum and Caesars–Venetian ~15 min, Caesars Palace–Forum ~10, Forum–Wynn ~20, Caesars Palace–Wynn ~25. The MGM Grand is ~2 miles south of the others: allow ~35 min by shuttle each way, so MGM to anywhere north is a serious cost. Inside one resort allow 5 min on a floor and 8 between floors. Content Hub and Expo theaters are ~2 min apart. Refine in Settings.',
};

export const CONFERENCES = {
  ignite2026: {
    id: 'ignite2026',
    name: 'Microsoft Ignite 2026',
    short: 'Ignite',
    place: 'Moscone Center, San Francisco',
    tz: 'America/Los_Angeles',
    days: ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'],
    dataDir: 'data/ignite2026',
    namespace: '',                 // the first release stored Ignite picks under the bare key
    venue: MOSCONE_DEF,
    live: true,                    // live checks against the Ignite site's catalog copy
    cdn: 'ignite2026-prod',        // the event folder on eventtools.event.microsoft.com
    // Session types that need an RSVP, and when RSVPs open (site settings; used if the live value is missing).
    rsvp: { 'Lab': '2026-10-26T08:00:00+08:00', 'Lightning Talk': '2026-10-26T08:00:00+08:00', 'Table Talk': '2026-10-26T08:00:00+08:00', 'Invite Only': '2026-10-26T08:00:00+08:00' },
    // The site resolves both the instance id (canonical) and the session code.
    sessionUrl: s => `https://ignite.microsoft.com/en-US/sessions/${encodeURIComponent(s.inst || s.code)}`,
    siteName: 'the Ignite site',
    lunch: { from: 690, to: 810 },
    hint: 'Dates and rooms arrive late (expected late October); the app watches for them.',
  },
  gartner2026: {
    id: 'gartner2026',
    name: 'Gartner IT Symposium/Xpo 2026',
    short: 'Gartner',
    place: 'Swan & Dolphin, Orlando',
    tz: 'America/New_York',
    days: ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'],
    dataDir: 'data/gartner2026',
    namespace: 'gartner2026',
    venue: SWAN_DOLPHIN_DEF,
    live: false,                   // the agenda comes from your Conference Navigator export
    rsvp: null,                    // per-session flag in the catalog ("seat reservation required")
    // Conference Navigator (login) is where seats are reserved; the public agenda has no per-session links.
    sessionUrl: () => 'https://cn.gartner.com/SYM36/fullagenda',
    siteName: 'Conference Navigator',
    // Meals run 11:45–2:45; the grid leaves 1:00–1:45 (Wed 1:00–2:15) free.
    lunch: { from: 705, to: 885 },
    hint: 'Times and rooms are final. Reserve seats for reservation-required sessions in Conference Navigator, then mark them here.',
  },
  reinvent2026: {
    id: 'reinvent2026',
    name: 'AWS re:Invent 2026',
    short: 're:Invent',
    place: 'Las Vegas',
    tz: 'America/Los_Angeles',
    days: ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'],
    dataDir: 'data/reinvent2026',
    namespace: 'reinvent2026',
    venue: LAS_VEGAS_DEF,
    live: false,                   // refreshed by scripts/import_reinvent.py (scheduled sync)
    rsvp: null,                    // per-session flag in the catalog (reserved seating)
    sessionUrl: s => `https://registration.awsevents.com/flow/awsevents/reinvent2026/eventcatalog/page/eventcatalog?search=${encodeURIComponent(s.code)}`,
    siteName: 'the re:Invent catalog',
    sourceLabel: 'Catalog snapshot',
    hostCompany: /^(aws|amazon|amazon web services|amazon\.com|amazon web services,? inc\.?)$/i,
    lunch: { from: 660, to: 840 },  // 11:00-14:00
    hint: 'Times and rooms are published. Reserve seats in the re:Invent portal, then mark them here.',
    // Changes page: where this catalog comes from (stamp is pre-escaped).
    catalogNote: stamp => `This catalog is a snapshot of the public re:Invent catalog (${stamp}), refreshed by a scheduled sync. Differences are logged here and posted to GitHub, and changes to your picks are highlighted. Keynotes aren't in the AWS catalog: block their time out in Settings until AWS publishes them.`,
  },
};

export const DEFAULT_CONFERENCE = 'ignite2026';
const PREF_KEY = nsKey('ignite26.planner.conference');

export function conferenceList() { return Object.values(CONFERENCES); }

// Which conference to show: ?conf= in the URL, then the saved choice, then the default.
export function currentConferenceId() {
  const q = new URLSearchParams(location.search).get('conf');
  if (q && CONFERENCES[q]) return q;
  try {
    const saved = localStorage.getItem(PREF_KEY);
    if (saved && CONFERENCES[saved]) return saved;
  } catch { /* storage blocked */ }
  return DEFAULT_CONFERENCE;
}

export function rememberConference(id) {
  try { localStorage.setItem(PREF_KEY, id); } catch { /* storage blocked */ }
}
