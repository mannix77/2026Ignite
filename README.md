# Conference Planner

An unofficial personal planner for **Microsoft Ignite 2026** (Nov 17–20, Moscone Center, San Francisco), **Gartner IT Symposium/Xpo 2026** (Oct 18–22, Swan & Dolphin, Orlando) and **AWS re:Invent 2026** (Nov 30–Dec 4, Las Vegas). Switch between them from the title bar; each keeps its own catalog, picks, notes and settings. It helps you decide quickly what to attend: when two sessions clash, or there isn't time to get from one building to another, it shows what you'd gain and lose with each choice.

> Not affiliated with Microsoft, Gartner or Amazon Web Services. Ignite data comes from the public Ignite catalog feeds, re:Invent data from the public AWS events catalog, and Gartner data from your own Conference Navigator export.

## What it does

| | |
|---|---|
| **Stays current (Ignite)** | Each time you open the app (and every 10 minutes while it's open) it checks the Ignite site directly. A GitHub Action also syncs the catalog every 30 minutes to 2 hours. It logs every addition, removal, time change and room move, and posts a summary to a GitHub issue so you get notified. |
| **Spots publication** | Ignite times and rooms aren't public yet. The sync watches for them in the data and also watches the site's own switches (`showSessionTimeSlots`, `showLocations`). It raises a 🚨 milestone as soon as they flip. |
| **Your workbook ranking** | Favorites and scores from your spreadsheet are shipped with the app (`data/<conference>/favorites.json`) and imported on first launch. A **score** outranks the Must/Want/Maybe tiers in every clash, so the plan follows your ranking. Sessions you marked “watch later” stay off the live plan on a **Watch later** list. |
| **Suggests what you missed** | From what you've picked (tracks, topics, programs, formats, speakers, vendors and the wording of titles and descriptions) it ranks the rest of the catalog: **Suggested for you** on My plan and in Browse, each with its reasons and whether it fits your plan. Triage shows the most likely ones first. |
| **Today at a glance** | Browse has day chips (*Today*, *Tomorrow*, each day) and *Next 2 hours*; sort by date & time, or by **nearest to me** when your location is known. Today's sessions show the walk from where you are and whether they fit around what you've already planned. |
| **Fast triage** | Three steps instead of rating 900 sessions one by one. **Quick start**: your role, the topics you came for, your goals (e.g. *Architecture & design*, *Executive presence & influence*), levels and formats rank the whole catalog. **By group**: *Want all* / *Skip all* on a topic, track, format, level or vendor. A skipped group is hidden in Browse and Triage but stays unrated, and a group you want keeps its sessions visible. **Shortlist**: only the best-ranked unrated sessions (100 by default), rated one at a time: swipe right for Want, left for Skip, or keys `1 2 3 0` (undo `U`, later `→`). The rest is parked, never lost. A meter shows how much of the catalog is decided. |
| **Plans around walking time** | Once times and rooms are out, it builds the best plan for each day. The day's choices are optimized exactly, and repeat runs are chosen across days. Moving between buildings costs real time: Moscone West, South, North, the Marriott Marquis and Chase Center at Ignite (badge and bag checks, keynote entry); the Dolphin, Swan, Swan Reserve and Yacht & Beach Club convention center at Gartner; the Venetian, Wynn, Caesars Palace, Caesars Forum and the MGM Grand (a shuttle ride from the rest) at re:Invent. |
| **Lunch & blocked time** | Protects a lunch break (30 min somewhere in a window: 11:30–1:30 at Ignite, 11:45–2:45 at Gartner, 11:00–2:00 at re:Invent). Meetings, booth duty or a flight can be blocked out with a location, and the plan includes walking to and from them. |
| **Makes the sacrifice obvious** | Each clash compares whole-plan outcomes: "go to X → you also make Y, Z moves to its repeat, you miss W (12 min walk, 5 min gap)". Recorded sessions are discounted ("watch later"), labs and table talks get a boost (in person only), and ties are labelled as ties. |
| **Conference-day mode** | **Now** shows where you should be, when to leave and by when you must be inside the next building. Turn on **Use my location** (GPS) or pick *I'm at…* and walking times count from where you actually are, even outside the venue. **Nearby now** lists what you can still reach in the next 90 minutes and what each would do to the rest of your day (“back for K2 at Dolphin with 12 min to spare” / “you'd miss SPS17”). A toast fires when it's time to leave, and the calendar export carries a “leave now” alarm per session so the phone nags you even with the app closed. |
| **Old export, missing sessions** | An export-based catalog (Gartner) shows a banner once it's a day old, saying who can refresh it (`export.maintainer` in `conferences.js`; colleagues' copies say "ask Minesh"). Registered for something the catalog doesn't list, like a registration-only reception? **Settings → Sessions not in the catalog** adds it to your plan with a rating, building and room, so walking time and clashes count. It stays in that device's copy, and once a fresh export lists it the planner points that out. |
| **Seat reservations** | Ignite labs, lightning talks and table talks need an RSVP (opens Oct 25, 5 PM PT); Gartner marks individual sessions as reservation-required. The plan lists which of your picks need one until you mark them **I reserved a seat**, which also pins that run into your plan. |
| **Change alerts** | Every run of every session you picked is watched. If one moves, is retitled or is cancelled, you see exactly what changed and whether it's the run you're attending. You also hear when a new run is added. |
| **Offline & portable** | Installable PWA that works on bad conference Wi-Fi. Export your plan to your calendar (`.ics`). Move picks between devices with a link or a backup file. |

Before the real Ignite schedule is published you can turn on **Preview** (Settings, or the button on My plan) to rehearse with a clearly labelled simulated schedule.

## Use it

**On your iPhone (recommended):** open the GitHub Pages address in Safari, then tap **Share → Add to Home Screen** *before* you start rating. The installed app keeps its own copy of your picks (separate from Safari's) and works offline at the venue. To move picks from another device, use **Settings → Copy link to my picks** there, then **Settings → Import picks from a link** in the installed app. **Save a backup** opens the share sheet, so you can keep a copy in Files.

**Starting preferences:** `data/<conference>/profile.json` holds your quick-start answers and group choices. It is applied once, on a device that has none saved; after that, Triage → Quick start is the place to change them. Backups include them. Copies for colleagues don't get this file.

**Switching conference:** the dropdown in the title bar, or `?conf=ignite2026` / `?conf=gartner2026` / `?conf=reinvent2026` in the address. The app remembers your last choice.

**Your workbook favorites** are imported automatically the first time you open a conference on a device with no picks. Later, **Settings → Import my workbook favorites** re-applies ratings, scores and watch-later marks (your notes are kept). The committed `favorites.json` holds only codes, tiers and scores; the version with your notes is the backup file the import script writes to `~/Downloads` (restore it with **Settings → Restore backup**, or AirDrop it to the phone and open it from Files).

**Locally:**

```bash
python3 scripts/serve.py          # http://localhost:8026, refreshes the Ignite catalog first
python3 scripts/serve.py --lan    # also reachable from your phone on the same Wi-Fi
```

Local Ignite syncs write to `.local-data/ignite2026/` (git-ignored), so they never conflict with the Action's commits. The local server only serves the app's own files. On a phone, prefer the HTTPS Pages address: offline mode needs HTTPS, and the address never changes.

No build step and no dependencies: plain HTML/CSS/JS modules plus Python 3 standard library.

## Your re:Invent favorites and reserved seats

The re:Invent catalog syncs itself from the public AWS catalog, but your favorites, reserved seats and seat availability only exist in the registration portal. Export "my favorites + my schedule" from the portal and run:

```bash
python3 scripts/import_reinvent_favorites.py ~/Downloads/reinvent2026-my-sessions-v2.json
```

It writes `data/reinvent2026/favorites.json` (reserved seats → Must, pinned to that run; favorites with seats to reserve or walk-up only → Want; full or waitlisted → Maybe) and `data/reinvent2026/seats.json` (availability, capacity and seats left per session), plus a restorable backup in `~/Downloads`. Nothing personal is published. Sessions that aren't in the public catalog (invitation-only evenings) are skipped and listed.

## Updating the Gartner agenda

Gartner has no public API (Conference Navigator needs a login), so the catalog is a normalized copy of your export. After downloading a fresh export, run:

```bash
python3 scripts/import_gartner.py ~/Downloads/gartner_sym2026_sessions.json --workbook ~/Downloads/gartner_sym2026_sessions.xlsx
```

It rewrites `data/gartner2026/sessions.json`, logs the differences in `changes.json` (shown under Changes, with your picks highlighted), regenerates `favorites.json` from the workbook's **My Favorites** sheet, and writes the backup with notes to `~/Downloads/gartner-2026-picks.json`. Commit `data/gartner2026/` and push; Pages redeploys. Private strategic-account meetings (`SM*`/`SAM*`) and CIO Circle members-only sessions are left out (`EXCLUDED_PROGRAMS` in the script).

The Ignite favorites were imported the same way from the `My Favorites` sheet of the Ignite workbook into `data/ignite2026/favorites.json` (tiers from Attend Mode, scores from Score; "Watch recording later" picks are watch-later; "Delegate"/"Skip" picks are skipped).

## Updating the re:Invent catalog

The AWS events catalog has a public API (no login), so re:Invent is a normalized copy of it, refreshed like Ignite:

```bash
python3 scripts/import_reinvent.py --fetch                                              # pull live, save a fresh snapshot, import it
python3 scripts/import_reinvent.py data/reinvent2026/source/reinvent2026_sessions.json  # re-import a saved snapshot
```

It writes `data/reinvent2026/sessions.json`, adds each change batch to `changes.json` (shown under Changes, with your picks highlighted) **and** to `changelog.md`, a readable newest-first log of every addition, removal, retiming and room move since the 2026-10-05 baseline. `--fetch` pages the catalog API 50 sessions at a time and saves the slim snapshot to `data/reinvent2026/source/` (committed so any import can be re-run; left out of the Pages site). A fetch with fewer than 90% of the previous sessions is refused and the last good data kept. If the API's `rfWidgetId`/`rfApiProfileId` stop working, take the new values from the catalog page's request to `/api/sessions` and update `scripts/import_reinvent.py`.

**Scheduled sync:** `.github/workflows/reinvent-sync.yml` runs `import_reinvent.py --fetch` every 6 hours until Nov 28, then hourly from Nov 29 through Dec 4, all in UTC (it stops itself after the event). It commits only when the catalog changed, posts the summary to the **re:Invent 2026 catalog changes** issue (label `reinvent-changes`; subscribe to be notified), and asks the Ignite workflow to redeploy Pages. It's a separate workflow, so a re:Invent failure never blocks the Ignite sync or the deploy; a failed run goes red and keeps the last good data. A refresh that loses most session times or rooms (usually a renamed feed field) is refused the same way; if the loss is real, run `import_reinvent.py --fetch --allow-withdrawal` by hand.

re:Invent specifics:
- Each run is its own record: `ANT319-R` and `ANT319-R1` (or `SEC309` and `SEC309-R1`) are one group; `[REPEAT]` is stripped from titles. Sponsored sessions (`-S`, `-S-R…` or the "Sponsored" tag) list the sponsor as a vendor.
- Every scheduled session uses reserved seating (opened Oct 6, 9:00 AM PT): reserve in the re:Invent portal, then tap **I reserved a seat**. The 8 self-paced `GHJ*` gamified sessions have no slot.
- Breakouts are *assumed* to be recorded (AWS posts them to YouTube); chalk talks, workshops, builders' sessions and the other interactive formats are not.
- Rooms look like `MGM Grand | Level 1 | Grand 122`, with two more segments for Content Hub and Expo theaters. Walking/shuttle minutes between the Venetian, Wynn, Caesars Palace, Caesars Forum and MGM Grand are editable estimates (MGM to anywhere north: ~35 min by shuttle).
- **Keynotes aren't in the AWS catalog.** Until AWS publishes them, block the time out in **Settings → Lunch & blocked time**. Once times are known, add each to `data/reinvent2026/keynotes.json` (code, title, start and end in UTC, room) and re-run the importer; entries without real times are skipped. Don't guess times.

## Copies for colleagues

The deploy publishes the app once at the site root and once per folder under `instances/` — `instances/gino/` becomes `https://mannix77.github.io/2026Ignite/gino/`. A copy has the same catalogs and updates but its own picks, notes and settings (storage is namespaced, so even a phone with both installed keeps them apart) and no pre-loaded favorites. Anything in `instances/<name>/data/` is laid over the copy, so a colleague can ship their own `data/<conference>/favorites.json` (build it with `scripts/import_gartner.py … --favorites-only --favorites-out instances/<name>/data/gartner2026/favorites.json`). Add a folder, commit, and the next deploy publishes it. A file `instances/<name>/conference` holding a conference id (`ignite2026`, `gartner2026` or `reinvent2026`; the deploy rejects anything else) makes the copy open on that conference by default; Gino's opens on Gartner. To change the app itself, fork the repo and enable Pages on the fork.

## One-time GitHub setup

1. Push this repo to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions → "Sync Ignite catalog & deploy" → Run workflow** (or wait for the schedule). The app is published at `https://<user>.github.io/<repo>/`.
4. To get notified, **watch** the repo or subscribe to the "Ignite 2026 catalog changes" issue the workflow opens.
5. Optional: in the app, **Settings → Copy watchlist**, then paste the result into `data/ignite2026/watchlist.json`. Changes to those sessions get a ⭐ and are listed first.

## How it works

```
Ignite catalog API ─┐                        ┌─> data/ignite2026/sessions.json  (normalized catalog, committed)
CDN fallback copy ──┼─> scripts/sync.py ─────┼─> data/ignite2026/changes.json   (change log, committed)
site settings ──────┘   (GitHub Action)      ├─> data/ignite2026/meta.json      (status, deployed only)
                                             └─> issue comment                  (notification)

Conference Navigator export ─> scripts/import_gartner.py ─> data/gartner2026/{sessions,changes,favorites}.json

AWS events catalog API ─┐                             ┌─> data/reinvent2026/sessions.json  (normalized catalog, committed)
  (or a saved snapshot) ├─> scripts/import_reinvent.py ┼─> data/reinvent2026/changes.json   (change log for the app)
keynotes.json (by hand) ┘                             ├─> data/reinvent2026/changelog.md   (readable change log)
                                                      └─> data/reinvent2026/source/*.json  (slim snapshot, --fetch)

Browser ── data/<conference>/*.json (snapshot + history + favorites)
        └─ CDN fallback copy (Ignite live check, CORS-enabled) ── assets/js/live.js
```

- `assets/js/conferences.js`: the conference definitions (days, timezone, data folder, venue model, lunch window, where seats are reserved). Adding a conference means adding an entry here plus a `data/<id>/` folder in the same shape.
- `scripts/sync.py`: fetches the CDN copy the official Ignite site uses (falling back to the API), normalizes it, diffs it against the last snapshot by run, and records milestones. It refuses to overwrite good data with a partial catalog, and records any failure in `meta.json` instead of failing silently. `changedAt` only moves when something the app shows changed.
- `assets/js/live.js`: the same normalization in the browser, against the CDN copy. `tests/test_sync.py` checks that the Python and JS versions produce identical output, including on malformed records.
- `assets/js/planner.js`: travel-aware conflict detection, the optimizer (exact per day with the lunch break as part of the search; repeat runs chosen exhaustively when few, by coordinate descent otherwise), whole-plan what-if comparisons and free-slot fillers. A randomized test checks it against brute force.
- `assets/js/profile.js`: preferences. Each conference's roles (Gartner roles map to tracks: our call, since Gartner publishes no role agendas), goal keywords, group facets and ranking signals (keynotes and Signature Series, executive speakers, Gartner analysts, vendor-led sessions). `evaluate` scores a session and says whether your choices hide it; `partition` splits the catalog into rated, hidden, shortlist and parked.
- `assets/js/suggest.js`: the recommender. It builds an interest profile from your picks, weighted by score, and scores every unrated session against it (tracks, topics, programs, formats, speakers, vendors and TF-IDF cosine similarity of the text).
- `sw.js`: offline support. The app shell installs atomically per version; CI stamps the version from a hash of the code. Catalog data falls back to the cached copy after 3.5 s on slow Wi-Fi and tells the page when the fresh copy lands.
- Location: each building has coordinates; a GPS fix snaps to the nearest building (within its radius), otherwise the extra minutes to reach it are added to every walk. Location is only read while the app is open and never leaves the device.
- `assets/js/venue.js`: location parsing ("Moscone West, Level 3, Room 3016", "Stage 1, IT Xpo, Atlantic Hall, WDW Dolphin Hotel") and the walking-time model. Every number can be changed in Settings. The Swan & Dolphin numbers come from the hotels' floor plans, measured routes and attendee reports; treat them as estimates until you've walked them. The Las Vegas ones (`LAS_VEGAS_DEF` in `conferences.js`) are estimates too, coordinates included.

**Things the Ignite catalog taught us** (from Ignite 2025 and Build 2026, same platform):
- Real times arrive as `startDateTime`/`endDateTime` (UTC). The 2026 feed already contains placeholder times, all on Nov 14, and `zTest` rooms. These are ignored: only times inside the event window count.
- `TimeSlot` was Pacific time in 2025 but is UTC in 2026, so it's never used for real times.
- Repeat runs appear either as `BRK101-R1` records linked by `repeatedSessions`, or as records that share a `sessionId`. Both are grouped.

**Gartner specifics:** times and rooms are final in the export (`America/New_York`). Keynotes, Signature Series and track sessions are assumed to be replayable; Xpo stage talks, roundtables, workshops and clinics are not. Sessions with the same title and type under different codes (clinics, repeated roundtables) are treated as repeat runs.

## Tests

```bash
npm test                                                                                    # everything below
node tests/robustness.test.js                                                               # malformed data, storage failures, big clashes
node tests/profile.test.js                                                                  # preferences (specs/features/rating-preferences.feature)
node tests/catalog.test.js                                                                  # old exports, added sessions (specs/features/catalog-gaps.feature)
python3 -m unittest discover -s tests                                                       # sync, Gartner import + Python/JS parity
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/planner.test.js   # planner (macOS)
node tests/planner.test.js                                                                  # planner (Node)
```

To try the planner on a fully published schedule, build a fixture from an archived Ignite 2025 catalog and open `http://localhost:8026/?data=tests/fixtures/ignite2025`:

```bash
python3 scripts/sync.py --from-file ignite2025.json --data-dir tests/fixtures/ignite2025 --event-window 2025-11-18:2025-11-21
```
