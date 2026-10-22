# Issue 98 covers every rule except the last (detour, issue 100, @pending).
Feature: Up next shows what is coming up that I care about, and how far it is
  Standing in a building between sessions, I want every upcoming session I have picked or
  would likely want, grouped by start time, each with where it is and how long it takes to
  walk there from here, so I can decide in seconds whether to go or stay.

  Rule: Only sessions I care about are listed

    Scenario: A planned, a rated and a likely session are listed; a rejected one is not
      Given it is 11:00 and I am in the Dolphin
      And I have planned session A, rated session B "Want", and session C resembles my picks
      And I rated session D "No"
      When I open Up next
      Then A, B and C are listed
      And D is not listed

    Scenario: A session I have not rated and that resembles nothing I picked is not listed
      Given an unrated session E that scores below the interest threshold
      When I open Up next
      Then E is not listed

  Rule: Sessions are grouped by start time

    Scenario: Two starts in the next two hours
      Given sessions start at 11:30 and 12:00
      When I open Up next
      Then there is a 11:30 group and a 12:00 group, in that order
      And a session starting after 13:00 is not listed

  Rule: Each session says where it is and whether I can get there

    Scenario: Enough time to walk
      Given a session starts at 11:30 in the Swan, 9 minutes from here, and it is 11:00
      Then it shows "9 min walk" and 21 minutes to spare

    Scenario: Not enough time
      Given a session starts at 11:05 in the Yacht and Beach Club, 18 minutes from here, and it is 11:00
      Then it is marked as unreachable and listed after the reachable ones in its group

    Scenario: Already started but still worth joining
      Given a session started at 10:45 and ends at 11:45, 5 minutes from here, and it is 11:00
      Then it is listed as in progress with 5 min walk

    Scenario: My position is unknown
      Given I have not said where I am
      Then sessions are listed with their room and building but no walk time

  @pending
  Rule: A detour is judged against where I need to be next (issue 100)

    Scenario: Default destination is my next planned item
      Given I am in the Dolphin at 11:00 and my next planned session is at 12:30 in the Swan
      And a candidate session runs 11:15 to 11:45 in the Yacht and Beach Club, 18 minutes from here and 20 from the Swan
      When I look at the candidate
      Then it shows 18 to get there, 30 in the session, 20 on to the Swan
      And it says I would reach the Swan at 12:23 with 7 minutes to spare

    Scenario: The detour makes me late
      Given the same candidate but my next planned session is at 12:10
      Then it says I would be 13 minutes late for it

    Scenario: I choose a different place to be next
      Given I choose the Dolphin as where I need to be next
      Then the candidate shows the walk on to the Dolphin in place of the Swan

    Scenario: Nothing planned after it
      Given I have nothing else planned today
      Then the candidate shows the walk there and the session length, with no walk on
