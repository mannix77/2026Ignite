# Next best session: design draft

Status: draft for Minesh's review, 2026-11-22. Nothing is built. re:Invent runs 30 Nov to 4 Dec.

## What it does

When there is a gap in the calendar, the app suggests the sessions worth filling it with. Each
suggestion says why it was chosen and what you can do about it (reserve a seat, join the walk-up
line, or switch to a repeat that fits).

Two places in the app ask for suggestions:

1. **A gap on the calendar.** Tap the empty time between two commitments and get up to five
   sessions that fit in it, including the walk.
2. **"What's next" on the day.** On the day itself, it suggests sessions starting in the next
   two hours that you can still get to from where your last commitment was.

## What the data allows (measured on your real catalog and schedule, 22 Nov)

- 2,849 sessions. You hold 11 reserved seats and 135 favorites.
- Attributes on every session are good material for a graph: 18 topics, 53 areas of interest,
  186 AWS services, 17 session types, 6 levels, 5 venues, 19 roles, 8 formats, 17 industries.
  Speakers are almost all one-offs (3,396 names), so they barely link anything.
- Your picks have a clear profile: Agentic AI (57), DevOps (25), Automation (23), Monitoring &
  Observability (19); Bedrock, CloudWatch, Kiro, Lambda, GuardDuty; level 300–400 (123 of 136);
  workshops (57) far ahead of breakouts (17).
- **Seats are nearly gone.** Of the sessions you haven't picked, only 14 show an open seat band
  (5 available, 6 limited, 3 very limited). 1,396 are "unavailable" and 1,303 have no band (not
  reservable at all). So for most suggestions the action will be "walk-up line" or "repeat at
  another time", not "reserve".

## The "graph" is small enough to live on the phone

There is no need for a separate graph database or a server. Sessions and their attributes form a
two-sided graph: session nodes connect to attribute nodes (topic "Agentic AI", service "Amazon
Bedrock", level "300", type "Workshop"). At 2,849 sessions and about 300 attribute values it is a
few thousand edges, built in memory from the catalog the app already downloads and ranked in
milliseconds. Nothing new is stored or sent.

How a session is scored:

1. **Your profile.** Walk from each of your reserved sessions and favorites to its attributes.
   Reserved counts more than a favorite (you committed to it).
2. **Rare attributes count more.** "Agentic AI" is on 1,208 sessions, so sharing it says little;
   "AWS Distro for OpenTelemetry" is on a handful, so sharing it says a lot (inverse frequency
   weighting).
3. **Score** = how strongly a candidate's attributes overlap your profile, weighted as above.
4. **Explain** with the top shared attributes: "Shares Bedrock, Monitoring & Observability and
   level 300 with 14 of your favorites."

## Filters before ranking (hard rules)

- Not already reserved, invited or (optionally) favorited.
- Fits the gap: starts at or after the previous commitment ends plus the walk, ends before the
  next commitment starts minus the walk.
- Walk time between venues comes from the retired web planner's table: 10 to 25 minutes
  between Venetian, Wynn/Encore, Caesars Forum and Caesars Palace, 35 to or from the MGM Grand
  (shuttle), 8 inside one venue, 15 when a venue is unknown. Today the calendar only knows
  "different venue, under 30 minutes is tight"; that warning is left as it is for now.
- A repeat of something you already hold is never suggested (codes like `AIM320` / `AIM320-R1`).

## Then adjust for what you can actually get

- Open seat: offered to **Reserve** (the existing reserve call, with its confirmation).
- No seat: still shown, labelled **Walk-up line**. Of two equally alike sessions, the one with
  a seat comes first; seats don't otherwise change the order.
- A favorite you can't fit, whose repeat fits this gap: labelled **Same session, other time**.
  It is not moved up; being like your favorite already ranks it high.

## How good is it? (measured on your picks)

Test: hide one of your 136 picks, build the profile from the other 135, and see where the hidden
one ranks among the 2,713 sessions you didn't pick. Random ranking puts it around 1,356.

| Signals used | Median rank of the hidden pick | In top 50 | In top 200 |
| --- | --- | --- | --- |
| All attributes incl. roles, formats, speakers (first try) | 620 | 22 | 48 |
| Topic, area, service, level, type only | 699 | 15 | 41 |
| + roles, formats, industries, speakers | 527 | 6 | 36 |
| Topic, area, service, level, type + words from title and abstract | 505 | 13 | 39 |
| Same, scored against your 5 most similar picks instead of the average | 363 | 3 | 37 |

(Rows 2–5 also hide the hidden pick's repeats, which the first row didn't, so the first row
is slightly flattering.)

What this says: the attributes carry real signal (every variant beats random by 2–4×), but
across the whole catalog it is modest. A hidden pick typically lands in the top 13–25%, not in
the top 5. Two things help in practice:

- **The gap filter does most of the work.** A one-hour gap on one day leaves tens of
  candidates, not 2,713, and ranking within that set is a much easier job.
- **Comparing against your closest picks beats comparing against your average**: you have
  several separate interests (agentic AI, observability, security), and averaging them blurs
  all of them.

**Within one time slot (measured 23 Nov).** Hide a pick, then rank it only against the sessions
you didn't pick that overlap it on the same day (repeats of it left out). 135 picks have a time.
Slots are larger than expected: a median of 154 overlapping sessions (18 to 388), because
workshops run two hours and the catalog is dense.

| Signals used | Median rank in its slot | Top 1 | Top 3 | Top 5 |
| --- | --- | --- | --- | --- |
| Random order | 78 | 1% | 2% | 4% |
| Topic, area, service, level, type; your average (reserved ×2) | 31 | 5% | 13% | 15% |
| Same, against your 5 closest picks | 34 | 5% | 9% | 14% |
| + title and abstract words; your average | 27 | 3% | 9% | 13% |
| + title and abstract words; your 5 closest picks | 22 | 1% | 3% | 10% |

What this says:

- Ranking moves a pick from the middle of its slot (78) to around 22–31, and makes it 3–4×
  more likely to be in the top 5. That is real, but **a top-5 list would contain the session
  you actually chose only about one time in seven.**
- The test is strict. It counts a miss whenever the top 5 are sessions you never favorited,
  which may still be good ones you never saw. It can't tell those apart from bad suggestions.
- So the catalog's attributes alone are not enough for a confident "next best session". They
  are enough to **sort** a slot's 150 sessions so the likely ones come first.

What follows for the design:

1. Present it as "sessions in this gap, most like your picks first", a sorted and filtered
   list with the reasons shown, not as a single best answer.
2. Use the simplest scorer (attributes, your average, reserved counted twice). It did as well
   as or better than the heavier variants on top 5.
3. Narrow the pool before ranking: the walk, seat availability and your own filters (type,
   level) cut 150 down to the ones you could actually attend, where ordering matters more.
4. Improving the ranking itself needs a signal the catalog doesn't have: what you skip or
   dismiss in the app. That is question 2 below, and it can't help before re:Invent.

## Where it goes in the code

- `ios/PlannerCore/Sources/PlannerCore/Suggestions.swift`: the walk table, the day's gaps, and
  the profile, scoring, filters and reasons. Pure functions over `PlanSnapshot`, so all of it is
  tested with `swift test`. The walk table could later sharpen the existing tight-walk warning.
- `ios/SessionPlanner/`: a "Suggest" button in a calendar gap and a "What's next" section on the
  day, both thin views over the above. That touches `project.pbxproj` only if new view files are
  added; adding the views to existing files avoids it.

## Spec examples

Under "A gap in his day lists the sessions he could still make, most like his picks first" in
`specs/features/ios-app.feature`: the walk there and back (both sides of each threshold), a free
day, a seat he holds and its repeat, a clashing favorite whose repeat fits, a rare shared trait,
no seats left, and nothing in common.

## Built so far

`PlannerCore` only: `Walks`, `PlanSnapshot.gaps(on:)` and `PlanSnapshot.suggestions(in:)` in
`ios/PlannerCore/Sources/PlannerCore/Suggestions.swift`, with the spec examples under "A gap in
his day lists the sessions he could still make". No screen shows them yet.

## Questions for you

1. Should suggestions include your own favorites (choosing among the 135), or only sessions you
   haven't marked? My suggestion: both, favorites labelled as such.
2. Should a "Not for me" swipe hide a suggestion and teach the ranking? (Stored on the phone per
   sign-in.) My suggestion: later, not for re:Invent.
3. Release: version 1.0 build 2 is waiting for App Store review. A new feature means either a new
   build after approval, or installing a development build on your phone for re:Invent (the
   profile already has to be reinstalled on or after 29 Nov). My suggestion: development build
   for the conference, App Store update afterwards.

## Risks

- **The signal is modest (measured).** Within a slot your pick lands in the top 5 about 15% of
  the time, against 4% at random. Claiming "the best session for you" would overpromise.
- **Seat bands go stale.** The band is from the last refresh; a "Reserve" can still fail with
  `sessionFull`, which the app already reports per session.
- **Reserve is a real change** to your conference schedule. Tests use canned responses only.
