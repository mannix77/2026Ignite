Feature: An iPhone app that signs in to the conference and shows my calendar
  The web planner cannot sign in to the conference site, so Minesh had to enter his
  favorites and reserved seats twice. The iPhone app signs him in on the phone itself and
  shows what the conference site holds, as a calendar.

  Rule: He signs in on the phone and stays signed in

    Example: The one who signs in with his Builder ID
      Given Minesh has not signed in
      When he signs in with his AWS Builder ID
      Then the app holds his sign-in in the phone's keychain

    Example: The one whose sign-in answer came from somewhere else
      Given the app started a sign-in
      When an answer arrives that does not match that sign-in
      Then the app refuses it and he stays signed out

    Example: The one who leaves to read a code
      Given the conference site emailed him a verification code part way through signing in
      When he leaves the app to read it and comes back
      Then the sign-in still completes

    Example: The one who signs out while access is being renewed
      Given the app is renewing his access
      When he signs out before the renewal finishes
      Then no sign-in is left on the phone

    Example: The one who signs in after someone else
      Given the phone shows a calendar from an earlier sign-in
      When someone signs in afresh
      Then the earlier calendar is gone from the screen and from the phone before theirs loads

    Example: The one with an expired pass
      Given his access has expired but his saved sign-in is still good
      When he opens the calendar
      Then the app renews access without asking him to sign in

    Example: The one whose saved sign-in is no longer good
      Given the conference site rejects his saved sign-in twice
      When he refreshes
      Then the app asks him to sign in again
      And the calendar he last saw is kept

  Rule: The calendar is the conference site's own answer

    Example: The one with eleven reserved seats
      Given the conference site lists 11 reserved sessions and 135 favorites for Minesh
      When he opens the calendar
      Then it shows the 11 reserved sessions on their days
      And his favorites stay hidden until he asks for them

    Example: The one invited to a private reception
      Given the conference site placed a reception on his schedule by invitation
      When he opens that day
      Then the reception is on the calendar

    Example: The one with a favorite that was withdrawn
      Given 1 of his favorites is no longer in the catalog
      When he opens the calendar
      Then the app carries on and reports 1 favorite it could not find

  Rule: Sessions that overlap sit side by side

    Example: The one with two at the same hour
      Given two sessions both run from 10:00 to 11:00
      When he opens that day
      Then each takes half the width

    Example: The one that starts as the other ends
      Given one session ends at 11:00 and the next starts at 11:00
      When he opens that day
      Then each takes the full width

  Rule: The hours down the side stay readable at every text size

    Example: The one at the standard text size
      Given the phone's text size is the standard one
      When he opens the calendar
      Then the hour column is 50 points wide, as it always was

    Example: The one with the largest accessibility text
      Given the phone's text size is the largest accessibility size
      When he opens the calendar
      Then the hour column stops growing at 88 points
      And each hour label stays on one line, shrunk to fit if it must

    Example: The one with the smallest text
      Given the phone's text size is the smallest one
      When he opens the calendar
      Then the hour column is 50 points wide, the same as at the standard size

  Rule: A walk he cannot make is pointed out

    Example: The one with no time to cross the Strip
      Given a reserved session ends at 12:30 at "Caesars Palace"
      And the next reserved session starts at 12:30 at "MGM Grand"
      When he opens that day
      Then the calendar warns about that change of venue

    Example: The one with an invitation in between
      Given a reserved session ends at 12:30 at "Caesars Palace"
      And an invitation with no venue starts at 12:30
      And the next reserved session starts at 12:35 at "MGM Grand"
      When he opens that day
      Then the calendar still warns about the change of venue

  Rule: A swipe across the calendar moves one day, and stops at the first and last day
    The days are the ones the day strip shows. VoiceOver takes over swipes, so the selected
    day in the strip offers the same moves as "Next day" and "Previous day" actions.

    Example: The one in the middle of the week
      Given the conference runs Sunday 29 November to Friday 4 December
      And he is looking at Wednesday 2 December
      When he swipes left
      Then he sees Thursday 3 December
      And the day strip shows Thursday as the selected day

    Example: The one going back a day
      Given he is looking at Wednesday 2 December
      When he swipes right
      Then he sees Tuesday 1 December

    Example: The one on the last day
      Given he is looking at Friday 4 December
      When he swipes left
      Then he still sees Friday 4 December

    Example: The one on the first day
      Given he is looking at Sunday 29 November
      When he swipes right
      Then he still sees Sunday 29 November

    Example: The one scrolling through a busy day
      Given he is looking at a day with sessions from morning to night
      When he scrolls up and down through them
      Then the day does not change

    Example: The one who taps a day instead
      Given he is looking at Wednesday 2 December
      When he taps Friday in the day strip
      Then he sees Friday 4 December

    Example: The one using VoiceOver
      Given VoiceOver is on and he is on Wednesday 2 December in the day strip
      When he chooses the "Next day" action
      Then he sees Thursday 3 December
      And VoiceOver says "Thu, Dec 3"

  Rule: The session list finds what he is looking for

    Example: The one looking for a seat
      Given "AIM358" still has seats and he already holds one in it
      And "SVS350" still has seats and he does not
      When he lists the sessions with seats open
      Then he sees "SVS350" and not "AIM358"

    Example: The one searching by speaker
      Given a session is presented by "Tracy Example"
      When he searches for "trac"
      Then that session is listed

  Rule: A bad answer never replaces a good calendar

    Example: The one with a catalog cut short
      Given the site says the catalog has 2849 sessions but only 250 arrive
      When he refreshes
      Then the app refuses and keeps the calendar he last saw

    Example: The one with a few garbled sessions
      Given 1 of 20 sessions arrives without an id
      When he refreshes
      Then that session is skipped and counted
      And the other 19 are shown

  Rule: His schedule stays fresh without downloading every session each time
    The whole catalog (about 2,900 sessions, 12 pages) is downloaded at sign-in and then at
    most once every 24 hours. His schedule (reserved seats, favorites, invitations) is one small
    request: while the calendar is open it is read again every 5 minutes, and pulling down
    reads it at once. The calendar always says when it last read his schedule from AWS and
    that pulling down gets the latest.

    Example: The one with the calendar open
      Given his schedule was last read 5 minutes ago and the catalog 3 hours ago
      When the calendar is open
      Then the app reads his schedule again
      And does not download the catalog

    Example: The one with the calendar open a moment longer
      Given his schedule was last read 4 minutes 59 seconds ago
      When the calendar is open
      Then nothing is fetched

    Example: The one whose catalog is a day old
      Given the catalog was downloaded 24 hours ago
      When his schedule is read
      Then the whole catalog is downloaded again too
      But at 23 hours 59 minutes 59 seconds it is not

    Example: The one who favorited a brand-new session
      Given he favorited a session on the website that the saved catalog doesn't have
      And the catalog was downloaded an hour ago
      When his schedule is read
      Then the catalog is downloaded again so the session can be shown
      But if the catalog is under an hour old, it waits, and the session shows as no longer listed

    Example: The one whose favorite was withdrawn
      Given a favorite that the catalog no longer has, even after downloading it again
      When his schedule is read every 5 minutes for the rest of the day
      Then the catalog is not downloaded again for that session; it shows as no longer listed

    Example: The one whose catalog download fails
      Given the catalog is due and the site fails to send it
      When his schedule is read
      Then his new schedule is shown with the catalog he already had
      And the catalog is not tried again for an hour

    Example: The one who reserves during an update
      Given an update is downloading the catalog
      When he reserves a seat before it finishes
      Then the reservation stays on his calendar when the update lands
      And the catalog the update downloaded is kept

    Example: The one whose catalog download fails and then his schedule too
      Given the catalog is due and the site fails to send it
      When reading his schedule fails as well
      Then the calendar he last saw is kept
      And the catalog is still not tried again for an hour

    Example: The one whose first download fails
      Given no calendar has loaded yet and downloading the catalog just failed
      When the calendar is open
      Then it doesn't try again by itself for an hour
      But pulling down or tapping Update tries at once

    Example: The one who leaves the calendar during a download
      Given the catalog is being downloaded early for a new session
      When he switches tabs before it finishes
      Then the attempt still counts, and the catalog isn't tried again for an hour

    Example: The one whose second schedule read fails
      Given his schedule named a new session and the catalog was downloaded for it
      When reading his schedule again fails
      Then the first schedule is shown with the new catalog
      And the failure is reported like any other, so a rejected sign-in still asks him to sign in

    Example: The one with a damaged list of missing sessions
      Given a saved calendar whose list of sessions the catalog lacked has a blank or unreadable entry
      When the app opens
      Then the calendar is shown, the bad entries are dropped and padded ones are trimmed

    Example: The one who wants every session now
      When he chooses "Download all sessions now" in Settings
      Then the whole catalog and his schedule are downloaded, however recent they are

    Example: The one who signs in
      When he signs in
      Then the whole catalog and his schedule are downloaded

    Example: The one whose phone clock was moved back
      Given the phone's clock reads earlier than the last update
      Then his schedule and the catalog are both fetched, since their age can't be known

    Example: The one with no connection
      Given the calendar is open with no connection
      When the 5-minute update fails
      Then the calendar he last saw is kept and no message interrupts him
      And the app doesn't try again by itself for another 5 minutes
      But when he pulls down, he is told the site couldn't be reached

    Example: The one whose sign-in is no longer good
      Given the app has asked him to sign in again and he chose "Not now"
      Then the calendar stops updating by itself until he signs in or pulls down

    Example: The one who checks how fresh it is
      Given his schedule was last read from AWS 12 minutes ago
      Then the calendar says "Updated from AWS 12 min ago. Pull down for the latest."

    Example: The one just updated
      Given his schedule was read 59 seconds ago
      Then it says "Updated from AWS just now. Pull down for the latest."
      But at 60 seconds it says "1 min ago"

    Example: The one left for hours
      Given his schedule was last read 59 minutes ago, then 60 minutes ago
      Then it says "59 min ago", then "1 hr ago"
      And a day after it says "1 day ago"

    Example: The one whose phone clock reads earlier than the update
      Then it says "Updated from AWS. Pull down for the latest." without an age it can't know

    Example: The one trying the sample conference
      Given he is trying the sample conference
      Then the calendar says "Sample conference, updated just now. Pull down for the latest."

    Example: The one watching it update
      While his schedule is being read
      Then the calendar says "Updating from AWS…", or "Updating the sample conference…" for the sample

    Example: The one with a calendar saved by the earlier version
      Given a calendar saved before the catalog's own download time was kept
      When the app opens
      Then the calendar is shown, taking the catalog's download time as the schedule's

  Rule: The app waits when the site says it is busy

    Example: The one told to slow down
      Given the site answers "too many requests, retry in 2 seconds"
      When he refreshes
      Then the app waits 2 seconds and carries on

  Rule: Reserving and favoriting happen on the conference site

    Example: The one that clashes with a seat he holds
      Given he holds a seat in "AIM442"
      When he reserves "PEX403-R", which overlaps it
      Then the app says it clashes with "AIM442"
      And his reservations are unchanged

    Example: The one whose answer never arrived
      Given he reserves a session and the connection drops
      When the app recovers
      Then it reads his schedule again instead of sending the request twice

    Example: The one the site said nothing about
      Given he reserves a session and the site answers without mentioning it
      When the app reads his schedule back
      Then it tells him the change was not confirmed

    Example: The one already cancelled
      Given he cancels a reservation the site no longer has
      When the site answers "not found"
      Then the app treats it as cancelled

  Rule: The app can be tried without a conference sign-in

    Example: The one trying the sample conference
      Given someone has no Builder ID
      When they choose the sample conference
      Then they see a calendar of made-up sessions
      And nothing is sent to the conference site

  Rule: Favorites never crowd out what he has committed to

    Example: The one with nine favorites in the same hour
      Given he holds a seat at 12:00 and has 9 favorites that start between 12:00 and 12:59
      When he shows favorites on that day
      Then the seat he holds keeps its place on the calendar
      And the 9 favorites appear as one marker for that hour, which opens their list

  Rule: A gap in his day lists the sessions he could still make, most like his picks first
    Picks are his reserved seats (counted twice) and his favorites. Invitations are not
    picks: a reception says nothing about what he wants to learn. A trait few sessions share
    counts for more than one most of them share. Walks between venues are the planner's old
    estimates: 10 to 25 minutes between the four resorts north of MGM, 35 to or from the
    MGM Grand by shuttle, 8 inside one venue, 15 when a venue is unknown.
    Getting in takes time as well as the walk: he needs to be in line before a session starts,
    30 minutes for one that can be reserved (his time in line, a setting) and 5 for a walk-up
    one, which can't be. So a session in a gap must leave him the walk plus that time to get
    into it, and, when the next thing on his calendar is a reserved session, the walk plus his
    time in line to get into that one too.

    Example: The one that fits only if he hurries
      Given a reserved session ends at 10:00 at "Caesars Forum"
      And the next reserved session starts at 16:00 at "Caesars Forum"
      And the walk between "Caesars Forum" and "Wynn/Encore" takes 20 minutes
      When he asks what fits between them
      Then a session at "Wynn/Encore" starting at 10:50 is listed and one starting at 10:49 is not
      And one ending at 15:10 is listed and one ending at 15:11 is not

    Example: The one between two different venues
      Given a reserved session ends at 10:00 at "MGM Grand"
      And the next reserved session starts at 16:00 at "Wynn/Encore"
      When he asks what fits between them
      Then a session at "Caesars Forum" starting at 11:05 is listed and one starting at 11:04 is not
      And one ending at 15:10 is listed and one ending at 15:11 is not

    Example: The walk-up session
      Given a reserved session ends at 10:00 at "Caesars Forum"
      And the next reserved session starts at 16:00 at "Caesars Forum"
      When he asks what fits between them
      Then a walk-up session at "Wynn/Encore" starting at 10:25 is listed and one starting at 10:24 is not
      And one ending at 15:10 is listed and one ending at 15:11 is not, since the seat after it is reserved

    Example: The invitation after the gap
      Given a reserved session ends at 10:00 at "Caesars Forum"
      And he is invited to a reception at 16:00 at "Caesars Forum"
      When he asks what fits between them
      Then a session at "Wynn/Encore" ending at 15:40 is listed and one ending at 15:41 is not,
        since he doesn't line up for an invitation

    Example: The first session of a free morning
      Given nothing is on his calendar before 12:00 on Wednesday
      And Wednesday's sessions start at 08:00
      When he asks what fits in the morning
      Then a session starting at 08:00 is listed, since he can line up before the day's first sessions

    Example: The one already part way through the morning
      Given nothing is on his calendar before 12:00 on Wednesday
      When he opens that day at 09:10
      Then a session starting at 09:40 is listed and one starting at 09:39 is not

    Example: The one opened just before the day starts
      Given nothing is on his calendar before 12:00 on Wednesday
      And Wednesday's sessions start at 08:00
      When he opens that day at 07:45
      Then the free stretch still starts at 08:00
      And a session starting at 08:15 is listed and one starting at 08:14 is not,
        since he can't be in line before 07:45

    Example: The one part way through a gap
      Given he holds seats at "MGM Grand" from 09:00 to 10:00 and from 14:00 to 15:00
      When he opens that day at 11:00
      Then a session at "MGM Grand" starting at 11:38 is listed and one starting at 11:37 is not,
        since the walk inside one venue is 8 minutes, then 30 in line

    Example: The reception listed with no length
      Given he is invited to a reception at 10:00 that the site lists with no length
      When he asks for the gaps that day
      Then the next gap starts at 10:20, the shortest time the calendar draws

    Example: The one with the whole day free
      Given nothing is on his calendar on Wednesday
      And Wednesday's sessions run from 08:00 to 19:00
      When he asks for the gaps on Wednesday
      Then there is one gap, from 08:00 to 19:00, with no walk at either end

    Example: The one he already holds a seat for
      Given he holds a seat in "AIM320" and its repeat "AIM320-R1" falls in the gap
      When he asks what fits in the gap
      Then neither is listed

    Example: The favorite in the gap
      Given "COP305" is a favorite that falls in the gap
      When he asks what fits in the gap
      Then it is listed and marked as a favorite

    Example: The one with no picks yet
      Given he has no reserved seats and no favorites
      When he asks what fits in a gap
      Then nothing is listed, since there is nothing to compare with

    Example: The favorite that clashes, whose repeat fits
      Given "COP319" is a favorite at a time he is busy
      And its repeat "COP319-R1" falls in the gap
      When he asks what fits in the gap
      Then "COP319-R1" is listed as the same session as a favorite

    Example: The one with a rare trait in common
      Given his picks all cover "Agentic AI", which most sessions cover, each with a rarer interest
      And one of those is "AWS Distro for OpenTelemetry", which few sessions cover
      When he asks what fits in the gap
      Then a session on "AWS Distro for OpenTelemetry" comes before one on "Agentic AI" only
      And each says which of his interests it shares

    Example: The one with no seats left
      Given two sessions in the gap are equally like his picks
      And one still has seats and the other has none
      When he asks what fits in the gap
      Then the one with seats comes first, offered to reserve
      And the other is offered as a walk-up

    Example: The one with nothing in common
      Given a session in the gap shares nothing with his picks
      When he asks what fits in the gap
      Then it is not listed

    Example: The reception with no level
      Given a reception in the gap and one of his picks both have "No Level" and nothing else in common
      When he asks what fits in the gap
      Then the reception is not listed

  Rule: He sets how long he allows to get in line
    Gap suggestions allow 30 minutes in line for a session that can be reserved unless he
    changes it in Settings, to any whole number of minutes from 1 to 60. A walk-up session
    allows 5 minutes, or his time in line if that is shorter. A session the site doesn't say
    can or can't be reserved is treated as one that can: the longer line is the safe guess.

    Example: The one who never changed it
      Given he has never changed the time in line
      Then Settings shows 30 minutes and gap suggestions allow 30 minutes

    Example: The shorter line
      Given he sets the time in line to 10 minutes
      And a reserved session ends at 10:00 at "Caesars Forum"
      And the next reserved session starts at 16:00 at "Caesars Forum"
      When he asks what fits between them
      Then a session at "Wynn/Encore" he can reserve starting at 10:30 is listed and one starting at 10:29 is not
      And one ending at 15:30 is listed and one ending at 15:31 is not

    Example: The line shorter than a walk-up's
      Given he sets the time in line to 3 minutes
      Then a walk-up session allows 3 minutes, not 5

    Example: The limits
      Then he can set 1 and 60 minutes but not 0 or 61
      And a saved value outside that range is read as the nearest limit, and an unreadable one as 30

  Rule: A free stretch on the calendar opens the sessions that fit it
    Only a stretch of at least 30 minutes is offered: anything shorter can't hold a session
    and the walks either side. With time in line as well, a short stretch between two seats
    will often list nothing.

    Example: The one just long enough
      Given he holds seats from 09:00 to 10:00 and from 10:30 to 11:30
      When he opens that day
      Then the free stretch from 10:00 to 10:30 is offered as "Free 10:00 – 10:30 AM"

    Example: The one a minute too short
      Given he holds seats from 09:00 to 10:00 and from 10:29 to 11:30
      When he opens that day
      Then no free stretch is offered between them

    Example: The one already part way through the day
      Given he holds seats from 09:00 to 10:00 and from 12:00 to 13:00
      When he opens that day at 11:00
      Then the free stretch is offered from 11:00 to 12:00, not from 10:00
      And at 11:30 it is still offered, and at 11:31 it is not, with under 30 minutes left
      And on another day nothing is cut

    Example: The one he taps
      Given a free stretch is offered
      When he taps it
      Then he sees the sessions that fit, most like his picks first
      And each says what it shares with his picks and how he can get in

  Rule: He can add his reserved sessions to Apple Calendar, and keep them matching
    Off until he turns it on. The events go in a calendar of their own, named for the
    conference, so he can hide or delete them in one go. Only events the app made are ever
    changed. Favorites, invitations and personal time stay out. The app sends the calendar to
    no one; it lives in his Calendar account (such as iCloud), which syncs it like his others.

    Example: The one who turns it on
      Given he holds a seat at "AIM320" on 2 December from 10:00 to 11:00 Las Vegas time, in "Venetian" "Level 3, Murano 3201"
      When he turns on "Add reserved sessions to Calendar"
      Then his calendar shows "AIM320 – " and the title, from 18:00 to 19:00 UTC on 2 December
      And its location is "Venetian, Level 3, Murano 3201"

    Example: The one who turns it on twice
      Given his reserved sessions are already in the calendar
      When the app brings the calendar up to date again
      Then nothing is added, changed or removed

    Example: The one whose session moved
      Given "AIM320" is in the calendar at 10:00
      When the conference moves it to 13:00 and the app refreshes
      Then the same event moves to 13:00, with no second copy

    Example: The one who cancelled
      Given "AIM320" is in the calendar
      When he cancels the reservation and the app refreshes
      Then the event is removed
      And the events for his other reserved sessions stay

    Example: The one whose session came back unreadable
      Given "AIM320" is in the calendar
      And the conference sends it with a time the app cannot read, still reserved
      When the app refreshes
      Then the event is left as it was

    Example: The one who said no
      Given he turns it on
      When he refuses the phone's calendar permission
      Then the app says it can't add the sessions without that permission
      And nothing is written

  Rule: What goes to the on-device model fits its window
    The model sees at most 12 sessions, each abstract cut to 300 characters at a word and at
    most 3 topics on its line, his question cut the same way, and his picks as at most 15 of
    their most common interests, each name cut to 60 characters. Tokens are estimated as UTF-8 bytes divided by 3, rounded up
    (cautious for English, and for other scripts and emoji too), and the prompt stays within
    the model's 4,096 less 1,000 kept for the answer. Tested on the real re:Invent 2026
    catalog, with placeholder abstracts at the real lengths and no speakers.

    Example: The busiest hour
      Given the 149 sessions running on Thursday 3 December from 13:00 to 14:00
      When the 12 with the longest text are sent
      Then the prompt is estimated under 3,096 tokens, and 137 are counted as left out

    Example: The worst case in the whole catalog
      Given the 12 sessions with the longest text anywhere in the catalog
      And a 300-character question and the catalog's 15 longest interests on 135 picks
      Then the prompt is estimated under 2,700 tokens

    Example: The prompt at its limit
      Given a prompt that comes to exactly the limit
      Then every session is sent, and with one token less the last one is left out

    Example: Every hour of the conference
      Given every hour of the conference in the catalog
      When the 12 sessions with the longest text in each are sent
      Then every prompt is estimated under 3,096 tokens without leaving any more out

    Example: The long abstract
      Given an abstract of 301 characters
      Then it is cut at the last whole word within 300 characters and ends with "…"
      And an abstract of exactly 300 characters is sent whole

    Example: The thirteenth session
      Given 13 sessions ranked for the model
      Then the first 12 are sent and 1 is counted as left out

    Example: The prompt that would still be too long
      Given 12 sessions with titles far longer than any in the catalog
      Then sessions are left out from the bottom of the ranking until the prompt fits
      And each one left out is counted

    Example: The title with a bar in it
      Given the real title "Kiroween '26 | Build something wicked for a shot at $100,000 in prizes"
      Then its line keeps every field in its place, the bar written as "/"
      And line breaks in a title, abstract or question become spaces, so nothing looks like another session
      And a bar in his question, an abstract or an interest is written as "/" too

    Example: The fixed text can't crowd out the sessions
      Given a 300-character question and 15 interests of 60 characters, all in 4-byte characters
      Then the fixed text alone still fits the window, with room for sessions
      And the same holds for characters of any size, such as the 25-byte family emoji,
        because the question is also cut to 1,200 bytes and each interest name to 240,
        at a word where there is one

    Example: A window too small for the fixed text
      Given a window smaller than the real one, too small for the instructions alone
      Then no session is sent and the prompt is marked as not to be sent

    Example: The same interest written twice
      Given one pick with the topic "AI" and the service " AI ", and a blank topic
      Then the summary says "AI (1)", and a second pick with "AI" makes it "AI (2)"

    Example: The blank question and the missing fields
      Given a blank question and a session with no time, venue or abstract
      Then the question reads "(none)" and the session's line leaves out what it doesn't have

    Example: The many picks
      Given he has 135 favorites
      Then his picks are summarised as his 15 most common interests, with how many picks share each

    Example: What each prompt reports
      Then each prompt reports its estimated tokens, the window, the room kept for the answer,
        the headroom left, the sessions in the block, the sessions sent, those left out,
        and the abstracts cut
