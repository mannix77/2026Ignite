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

    Example: The one that fits only if he hurries
      Given a reserved session ends at 11:00 at "Caesars Forum"
      And the next reserved session starts at 14:00 at "Caesars Forum"
      And the walk between "Caesars Forum" and "Wynn/Encore" takes 20 minutes
      When he asks what fits between them
      Then a session at "Wynn/Encore" starting at 11:20 is listed and one starting at 11:19 is not
      And one ending at 13:40 is listed and one ending at 13:41 is not

    Example: The one with the whole day free
      Given nothing is on his calendar on Tuesday
      And Tuesday's sessions run from 08:00 to 19:00
      When he asks for the gaps on Tuesday
      Then there is one gap, from 08:00 to 19:00, with no walk at either end

    Example: The one he already holds a seat for
      Given he holds a seat in "AIM320" and its repeat "AIM320-R1" falls in the gap
      When he asks what fits in the gap
      Then neither is listed

    Example: The favorite that clashes, whose repeat fits
      Given "COP319" is a favorite at a time he is busy
      And its repeat "COP319-R1" falls in the gap
      When he asks what fits in the gap
      Then "COP319-R1" is listed as the same session as a favorite

    Example: The one with a rare trait in common
      Given his picks all cover "Agentic AI", which most sessions cover
      And one pick covers "AWS Distro for OpenTelemetry", which few sessions cover
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
