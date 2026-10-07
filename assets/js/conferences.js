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

// Las Vegas (AWS re:Invent). Rooms look like "MGM Grand, Level 3, Chairman's 363, Content Hub,
// Code Talk" or "Caesars Palace, Promenade Level, Milano IV". Caesars Forum is tested before
// Caesars Palace.
export const LAS_VEGAS_DEF = {
  id: 'las-vegas',
  buildings: [
    { id: 'V', name: 'Venetian / Palazzo', short: 'Venetian', re: /venetian|palazzo|sands expo/i, geo: [36.12171, -115.16933] },
    { id: 'W', name: 'Wynn / Encore', short: 'Wynn', re: /wynn|encore/i, geo: [36.12800, -115.16510] },
    { id: 'F', name: 'Caesars Forum', short: 'Forum', re: /caesars forum|forum event plaza/i, geo: [36.11896, -115.16618] },
    { id: 'P', name: 'Caesars Palace', short: 'Caesars', re: /caesars palace|\bcaesars\b/i, geo: [36.11663, -115.17675] },
    { id: 'M', name: 'MGM Grand', short: 'MGM', re: /mgm/i, geo: [36.10279, -115.16940] },
    { id: 'B', name: 'Mandalay Bay', short: 'Mandalay', re: /mandalay|delano|luxor/i, geo: [36.09225, -115.17582] },
    { id: 'H', name: 'Other off-site', short: 'Off-site', re: /sphere|aria|cosmopolitan|bellagio|\bparis\b|flamingo|linq|resorts world|harrah|mirage|treasure island|t-mobile arena|fontainebleau/i, geo: [36.12121, -115.16206], offsite: true },
    { id: 'O', name: 'Online only', short: 'Online', re: /^(online|virtual|on[- ]demand$)/i },
  ],
  // Door to door at a changeover, with re:Invent crowds, bridges and escalators. The Venetian,
  // Wynn/Encore and Caesars Forum are a 15–20 minute walk from each other; Caesars Palace is
  // across the Strip; MGM Grand and Mandalay Bay are shuttle rides (counted door to door).
  walk: {
    sameRoom: 0,
    sameFloor: 5,
    diffFloor: 8,
    pairs: {
      'V|W': 15, 'F|V': 15, 'P|V': 20, 'M|V': 35, 'B|V': 45,
      'F|W': 20, 'P|W': 25, 'M|W': 45, 'B|W': 50,
      'F|P': 18, 'F|M': 30, 'B|F': 45,
      'M|P': 25, 'B|P': 40,
      'B|M': 25,
      'H|V': 25, 'H|W': 30, 'F|H': 25, 'H|P': 25, 'H|M': 35, 'B|H': 40, 'H|H': 25,
    },
    unknown: 20,
  },
  floorHints: [[/emperors/i, 'Emperors'], [/promenade/i, 'Promenade'], [/content hub/i, 'Content Hub']],
  startFrom: 'W',
  geoRadius: 320,   // these resorts are enormous
  notes: 'Strip walks take longer than the map says (crowds, bridges, casino floors). Venetian, Wynn/Encore and Caesars Forum are 15–20 min apart on foot; Caesars Palace is across the Strip; MGM Grand and Mandalay Bay are shuttle rides, counted door to door. Workshops release unclaimed seats 10 minutes after the start.',
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
    importCmd: 'scripts/import_gartner.py',
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
    live: false,                   // your favorites + reservations, exported from the portal
    rsvp: null,                    // per-session: "reserve a seat" while seats remain
    sessionUrl: s => `https://registration.awsevents.com/flow/awsevents/reinvent2026/sessioncatalog/page/sessioncatalog?search=${encodeURIComponent(String(s.code || '').replace(/-R\d*$/i, ''))}`,
    siteName: 'the re:Invent portal',
    importCmd: 'scripts/import_reinvent.py',
    lunch: { from: 690, to: 810 },
    hint: 'Built from your favorites and reservations in the portal. Reserved seats are pinned; “Session full” favorites are walk-up only (arrive 15 minutes early), so they rank as Maybe.',
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
