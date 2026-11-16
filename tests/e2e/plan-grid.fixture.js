// Fixture for tests/e2e/plan-grid.spec.js (issue #155, specs/features/plan-grid-view.feature).
//
// The real catalogs under data/ change several times a day and the Ignite planner also checks
// the live conference site, so the suite serves these two small catalogs instead and blocks
// everything that is not the local server (see serveFixture). Picks, blocked time and lunch come
// from saved state seeded before the app boots (see seedState).
//
// Every time below is conference-local. Both conferences are in America/Los_Angeles and both
// run after daylight saving ended on 1 November 2026, so local time is UTC-8: the catalog stores
// UTC, as the synced sessions.json does, and the app turns it back into the conference's day and
// minutes whatever time zone the browser is in (the suite pins the browser to Asia/Tokyo).

export const TUE = '2026-11-17';
export const WED = '2026-11-18';
export const THU = '2026-11-19';
export const FRI = '2026-11-20';
export const RIV_MON = '2026-11-30';
export const RIV_TUE = '2026-12-01';
export const RIV_WED = '2026-12-02';

// "Now" for the page: a week before Ignite, so nothing depends on the day the suite runs.
export const FIXED_NOW = '2026-11-10T20:00:00Z';

// The whole text of a block's .g-time: the session's start and its end, in the app's 12-hour
// form. Accepted: "10:00 AM–10:50 AM" (as a session card writes it), "10:00 AM – 10:50 AM"
// (time.js fmtRange), the list's stacked "10:00 AM10:50 AM", and "10:00–10:50 AM". A start
// alone, a wrong end, or anything before or after the range is not.
export const timeRange = (from, to, ap) => new RegExp(`^\\s*${from}(?:\\s*${ap})?\\s*(?:[–—-]|to)?\\s*${to}\\s*${ap}\\s*$`);
const PICKED_AT = Date.UTC(2026, 10, 1);

// store.js: BASE_KEY is nsKey('ignite26.planner.v1') (no instance suffix on the root site) and a
// conference with a namespace is saved under `${BASE_KEY}:${namespace}`. Ignite's namespace is ''.
export const KEYS = {
  ignite2026: 'ignite26.planner.v1',
  reinvent2026: 'ignite26.planner.v1:reinvent2026',
};

const utc = (day, hhmm) => new Date(`${day}T${hhmm}:00-08:00`).toISOString().replace('.000Z', 'Z');
const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// One catalog record in the shape sync.py / live.js normalize() write (data.js buildModel reads
// it). The id (what a pick is saved under), the run key (`inst`, what the page's data-key holds)
// and the code (what a person reads) all differ, so a mix-up between them shows.
function rec(code, title, when = null, extra = {}) {
  const low = code.toLowerCase();
  const [day, from, to, room] = when || [];
  return {
    id: `s-${low}`, inst: `i-${low}`, code, group: code, title, desc: `${title}: a fixture session.`,
    type: 'Breakout', level: 300, topics: ['Copilot'], tags: ['AI'], audience: ['IT pros'],
    delivery: ['In-person'], recorded: null, speakers: [],
    start: day ? utc(day, from) : null, end: day ? utc(day, to) : null, slot: null,
    dur: day ? minutes(to) - minutes(from) : 45,
    room: room || null, roomTbd: !room, popular: false, related: [], repeats: [],
    ...extra,
  };
}

const west = n => `Moscone West, Level 2, Room ${n}`;

// ---------------------------------------------------------------- Ignite
//
// Tuesday 17 Nov, 9:00 AM to 5:00 PM (the feature file's "start and end on the hour" day):
//    9:00-10:00  blocked time "Booth duty"
//   10:00-10:45  BRK101 Maybe, BRK102 Must, BRK103 Want        -> a pill of three
//   10:00-10:45  BRK104 Want, on the watch-later list          -> not on the grid
//   11:00-11:45  BRK105 Must                                   -> the later session a pill pushes
//   12:00-12:45  lunch
//    1:30- 2:30  BRK106 Must   }  overlap                      -> a side-by-side pair; the plan
//    2:00- 3:00  BRK107 Want   }                                  drops BRK107
//    3:00- 4:00  BRK109 Must      touches BRK107 and BRK108    -> full width
//    4:00- 5:00  BRK108 Want                                   -> full width
// Wednesday 18 Nov, 9:14 AM to 4:40 PM ("start and end between hours"; two pills):
//    9:14- 9:50  BRK201 Want
//   10:00-10:45  BRK203 Want, BRK204 Maybe, BRK205 Must        -> pill (same start as Tuesday's)
//   11:00-11:45  BRK206 Must
//   12:00-12:45  lunch
//    1:00- 1:45  BRK211 Maybe, BRK212 Want, BRK213 Must        -> second pill
//    2:00- 2:45  BRK214 Want
//    3:00- 3:30  BRK310-R1 Want (the run of BRK310 the plan attends)
//    3:55- 4:40  BRK207 Maybe
// Thursday 19 Nov (the 50-minute session, and the two decisions beyond the feature file):
//    9:20- 9:50  BRK304 Maybe                                  -> the grid starts at 9 AM
//   10:00-10:50  BRK305 Must, nothing else at that time
//   12:00-12:45  lunch
//   12:15-12:45  BRK303 Maybe: dropped, lunch is worth more    -> overlaps the lunch band
//    2:00- 4:00  blocked time "Customer meeting"
//    2:00- 2:45  BRK301 Must  }  dropped: inside blocked time  -> overlap each other and the band
//    2:15- 3:00  BRK302 Want  }
//    3:15- 3:45  BRK310 Want: dropped for its other run on Wednesday (reason.kind 'repeat')
// Friday 20 Nov: three sessions nobody rated (the day tab exists; they feed "Suggested for you").
// No day: BRK401 Want without a time, BRK402 Want online only.
const IGNITE_SESSIONS = [
  rec('BRK101', 'Agents in production', [TUE, '10:00', '10:45', west(2001)]),
  rec('BRK102', 'Copilot rollout playbook', [TUE, '10:00', '10:45', west(2002)]),
  rec('BRK103', 'Securing AI agents', [TUE, '10:00', '10:45', west(2003)]),
  rec('BRK104', 'Prompt engineering clinic', [TUE, '10:00', '10:45', west(2004)]),
  rec('BRK105', 'Data platform roadmap', [TUE, '11:00', '11:45', west(2005)]),
  rec('BRK106', 'Zero trust for AI', [TUE, '13:30', '14:30', west(2006)]),
  rec('BRK107', 'Governance at scale', [TUE, '14:00', '15:00', west(2007)]),
  rec('BRK108', 'Closing panel on agents', [TUE, '16:00', '17:00', west(2008)]),
  rec('BRK109', 'Observability for agents', [TUE, '15:00', '16:00', west(2009)]),

  rec('BRK201', 'Morning briefing', [WED, '09:14', '09:50', west(2011)]),
  rec('BRK203', 'Vector search basics', [WED, '10:00', '10:45', west(2013)]),
  rec('BRK204', 'Fine-tuning small models', [WED, '10:00', '10:45', west(2014)]),
  rec('BRK205', 'Responsible AI review', [WED, '10:00', '10:45', west(2015)]),
  rec('BRK206', 'Fabric deep dive', [WED, '11:00', '11:45', west(2016)]),
  rec('BRK207', 'Wrap-up and next steps', [WED, '15:55', '16:40', west(2017)]),
  rec('BRK211', 'Edge inference', [WED, '13:00', '13:45', west(2021)]),
  rec('BRK212', 'Cost control for AI', [WED, '13:00', '13:45', west(2022)]),
  rec('BRK213', 'Identity for agents', [WED, '13:00', '13:45', west(2023)]),
  rec('BRK214', 'Evaluating model quality', [WED, '14:00', '14:45', west(2024)]),

  rec('BRK301', 'Migration war stories', [THU, '14:00', '14:45', west(2031)]),
  rec('BRK302', 'Networking for AI workloads', [THU, '14:15', '15:00', west(2032)]),
  rec('BRK303', 'Lunchtime lightning demos', [THU, '12:15', '12:45', west(2033)]),
  rec('BRK304', 'Early bird Q&A', [THU, '09:20', '09:50', west(2034)]),
  rec('BRK305', 'Platform engineering keynote recap', [THU, '10:00', '10:50', west(2035)]),
  rec('BRK310', 'Hands-on with agents', [THU, '15:15', '15:45', west(2040)], { repeats: ['BRK310-R1'] }),
  rec('BRK310-R1', 'Hands-on with agents', [WED, '15:00', '15:30', west(2041)], { group: 'BRK310', repeats: ['BRK310'] }),

  rec('BRK401', 'Session still to be scheduled'),
  rec('BRK402', 'Online-only AI briefing', null, { delivery: ['Online'] }),

  rec('BRK501', 'Agent patterns workshop preview', [FRI, '10:00', '10:45', west(2051)]),
  rec('BRK502', 'Copilot extensibility', [FRI, '11:00', '11:45', west(2052)]),
  rec('BRK503', 'AI safety office hours', [FRI, '13:00', '13:45', west(2053)]),
];

// picks are saved per session id (store.js blank(): { p, lock, note, at, mode, g, code }).
const pick = (code, p, extra = {}) => [`s-${code.toLowerCase()}`, { p, lock: null, note: '', at: PICKED_AT, g: code, code, ...extra }];
const MUST = 3, WANT = 2, MAYBE = 1;

const IGNITE_PICKS = Object.fromEntries([
  pick('BRK101', MAYBE), pick('BRK102', MUST), pick('BRK103', WANT), pick('BRK104', WANT, { mode: 'watch' }),
  pick('BRK105', MUST), pick('BRK106', MUST), pick('BRK107', WANT), pick('BRK108', WANT), pick('BRK109', MUST),
  pick('BRK201', WANT), pick('BRK203', WANT), pick('BRK204', MAYBE), pick('BRK205', MUST), pick('BRK206', MUST),
  pick('BRK207', MAYBE), pick('BRK211', MAYBE), pick('BRK212', WANT), pick('BRK213', MUST), pick('BRK214', WANT),
  pick('BRK301', MUST), pick('BRK302', WANT), pick('BRK303', MAYBE), pick('BRK304', MAYBE), pick('BRK305', MUST),
  pick('BRK310', WANT),
  pick('BRK401', WANT), pick('BRK402', WANT),
]);

// Walking and buffer are zeroed so that the plan depends only on the clock times above, never on
// the venue's walking matrix (which is recalibrated from time to time): back-to-back sessions in
// one building then fit. Lunch is pinned to exactly 12:00-12:45 by a window as long as the meal.
const NO_WALK = { buffer: 0, walk: { sameFloor: 0, diffFloor: 0 } };
const BOOTH = { id: 'booth', day: TUE, start: 540, end: 600, label: 'Booth duty', building: 'W' };
const MEETING = { id: 'meeting', day: THU, start: 840, end: 960, label: 'Customer meeting', building: 'W' };

// The saved state of the Ignite planner. `ui` is merged into the saved ui state (where the
// List / Grid choice lives, as ui.planView); `blocks` replaces the blocked time; `picks` are
// added to the fixture's picks.
export const BLOCKS = [BOOTH, MEETING];
export function igniteState({ ui = {}, blocks = BLOCKS, picks = {} } = {}) {
  return {
    v: 1,
    picks: { ...IGNITE_PICKS, ...picks },
    prefs: { ...NO_WALK, lunch: { on: true, from: 720, to: 765, length: 45 }, blocks },
    ui: { tab: 'plan', filters: {}, day: null, ...ui },
  };
}

// ---------------------------------------------------------------- re:Invent
//
// Picks only: no blocked time, and lunch is switched off, so each day's range is its picks'.
// Monday 30 Nov, 9:00 AM to 12:00 PM: RIV101 Must 9:00-10:00, RIV102 Want 11:00-12:00.
// Tuesday 1 Dec, 9:00 AM to 5:00 PM (the feature file's "picks that start and end on the hour"):
//    9:00-10:00  RIV104 Must
//   10:00-11:00  RIV103, unrated: not a pick, so not on the plan
//    4:00- 5:00  RIV105 Want
// Wednesday 2 Dec, 9:00 AM to 12:45 PM. This day is only for the feature file's "Three sessions
// spread over three hours": a pill whose time span (180 minutes) is longer than its open list
// of three (32 + 44 x 3 = 164), with a Must straight after it. No other test uses it.
//    9:00-10:30  RIV201 Want   }  linked by overlaps: RIV201 and RIV203 never touch each other,
//   10:00-11:30  RIV202 Maybe  }  RIV202 overlaps both      -> one pill from 9:00 to 12:00; the
//   11:00-12:00  RIV203 Want   }                               plan drops RIV202
//   12:00-12:45  RIV204 Must: the only Must of the day         -> the session after the pill
const venetian = n => `Venetian | Level 2 | Titian ${n}`;
const REINVENT_SESSIONS = [
  rec('RIV101', 'Serverless at scale', [RIV_MON, '09:00', '10:00', venetian(2201)]),
  rec('RIV102', 'Storage internals', [RIV_MON, '11:00', '12:00', venetian(2202)]),
  rec('RIV103', 'Chips and accelerators', [RIV_TUE, '10:00', '11:00', venetian(2203)]),
  rec('RIV104', 'Networking at the edge', [RIV_TUE, '09:00', '10:00', venetian(2204)]),
  rec('RIV105', 'Database internals', [RIV_TUE, '16:00', '17:00', venetian(2205)]),

  rec('RIV201', 'Container security workshop', [RIV_WED, '09:00', '10:30', venetian(2211)]),
  rec('RIV202', 'Event-driven design lab', [RIV_WED, '10:00', '11:30', venetian(2212)]),
  rec('RIV203', 'Observability chalk talk', [RIV_WED, '11:00', '12:00', venetian(2213)]),
  rec('RIV204', 'Resilience keynote recap', [RIV_WED, '12:00', '12:45', venetian(2214)]),
];

export function reinventState({ ui = {} } = {}) {
  return {
    v: 1,
    picks: Object.fromEntries([
      pick('RIV101', MUST), pick('RIV102', WANT), pick('RIV104', MUST), pick('RIV105', WANT),
      pick('RIV201', WANT), pick('RIV202', MAYBE), pick('RIV203', WANT), pick('RIV204', MUST),
    ]),
    prefs: { ...NO_WALK, lunch: { on: false } },
    ui: { tab: 'plan', filters: {}, day: null, ...ui },
  };
}

export const CATALOGS = {
  ignite2026: { generatedAt: '2026-11-10T18:00:00Z', changedAt: '2026-11-10T18:00:00Z', source: 'fixture', dropped: [], sessions: IGNITE_SESSIONS },
  reinvent2026: { generatedAt: '2026-11-10T18:00:00Z', changedAt: '2026-11-10T18:00:00Z', source: 'fixture', dropped: [], sessions: REINVENT_SESSIONS },
};

// Everything the page asks for goes through here. Returns what happened, for the harness tests:
//   blocked  hosts of requests that were not for the local server (all aborted), e.g. the Ignite
//            live check against the conference site's CDN
//   data     `${status} ${path}` for every request under /data/: the two fixture catalogs are
//            served, every other data file (favorites, profile, seats, changes, occupancy...) is
//            a 404, which data.js fetchAll treats as "not there". Nothing under data/ is ever
//            read from disk.
export async function serveFixture(context, baseURL) {
  const origin = new URL(baseURL).origin;
  const traffic = { blocked: [], data: [] };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    if (url.origin !== origin) {
      traffic.blocked.push(url.host);
      return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/data/')) {
      const m = /^\/data\/(ignite2026|reinvent2026)\/sessions\.json$/.exec(url.pathname);
      traffic.data.push(`${m ? 200 : 404} ${url.pathname}`);
      return m
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOGS[m[1]]) })
        : route.fulfill({ status: 404, contentType: 'text/plain', body: 'not in the fixture' });
    }
    // app.js asks a local server whether it can run a sync (api/status); the answer is always no.
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no api in tests' });
    return route.continue();
  });
  return traffic;
}

// Saved state for both conferences, written before the app's own scripts run. An init script
// runs again on every navigation (a reload, a conference switch), so it only fills a key that is
// still empty: whatever the app saved during the test is never overwritten.
export async function seedState(context, { ignite, reinvent } = {}) {
  const entries = [
    [KEYS.ignite2026, JSON.stringify(igniteState(ignite))],
    [KEYS.reinvent2026, JSON.stringify(reinventState(reinvent))],
  ];
  await context.addInitScript(items => {
    try {
      for (const [key, text] of items) if (localStorage.getItem(key) === null) localStorage.setItem(key, text);
      // What the app is about to load, for tests that depend on it (the app may tidy it up later).
      window.__savedAtBoot = Object.fromEntries(items.map(([key]) => [key, localStorage.getItem(key)]));
    } catch { /* about:blank has no storage */ }
  }, entries);
}
