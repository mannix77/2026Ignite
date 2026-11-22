# Session Planner

A native iPhone app that shows an attendee's **AWS re:Invent** schedule as a calendar: the
seats they reserved, the sessions they were invited to, and their favorites, with a warning
when two sessions are too far apart to walk between. On the App Store it is listed as
**PersonalSessionManager**; under the icon it is "Session Planner".

> Independent. Not affiliated with, sponsored by or endorsed by Amazon Web Services.

The app signs in on the phone with an AWS Builder ID and talks only to the public
[AWS Events API](https://docs.aws.amazon.com/events/latest/devguide/what-is-events-api.html).
There is no server of its own, no analytics and no tracking.

## What is in this repository

| Path | What it is |
| --- | --- |
| `ios/SessionPlanner/` | The SwiftUI app: screens, sign-in (loopback listener, keychain), app model |
| `ios/PlannerCore/` | A Swift package with everything that can be tested without a phone: the API client, OAuth, the agenda and calendar layout, filters, wording, the saved-calendar ledger, and the sample conference |
| `ios/AppStore/` | Listing text, reviewer notes, the support and privacy pages, and `archive.sh` (build, sign, upload). Start with `ios/AppStore/README.md` |
| `specs/features/ios-app.feature` | What the app must do, as rules and examples |
| `archive/` | Past conference selections, kept for reference (see below) |
| `.github/workflows/ios-tests.yml` | Runs the Swift tests and a simulator build when `ios/` changes |
| `.github/workflows/pages.yml` | Publishes the support and privacy pages the App Store listing links to |

## Build and test

Requires Xcode 27 or later.

```sh
swift test --package-path ios/PlannerCore
```

```sh
xcodebuild -project ios/SessionPlanner.xcodeproj -scheme SessionPlanner -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

If `xcode-select` points at the Command Line Tools, prefix either command with
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

The tests cover `PlannerCore` only. The screens, the sign-in sheet and the keychain code in
`ios/SessionPlanner/` are checked by hand in the simulator or on a phone. The app can be
explored without an account: choose **Try the sample conference** on the first screen.

Signing and uploading are described in `ios/AppStore/README.md`. The signing team is passed
on the command line (`TEAM=... ios/AppStore/archive.sh`) and is never written into the project.

## Support and privacy pages

The App Store listing links to these two addresses, so they must keep working:

- https://mannix77.github.io/2026Ignite/ios/AppStore/support.html
- https://mannix77.github.io/2026Ignite/ios/AppStore/privacy.html

`pages.yml` publishes exactly those two files and nothing else. Renaming the repository or
moving the files changes the addresses and breaks the listing.

## The archive

Until November 2026 this repository held a web planner for Microsoft Ignite, Gartner IT
Symposium/Xpo and AWS re:Invent. It was retired when the iPhone app replaced it. Its code,
tests and catalog history are in the git history (the last commit with the web planner is the
parent of the one that added this section). What was kept:

- `archive/my-selections.md`: a readable list of the sessions selected at each conference,
  with the **watch later** lists first.
- `archive/<conference>/favorites.json`: the selections as the planner saved them (session id,
  code, priority 3 = Must, 2 = Want, 1 = Maybe, and `"mode": "watch"` for watch later).
- `archive/<conference>/sessions.json`: the last synced catalog for that conference, so a
  selection's title, time, room and speakers can be looked up by id.

These are snapshots from when each file was last exported, not a live record, and nothing in
the app reads them. They are not published on the site.
