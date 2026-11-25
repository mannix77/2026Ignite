# Session Planner: App Store submission

Everything App Store Connect asks for, ready to paste. Items marked **YOU** need a decision or
a detail only the account holder has.

## Before anything else

1. **A paid Apple Developer Program team (YOU).** A free Personal Team cannot upload to
   TestFlight or the App Store. Decide which paid team publishes the app; it becomes the
   seller name shown on the store.
2. **Bundle ID.** The project uses `us.mannix.sessionplanner`. Register it under the
   chosen team (Xcode does this on the first signed archive). Change it in the project first if
   the team wants its own prefix; it cannot be changed after the first upload.
3. **Privacy and support pages must be live.** They are `ios/AppStore/privacy.html` and
   `ios/AppStore/support.html`. `.github/workflows/pages.yml` publishes those two files (and
   nothing else) on every change to them on `main`, at the URLs below. Check both open before
   submitting.

## App information

| Field | Value |
| --- | --- |
| Name (30) | PersonalSessionManager |
| Subtitle (30) | Your conference, as a calendar |
| Primary category | Productivity |
| Secondary category | Business |
| Content rights | **YOU** declare this. The app shows third-party content (AWS's session catalog and the attendee's schedule), so answer **Yes, it contains, shows or accesses third-party content**, and confirm you have the rights to use it. The basis is AWS's public developer guide, which documents the API for third-party apps (linked in the reviewer notes). Reading the content through a public API does not make it your own content |
| Age rating | 4+ (answer "None" to every content question; "No" to unrestricted web access: the only web page is AWS's sign-in) |
| Privacy Policy URL | https://mannix77.github.io/2026Ignite/ios/AppStore/privacy.html |
| Support URL | https://mannix77.github.io/2026Ignite/ios/AppStore/support.html |
| Marketing URL | leave empty |
| Copyright | **YOU**: `2026 <name of the person or company that owns the app>` |
| Price | Free |
| Availability | All countries, or the United States only if you prefer a narrow first release |

The App Store name is "PersonalSessionManager", the name the app record was created with
("Session Planner" was not available). The name under the icon on the phone, and in the app's
own screens, is still "Session Planner". Apple expects the two to be recognisably the same app
(guideline 2.3.8); if a reviewer objects, either rename the app record or change the display
name in the project (`INFOPLIST_KEY_CFBundleDisplayName`) and upload a new build.

## Version information (1.2)

Submitted for review on 2026-11-24 with build 7. The promotional text and keywords are unchanged from 1.1. The description changes for 1.2: it adds Apple Intelligence, session preferences and walk-ins, and "No analytics" gives way to the optional diagnostics line. Version 1.1.1 was never created in App Store Connect, so 1.2 follows 1.1 there and its What's New includes 1.1.1's fix.

**Promotional text (170)**

See your AWS re:Invent reserved seats, invitations and favorites as one clear calendar, with a warning when two sessions are too far apart to walk between.

**Description (4000)**

Session Planner turns your AWS re:Invent schedule into a calendar you can read at a glance.

Sign in once with your AWS Builder ID and the app shows what the conference site already holds for you: the seats you have reserved, the sessions you were invited to, and your favorites. There is nothing to enter twice.

A CALENDAR, NOT A LIST
• Each day is a timeline with your reserved and invited sessions as blocks.
• Sessions that overlap sit side by side, so a clash is obvious.
• Each reserved seat shows when to be there, 10 minutes before it starts.
• Favorites stay out of the way until you ask for them, then appear as one marker per hour that opens the list. A favorite you can't reserve can go on your calendar as a walk-in.
• Swipe left or right to move between days; the selected day is easy to spot in light and dark mode.

FILL A GAP IN YOUR DAY
• Free stretches of 30 minutes or more show on the calendar. Tap one to see the sessions you could still make there, allowing for the walk and the time you set to get in line, most like the ones you picked first, with whether there is a seat to reserve or a walk-up line.
• On an iPhone with Apple Intelligence, the on-device model puts the best of them first, with a one-line reason for each.
• In Settings, choose the levels and formats you prefer to move them up, and the formats you skip to leave them out.

KNOW WHEN A WALK IS TOO TIGHT
• The app warns you when two sessions in different venues are less than 30 minutes apart.

YOUR SESSIONS IN APPLE CALENDAR (OPTIONAL)
• Turn on "Add reserved sessions to Calendar" in Settings and your reserved sessions go into a calendar of their own, kept up to date as your schedule changes, next to your other events and alerts. It is off until you turn it on, and the app only ever changes the events it made.

FIND AND CHANGE SESSIONS
• Search the whole catalog by code, title, speaker or topic.
• See only your own sessions, or only sessions that still have seats.
• Add or remove a favorite, reserve a seat, or cancel a reservation. Every change is made on the conference site itself, and the app then shows what the site says.

WORKS WITHOUT A CONNECTION
• Your calendar is saved on the phone, so it opens in a crowded hall with no signal. Update when you are back online.

PRIVATE BY DESIGN
• You sign in on AWS's own page. The app never sees your password.
• Your sign-in is kept in the iPhone's keychain, on this device only.
• No ads, no tracking, and no server of the developer's.
• Diagnostics are off unless you choose to share them: then what Apple Intelligence was given and its answer are sent to a diagnostics service, with no sign-in, name or email. Change it any time in Settings.
• Readable at every text size, including the largest accessibility sizes.

TRY IT FIRST
• No Builder ID? Choose "Try the sample conference" to explore every screen with made-up sessions.

Requires an AWS Builder ID registered for the event to show a real schedule. Session information is provided by the AWS Events API. Session Planner is an independent app and is not affiliated with, sponsored by or endorsed by Amazon Web Services. AWS and re:Invent are trademarks of Amazon.com, Inc. or its affiliates.

**Keywords (100)**

```
conference,schedule,calendar,sessions,agenda,planner,events,reserve,favorites,attendee,workshop
```

No AWS or re:Invent trademark is used in the name, subtitle or keywords on purpose: Apple
rejects other companies' trademarks there (guideline 2.3.7). They appear only in the
description, descriptively, with the trademark line.

**What's New (1.2)**

```
• Apple Intelligence: on iPhones that have it, the sessions that fit a free stretch are ranked on the device, best first, with a one-line reason for each.
• Session preferences: choose the levels and formats you prefer, and the formats you skip.
• Suggestions leave time to get in line, not just to walk; set how long in Settings.
• Walk-ins: put a favorite you can't reserve on your calendar, and see when to be at each reserved seat.
• Full sessions are marked full, and the calendar shows how recently it updated.
• On the day itself, free stretches start at the current time.
• Optional diagnostics: share how suggestions work, only if you choose to.
```

**What's New (1.1.1)** (built as build 4 and in TestFlight, never submitted)

```
• On the day itself, free stretches start at the current time, so every session offered is one you can still make.
```

**What's New (1.1)**

```
• Fill a gap: free stretches on the calendar now show the sessions you could still make there, most like your picks first.
• Apple Calendar: optionally add your reserved sessions to a calendar of their own, kept up to date as your schedule changes.
• Swipe left or right to change day.
• The selected day stands out clearly, and the hours stay readable at the largest text sizes.
```

(1.0: First release.)

## Screenshots

In `ios/AppStore/screenshots/`, taken on the iPhone 6.9" simulator with the sample conference
(no real schedule, names or sessions appear). Upload them in this order to the 6.9" slot; App
Store Connect scales them for smaller iPhones.

1. `1-calendar.png`: the day as a calendar, with a venue-change warning, favorites and a free stretch
2. `2-day.png`: a quieter day with two free stretches and favorites
3. `3-session.png`: a session with reserve and favorite
4. `4-sessions.png`: the session list with search and "Seats open"
5. `5-settings.png`: counts, update, the Apple Calendar setting, account and privacy
6. `6-suggestions.png` (new in 1.1): the sessions that fit a free stretch, with what they share and how to get in

Retaken for 1.1 on the iPhone 18 Pro Max simulator (1320 × 2868), flattened (no alpha).

The app is iPhone only, so no iPad screenshots are needed.

To retake them, build the Debug configuration for a 6.9" simulator, install it, and launch it
with staging arguments (debug builds only; a release build ignores them), then capture:

```sh
xcrun simctl status_bar <device> override --time "9:41" --batteryState charged --batteryLevel 100
xcrun simctl launch <device> us.mannix.sessionplanner -mode demo -showFavorites YES \
    -shotTab calendar -shotDay 2027-03-10
xcrun simctl io <device> screenshot 1-calendar.png
```

The others use `-shotDay 2027-03-09`; `-shotTab sessions -shotSession demo-104`;
`-shotTab sessions -shotFilter "Seats open"`; `-shotTab settings`; and for the sixth
`-shotDay 2027-03-09 -shotGap 2027-03-09`, which opens that day's first free stretch. Boot the
simulator and let it settle (one plain launch first) before capturing, or the first shot can
catch the home screen. Simulator screenshots
carry an alpha channel, which App Store Connect refuses: flatten them before uploading.

## App Privacy ("nutrition label")

**Changes in 1.2** (#193): with the attendee's yes, the app sends Honeycomb one event per
Apple Intelligence ranking. Opt-in still counts as collection (Apple's "optional disclosure"
exception needs the user to choose it each time, which this doesn't), so the label changes from
"Data Not Collected". Answer in App Store Connect, App Privacy:

1. "Do you or your third-party partners collect data from this app?" **Yes.**
2. Data types, tick exactly these five:
   - **Identifiers > Device ID** (the random install id)
   - **User Content > Other User Content** (the profile summary and the model's answer)
   - **Usage Data > Product Interaction**
   - **Diagnostics > Performance Data**
   - **Diagnostics > Other Diagnostic Data**
3. For each of the five:
   - Purposes: **Analytics** only.
   - "Is this data linked to the user's identity?" **Yes.**
   - "Is this data used for tracking purposes?" **No.**

The result: "Data Linked to You: Identifiers, User Content, Usage Data, Diagnostics". Nothing under
"Data Used to Track You".

What an event really holds (`EventLog.fields` in `ios/PlannerCore/Sources/PlannerCore/EventLog.swift`,
asserted field by field in `EventLogTests`): the event name `suggest.model`, the app's version and
build, a random install id, the outcome (`ok`, `unavailable` with Apple's reason, `timeout`,
`refused`, ...), the model step's duration in milliseconds, the prompt's estimated tokens, window,
reserve and headroom, sessions in the time slot, sent, left out and abstracts cut, the profile's
token count and number of interests, whether levels and formats came from Settings, were inferred
or were absent, whether there were skipped formats and reserved sessions that day (yes/no), the
model's own token counts, how many sessions it placed and how many entries were ignored, and
whether the answer was remembered. When the model was asked (not for a remembered answer), also
`model.prompt`, the exact text it was given, and `model.answer`, its answer as JSON
(`[{"code":…,"reason":…}]`), each cut to 32,000 bytes (owner's decision, 2026-11-24). The prompt
holds the instructions, the catalog sessions that fit the free time (code, title, format, level,
venue, time, topics, abstract cut to 300 characters) and the profile: preferred levels and formats
(from Settings or inferred from his picks), skipped formats, up to 15 interests (topics and AWS services
his reserved and favorite sessions share, each with how many of them have it) and how many sessions he reserved that day. Not his list of reserved or favorite sessions (a favorite
that fits the free time is listed like any other session, not marked), personal time, sign-in,
name or email.

Why these answers:
- Duration is Performance Data; outcomes and failure reasons are Other Diagnostic Data; counts of
  what the ranking did each time a free stretch is opened are Product Interaction. The profile
  summary (his preferences and interests) and the model's answer about him are Other User Content.
- **Identifiers > Device ID, and linked** (owner's decision, 2026-11-25, after CodeRabbit's review
  of #201): the install id is saved on the phone and sent with every event until reset or "Don't
  share", so all of one install's events are tied together through that device, which Apple's
  definitions count as an identifier and as linked. It is still never joined with the AWS sign-in,
  a name or an email, and the user can reset it.
- **Not tracking**: nothing is combined with other companies' data or used for advertising.

The bundled privacy manifest (`PrivacyInfo.xcprivacy`) declares the same five types, linked, not
tracking, purpose Analytics, plus UserDefaults for the app's own settings.

Up to 1.1.1 the answer was "No, we do not collect data from this app" ("Data Not Collected"):
the developer has no server, and the app sends the user's requests straight to AWS on the user's
instruction, using the user's own sign-in.

### Honeycomb setup (owner)

- **Key**: in Honeycomb, in the environment's API keys, create an **Ingest** key (send events
  only; it can't read or configure). Pass it at build time:
  `HONEYCOMB_KEY=<ingest key> TEAM=... BUILD=6 UPLOAD=1 ios/AppStore/archive.sh`. Anyone can pull it
  out of the app, which is why it must be an ingest key; revoke and replace it if it's abused.
  A build without `HONEYCOMB_KEY` neither asks nor sends.
- **Dataset**: `session-planner` unless `HONEYCOMB_DATASET` says otherwise. Honeycomb creates it
  with the first event.
- **Retention**: Honeycomb's docs say events have a **fixed 60-day retention**, with no setting
  to change it in the UI (docs.honeycomb.io, "How Honeycomb calculates usage": "Events and logs:
  60-day fixed retention"; the dataset's Overview tab shows "Events Retention and Usage" as
  information only). So there is nothing to set for "90 days": 60 is within it, and the privacy
  policy promises "at most 90 days". Check the dataset's Overview tab says 60 days. A different
  period can only be arranged through Honeycomb Support.
- **Early deletion**: Environments > (environment) > Manage Data > Datasets > `session-planner`
  > Delete (Team Owner, Deletion Protection off) deletes every event.
- **How often the model is used**: in the dataset, a query with WHERE `name = suggest.model`,
  `remembered = false`, `outcome` not in `unavailable`, `nothingToRank`, `promptTooLong`
  (a list closed before the model was asked is `cancelled` with no `model.prompt`; add
  `model.prompt exists` to leave those out);
  VISUALIZE `COUNT` and `COUNT_DISTINCT(install_id)`; time granularity 1 day (or 1 hour). That is
  model calls per day and phones using it; GROUP BY `outcome` splits successes from failures, and
  dropping the `remembered` filter adds how often a ranked list was looked at again. A second list
  asking the same prompt while the first is still waiting shares that request and also sends
  `remembered = false`, so this slightly overcounts. Each
  `model.prompt` and `model.answer` is in the event's raw data (click a row, or GROUP BY
  `install_id` to follow one phone).
- **Sampling**: none; every event is sent. A handful per attendee per day, plus one
  `remembered=true` event a minute while a ranked free stretch stays open (filter on
  `remembered = false` to count model calls). A phone that can't run the model sends one
  `outcome=unavailable` event per launch, when a free stretch is first opened.
- **A leftover key file**: if `archive.sh` is killed before it finishes, delete
  `ios/SessionPlanner/Honeycomb.plist` by hand, or Xcode's own builds will carry the real key.

## Export compliance

The app uses only the operating system's standard encryption (HTTPS, and SHA-256 for sign-in).
`ITSAppUsesNonExemptEncryption` is already set to `NO` in the build, so App Store Connect will
not ask.

## App Review information

| Field | Value |
| --- | --- |
| Sign-in required | **No** to try the sample conference. The "Add reserved sessions to Calendar" setting requires a registered attendee account. Apple decides whether to accept the sample in place of a demo account (see "No test account" and "Calendar permission" under risks). |
| Contact first name, last name, phone, email | **YOU** |

**Notes for the reviewer** (paste as is; APPLE INTELLIGENCE and DIAGNOSTICS are new in 1.2, APPLE CALENDAR in 1.1)

```
Session Planner shows an attendee's AWS re:Invent schedule as a calendar.

HOW TO REVIEW WITHOUT AN ACCOUNT
On the first screen, tap "Try the sample conference". This loads a made-up conference stored
in the app. Without an account or network, you can try the in-app calendar, swiping between days,
favorites, the venue-change warning (open Wed 10), the free stretches and the sessions that fit
them (tap "Free 9:00 – 11:00 AM" on Tue 9), search and filters, session details, adding and removing
a favorite, reserving a seat (try ARC420 to see a refused clash, SEC220 to see a success) and
cancelling a reservation. The "Add reserved sessions to Calendar" setting is disabled in the
sample conference (see APPLE CALENDAR below).

APPLE INTELLIGENCE (new in 1.2)
On an iPhone with Apple Intelligence turned on, opening a free stretch (in the sample conference
too) asks Apple's on-device model to rank the sessions that fit; the ones it ranks move to the
top with a one-line reason each. Without Apple Intelligence the list keeps its usual order. It
runs on the device and changes nothing on the conference site.

ABOUT SIGN-IN
"Sign in with AWS Builder ID" is for people registered for the event. A Builder ID that is not
registered for re:Invent 2026 can sign in but AWS will not return a schedule, so we cannot give
you a working test account: registration is a paid conference pass tied to a person.

Sign-in uses Amazon Web Services' public AWS Events API, which is documented for third-party
apps at https://docs.aws.amazon.com/events/latest/devguide/what-is-events-api.html . AWS
publishes a shared public client ID for this purpose and states that an application may be
distributed to attendees as long as it signs them in on their own device, which this app does.
The app opens AWS's own sign-in page in a system authentication sheet, never sees the password,
and stores the resulting token in the keychain.

APPLE CALENDAR (new in 1.1)
Settings > "Add reserved sessions to Calendar" is off by default. When turned on it asks for
Calendar access and writes the signed-in attendee's reserved sessions into a calendar of their
own, kept up to date. Full access (not write-only) is needed because the app must find its own
events again to move or remove them when a session changes or is cancelled; it never changes
any other event. The setting needs a signed-in attendee, so it is disabled in the sample
conference and cannot be exercised without a registered account; the usage text is shown
before access is requested.

DIAGNOSTICS (new in 1.2)
On first open the app asks "Share how suggestions work?". Nothing is sent unless you choose
Share. With Share, each time Apple Intelligence ranks the suggestions for a free stretch, the
app sends Honeycomb (a diagnostics service) the text Apple Intelligence was given (catalog
sessions and a short profile of interests and preferences), its answer, the outcome, duration and
counts, with the app version and a random install id: no sign-in, name, email, personal time or
typed text. Settings > Diagnostics changes the answer and resets the install id. It is described
in the privacy policy.

The app is independent. It is not affiliated with, sponsored by or endorsed by Amazon Web
Services, and says so on its first screen and in Settings. It has no ads, tracking or server
of its own.
```

## Risks to expect in review

- **Third-party sign-in and data (5.2.2, 5.2.3).** The reviewer may ask for proof that the app
  may use AWS's service. The answer is the public developer guide linked in the notes. If they
  insist on written permission from AWS, that would have to be requested from AWS.
- **No test account (2.1).** Not settled by the sample conference alone. Guideline 2.1 accepts a
  built-in demo mode in place of a demo account only with Apple's prior approval, and this app
  has not asked for or been given that approval. The reviewer notes explain why no account can
  be supplied and point to the sample conference, which is the request for that approval; Apple
  may accept it, ask for credentials anyway, or reject. If asked, reply with the "About sign-in"
  paragraph and ask for the demo mode to be accepted.
- **Trademarks (2.3.7, 5.2.1).** Kept out of the name, subtitle, keywords and icon.
- **Sign in with Apple (4.8).** Not required: the app offers a single sign-in that is the
  service's own account system, with no third-party social login offered by the app itself.
- **Calendar permission without a way to try it (5.1.1, 2.1), new in 1.1.** The reviewer can
  see the permission text but cannot turn the feature on without a registered account. The
  notes explain this. If Apple asks to see it working, the options are a screen recording made
  on a signed-in phone, or allowing the setting in the sample conference (a code change).
- **Usefulness outside the event (4.2).** The app is for one event's attendees. The sample
  conference shows the planning workflow; say so if asked.

## Building and uploading

`ios/AppStore/archive.sh` builds the release archive and, when given a paid team, exports it
for the App Store. Uploading is a separate, explicit step, so nothing reaches Apple by accident.

```sh
ios/AppStore/archive.sh                          # unsigned archive: checks the release build
TEAM=ABCDE12345 ios/AppStore/archive.sh          # signed .ipa in ios/build/export, nothing uploaded
TEAM=ABCDE12345 UPLOAD=1 ios/AppStore/archive.sh # signed and uploaded to App Store Connect
```

`TEAM` is the 10-character id of the paid team (Xcode > Settings > Accounts shows it). It is
passed on the command line so it is never written into the project file in this public
repository. With a free Personal Team the archive step works and the export stops with
"does not have permission to create iOS App Store provisioning profiles".

Before the first upload, create the app record in App Store Connect (My Apps > New App) with
the bundle ID. Without it the upload fails with "App record ... not found".

After the upload, in App Store Connect: fill in the fields from this page, add the screenshots,
pick the processed build, and press Submit for Review.

Before each upload, raise the build number (`BUILD=3 TEAM=... UPLOAD=1 ios/AppStore/archive.sh`
overrides `CURRENT_PROJECT_VERSION` without editing the project); Apple refuses a build number
it has already seen for the same version.

From 1.2, add `HONEYCOMB_KEY=...` (and `HONEYCOMB_DATASET=...` if not `session-planner`) to a
release build that should be able to send diagnostics (see "Honeycomb setup").

## Xcode Cloud

Xcode Cloud builds the app on Apple's machines, as an alternative to `archive.sh` on a Mac. The
membership includes 25 compute hours a month, and unused hours don't carry over. A release
archive takes minutes, so the free hours are plenty. It runs two workflows:

| Workflow | Starts | Does | Uploads |
| --- | --- | --- | --- |
| **PR checks** | every pull request to `main`, and every push to `main` | Build (iOS, scheme `SessionPlanner`), then `swift test` on PlannerCore | nothing |
| **TestFlight** | only by hand (Start Build) | Archive with the Honeycomb key, then internal TestFlight | to TestFlight, when the owner starts it |

Uploading stays the owner's decision each time (`CLAUDE.md`): the TestFlight workflow never
starts on its own, and submitting for review is still done in App Store Connect. GitHub
Actions (`.github/workflows/ios-tests.yml`) keeps running as before.

What lives in the repository:
- `ios/SessionPlanner.xcodeproj/xcshareddata/xcschemes/SessionPlanner.xcscheme`: the shared
  scheme. Xcode Cloud builds only shared schemes.
- `ios/ci_scripts/ci_pre_xcodebuild.sh`: for an archive, writes `ios/SessionPlanner/Honeycomb.plist`
  from the workflow's secret `HONEYCOMB_KEY`, as `archive.sh` does. Without the key the build
  neither asks nor sends. It refuses a key with a space or control character in it.
- `ios/ci_scripts/ci_post_xcodebuild.sh`: after a successful Build action, runs
  `swift test --package-path ios/PlannerCore`. After an archive, it removes the key file.

The workflows themselves live in App Store Connect, not in the repository. Set them up once.
This needs the Account Holder or an Admin:

1. **Connect.** In Xcode, open `ios/SessionPlanner.xcodeproj` and choose Product > Xcode Cloud >
   Create Workflow. Pick the `SessionPlanner` product and the PersonalSessionManager app. When asked,
   let Xcode Cloud reach GitHub, and install Apple's GitHub app on `mannix77/2026Ignite` only.
   Signing is managed in the cloud with the team in Xcode (your own, never the company team).
2. **PR checks workflow.**
   - Start conditions: Pull Request Changes, target branch `main`; and Branch Changes, `main`.
   - Action: Build, platform iOS, scheme `SessionPlanner`. No post-actions.
3. **TestFlight workflow.**
   - Start condition: Tag Changes with a pattern no tag uses, such as `xcode-cloud-testflight/*`,
     so it never starts by itself. Start it with Start Build in Xcode or App Store Connect.
   - Action: Archive, platform iOS, scheme `SessionPlanner`, deployment preparation "TestFlight and
     App Store".
   - Post-action: TestFlight Internal Testing, group "Internal".
   - Environment > Environment Variables:
     - `HONEYCOMB_KEY`: the ingest key, with **Secret** ticked (masked in logs).
     - `HONEYCOMB_DATASET`: `session-planner`.
4. **Build number.** In App Store Connect: the app > Xcode Cloud > Settings > Build Number >
   Edit Next Build Number. Set it to **7**. Builds 5 and 6 already exist for 1.2, and Xcode Cloud
   otherwise starts at 1. From then on Xcode Cloud numbers each build itself, so `BUILD=` isn't
   needed. The version (1.2) still comes from the project. If you also build with `archive.sh`,
   pass a `BUILD=` above Xcode Cloud's latest number for that version, or the upload is refused.
5. **Check.** Start the TestFlight workflow once. The archive log should say "Honeycomb key
   included", and the build should appear under TestFlight with the next number.

## After approval

- The version string is `1.1.1` (build 4) for the third release; `1.1` (build 3) was the
  second and `1.0` (builds 1–2) the first. Use `1.1.2` and up for fixes, and raise the build
  number for every upload.
- re:Invent 2026 runs 30 November to 4 December 2026. Review usually takes one to three days
  but can take longer, and is not guaranteed before the event. TestFlight internal testing
  (your own team's Apple IDs) needs no review and is the dependable route for that week.
