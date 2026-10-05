# Ignite 2026 Planner

An unofficial personal planner for **Microsoft Ignite 2026** (Nov 17–20, Moscone Center, San Francisco). It keeps itself up to date from the Ignite session catalog and helps you decide quickly what to attend. When two sessions clash, or there isn't time to get from one building to another, it shows what you'd gain and lose with each choice.

> Not affiliated with Microsoft. Session data comes from the public Ignite catalog feeds.

## What it does

| | |
|---|---|
| **Stays current** | Each time you open the app (and every 10 minutes while it's open) it checks the Ignite site directly. A GitHub Action also syncs the catalog every 30 minutes to 2 hours. It logs every addition, removal, time change and room move, and posts a summary to a GitHub issue so you get notified. |
| **Spots publication** | Times and rooms aren't public yet. The sync watches for them in the data and also watches the site's own switches (`showSessionTimeSlots`, `showLocations`). It raises a 🚨 milestone as soon as they flip. |
| **Fast triage** | Rate sessions **Must / Want / Maybe / Skip** one at a time with keys `1 2 3 0` (undo `U`, later `→`). Filter by topic, type, level, audience, recorded or not, and "new this week". |
| **Plans around walking time** | Once times and rooms are out, it builds the best plan for each day. The day's choices are optimized exactly, and repeat runs are chosen across days. Moving between Moscone West, South, North, the Marriott Marquis and Chase Center costs real time, including the badge and bag checks at each entrance and getting into keynotes. |
| **Lunch & blocked time** | Protects a lunch break (default: 30 min somewhere between 11:30 and 1:30). Meetings, booth duty or a flight can be blocked out with a location, and the plan includes walking to and from them. |
| **Makes the sacrifice obvious** | Each clash compares whole-day outcomes: "go to X → you also make Y, you miss Z (12 min walk, 5 min gap)". Recorded sessions are discounted ("watch later"), labs and table talks get a boost (in person only), and ties are labelled as ties. If a session repeats, it moves you to the repeat instead of dropping it. |
| **Conference-day mode** | **Now** shows where you should be and when to leave, counting from where your day starts before the first session. It also shows what's starting nearby if a room is full. |
| **RSVP reminders** | Labs, lightning talks and table talks need an RSVP (opens Oct 25, 5 PM PT). The plan lists which of your picks need one until you mark them **I reserved a seat**. That also locks the reserved run into your plan. |
| **Change alerts** | Every run of every session you picked is watched. If one moves, is retitled or is cancelled, you see exactly what changed and whether it's the run you're attending. You also hear when a new run is added. |
| **Offline & portable** | Installable PWA that works on bad conference Wi-Fi. Export your plan to your calendar (`.ics`). Move picks between devices with a link or a backup file. |

Before the real schedule is published you can turn on **Preview** (Settings, or the button on My plan) to rehearse with a clearly labelled simulated schedule.

## Use it

**On your iPhone (recommended):** open the GitHub Pages address in Safari, then tap **Share → Add to Home Screen** *before* you start rating. The installed app keeps its own copy of your picks (separate from Safari's) and works offline at the venue. To move picks from another device, use **Settings → Copy link to my picks** there, then **Settings → Import picks from a link** in the installed app. **Save a backup** opens the share sheet, so you can keep a copy in Files.

**Locally:**

```bash
python3 scripts/serve.py          # http://localhost:8026, refreshes the catalog first
python3 scripts/serve.py --lan    # also reachable from your phone on the same Wi-Fi
```

Local syncs write to `.local-data/` (git-ignored), so they never conflict with the Action's commits. The local server only serves the app's own files. On a phone, prefer the HTTPS Pages address: offline mode needs HTTPS, and the address never changes.

No build step and no dependencies: plain HTML/CSS/JS modules plus Python 3 standard library.

## One-time GitHub setup

1. Push this repo to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions → "Sync Ignite catalog & deploy" → Run workflow** (or wait for the schedule). The app is published at `https://<user>.github.io/<repo>/`.
4. To get notified, **watch** the repo or subscribe to the "Ignite 2026 catalog changes" issue the workflow opens.
5. Optional: in the app, **Settings → Copy watchlist**, then paste the result into `data/watchlist.json`. Changes to those sessions get a ⭐ and are listed first.

## How it works

```
Ignite catalog API ─┐                        ┌─> data/sessions.json  (normalized catalog, committed)
CDN fallback copy ──┼─> scripts/sync.py ─────┼─> data/changes.json   (change log, committed)
site settings ──────┘   (GitHub Action)      ├─> data/meta.json      (status, deployed only)
                                             └─> issue comment       (notification)

Browser ── data/*.json (snapshot + history)
        └─ CDN fallback copy (live check, CORS-enabled) ── assets/js/live.js
```

- `scripts/sync.py`: fetches the CDN copy the official site uses (falling back to the API), normalizes it, diffs it against the last snapshot by run, and records milestones. It refuses to overwrite good data with a partial catalog, and records any failure in `meta.json` instead of failing silently.
- `assets/js/live.js`: the same normalization in the browser, against the CDN copy the official site uses. `tests/test_sync.py` checks that the Python and JS versions produce identical output.
- `assets/js/planner.js`: travel-aware conflict detection, the optimizer (exact per day; repeat runs chosen exhaustively when few, by coordinate descent otherwise), what-if comparisons and free-slot fillers. A randomized test checks it against brute force.
- `sw.js`: offline support. The app shell installs atomically per version; CI stamps the version from a hash of the code. Catalog data falls back to the cached copy after 3.5 s on slow Wi-Fi.
- `assets/js/venue.js`: location parsing ("Moscone West, Level 3, Room 3016") and the walking-time model. Every number can be changed in Settings.

**Things the catalog taught us** (from Ignite 2025 and Build 2026, same platform):
- Real times arrive as `startDateTime`/`endDateTime` (UTC). The 2026 feed already contains placeholder times, all on Nov 14, and `zTest` rooms. These are ignored: only times inside the event window count.
- `TimeSlot` was Pacific time in 2025 but is UTC in 2026, so it's never used for real times.
- Repeat runs appear either as `BRK101-R1` records linked by `repeatedSessions`, or as records that share a `sessionId`. Both are grouped.

## Tests

```bash
python3 -m unittest discover -s tests                                                       # sync + Python/JS parity
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/planner.test.js   # planner (macOS)
node tests/planner.test.js                                                                  # planner (Node)
```

To try the planner on a fully published schedule, build a fixture from an archived Ignite 2025 catalog and open `http://localhost:8026/?data=tests/fixtures/ignite2025`:

```bash
python3 scripts/sync.py --from-file ignite2025.json --data-dir tests/fixtures/ignite2025 --event-window 2025-11-18:2025-11-21
```
