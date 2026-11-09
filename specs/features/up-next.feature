# Issue 98 covered the first four rules; issue 100 the detour rule.
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

  Rule: A detour is judged against where Minesh needs to be next

    Scenario: The next planned session is the default destination
      Given Minesh is in the Dolphin at 11:00 with his next planned session at 12:30 in the Swan
      And a candidate session runs 11:20 to 11:50 in the Yacht Club
      When he looks at the candidate
      Then it shows the walk there, the time in the session, then the walk on to the Swan
      And it says he would reach the Swan at 12:10 with 20 minutes to spare

    Scenario: The detour makes him late
      Given the same candidate with his next planned session at 12:05
      When he looks at the candidate
      Then it says he would be 5 minutes late for it

    Scenario: Minesh picks a different place to be next
      Given Minesh picked the Dolphin as where he needs to be next
      When he looks at the candidate
      Then it shows the walk on to the Dolphin in place of the Swan

    Scenario: Nothing planned after it
      Given Minesh has nothing else planned today
      When he looks at the candidate
      Then it shows the walk there with the session length
      And no walk on

    Scenario: The candidate is the next planned session itself
      Given the candidate is the session Minesh planned next
      When he looks at it
      Then it shows the walk there with no detour

    Scenario: The walk on would be a guess
      Given the candidate's room is in a building the venue does not know
      When he looks at the candidate
      Then it shows no walk on rather than an arrival time built on a guess

    Scenario: The venue has no walking time between the two buildings
      Given the candidate's building has no walking time to the destination's building
      When he looks at the candidate
      Then it shows no walk on

    Scenario: Lunch comes before the next planned session
      Given the plan has lunch next, then a planned session at 1:00 PM
      When Minesh looks at a candidate
      Then the detour is judged against the 1:00 PM session, not the lunch
