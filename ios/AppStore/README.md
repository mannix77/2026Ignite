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

## Version information (1.1)

**Promotional text (170)**

See your AWS re:Invent reserved seats, invitations and favorites as one clear calendar, with a warning when two sessions are too far apart to walk between.

**Description (4000)**

Session Planner turns your AWS re:Invent schedule into a calendar you can read at a glance.

Sign in once with your AWS Builder ID and the app shows what the conference site already holds for you: the seats you have reserved, the sessions you were invited to, and your favorites. There is nothing to enter twice.

A CALENDAR, NOT A LIST
• Each day is a timeline with your reserved and invited sessions as blocks.
• Sessions that overlap sit side by side, so a clash is obvious.
• Favorites stay out of the way until you ask for them, then appear as one marker per hour that opens the list.

• Swipe left or right to move between days; the selected day is easy to spot in light and dark mode.

FILL A GAP IN YOUR DAY
• Free stretches of 30 minutes or more show on the calendar. Tap one to see the sessions you could still make there, most like the ones you picked first, with what they share with your picks and whether there is a seat to reserve or a walk-up line.

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
• No analytics, no ads, no tracking, and no server of the developer's.
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

Answer **"No, we do not collect data from this app."** The result is "Data Not Collected".
Unchanged in 1.1: the Apple Calendar copy is written on the phone into the user's own Calendar
account and is never sent to the developer.

Why that is accurate: the developer has no server and receives nothing. The app sends the
user's requests straight to AWS, on the user's instruction, using the user's own sign-in.
Apple's definition of "collect" is data transmitted off the device to the developer or its
partners in a way that lets them access it for longer than needed to service the request,
which does not happen here. The bundled privacy manifest (`PrivacyInfo.xcprivacy`) says the
same: no tracking, no collected data, and UserDefaults used for the app's own settings.

## Export compliance

The app uses only the operating system's standard encryption (HTTPS, and SHA-256 for sign-in).
`ITSAppUsesNonExemptEncryption` is already set to `NO` in the build, so App Store Connect will
not ask.

## App Review information

| Field | Value |
| --- | --- |
| Sign-in required | **No** (see notes: every feature except the optional Apple Calendar setting can be reviewed without an account; whether Apple accepts that in place of a demo account is its call, see "No test account" and "Calendar permission" under risks) |
| Contact first name, last name, phone, email | **YOU** |

**Notes for the reviewer** (paste as is; the APPLE CALENDAR paragraph is new in 1.1)

```
Session Planner shows an attendee's AWS re:Invent schedule as a calendar.

HOW TO REVIEW WITHOUT AN ACCOUNT
On the first screen, tap "Try the sample conference". This loads a made-up conference stored
in the app and exercises every feature except the optional Apple Calendar setting (see below),
with no account and no network: the calendar, swiping between days, favorites, the venue-change
warning (open Wed 10), the free stretches and the sessions that fit them (tap "Free 9:00 - 11:00
AM" on Tue 9), search and filters, session details, adding and removing a favorite, reserving a
seat (try ARC420 to see a refused clash, SEC220 to see a success) and cancelling a reservation.

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

The app is independent. It is not affiliated with, sponsored by or endorsed by Amazon Web
Services, and says so on its first screen and in Settings. It has no analytics, ads, tracking
or server of its own.
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
  conference shows the full function; say so if asked.

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

## After approval

- The version string is `1.1` (build 3) for the second release; `1.0` (builds 1–2) was the
  first. Use `1.1.1` and up for fixes, and raise the build number for every upload.
- re:Invent 2026 runs 30 November to 4 December 2026. Review usually takes one to three days
  but can take longer, and is not guaranteed before the event. TestFlight internal testing
  (your own team's Apple IDs) needs no review and is the dependable route for that week.
