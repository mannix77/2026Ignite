Feature: Deciding a clash quickly
  With eighty-odd picks, an afternoon of overlapping sessions chains into one clash of thirty
  options, and only the heaviest few get compared. Minesh wants each clash small enough to read
  and its options in an order he can trust, so the decision takes a glance.

  Rule: A clash is the picks that overlap one start time, not a whole afternoon

    Scenario: A later pick overlaps only the tail of an earlier one
      Given two picks start at 2:00 PM
      And a third pick starting at 3:05 PM overlaps the second only
      When Minesh looks at the clashes for that day
      Then the 2:00 PM clash holds all three picks

    Scenario: Two later picks that overlap each other
      Given two picks start at 2:00 PM
      And two more picks starting at 3:05 PM overlap each other
      When Minesh looks at the clashes for that day
      Then the 2:00 PM clash holds the first two picks
      And the 3:05 PM clash holds the two later picks

    Scenario: A pick that overlaps nothing
      Given a pick that overlaps no other pick that day
      When Minesh looks at the clashes for that day
      Then that pick is not in a clash

    Scenario: Too long a walk for the gap is a clash too
      Given a pick in Moscone West ends five minutes before one at the Marriott starts
      When Minesh looks at the clashes for that day
      Then the two picks are on one card

  Rule: Options are ranked by one fixed rule

    Scenario: A reserved seat comes first
      Given a clash between a Want with a reserved seat, a Must without one
      When Minesh reads the clash
      Then the reserved seat is ranked first

    Scenario: Tier, then score, then recording
      Given a clash between a Must, a Want scored 12, a Want scored 6
      When Minesh reads the clash
      Then the order is the Must, the Want scored 12, the Want scored 6

    Scenario: A session that is not recorded beats one that is
      Given a clash between two Wants where only the second is recorded
      When Minesh reads the clash
      Then the unrecorded one is ranked first

    Scenario: The same building breaks a tie
      Given a clash between two equal Wants
      And the session before it is in Moscone South
      When Minesh reads the clash
      Then the one in Moscone South is ranked first

    Scenario: Rooms not yet published are not the same building
      Given a clash between two equal Wants whose rooms are not published
      And the session before it has no room either
      When Minesh reads the clash
      Then neither is said to be in the same building

  Rule: A session that runs again is pushed down, with the other run described

    Scenario: The other run is free
      Given a clash between a Must that also runs Thursday, a Want that runs once
      And nothing is planned against the Thursday run
      When Minesh reads the clash
      Then the Want is ranked first
      And the Must says it also runs Thursday with nothing against it

    Scenario: The other run only displaces lower picks
      Given a Must that also runs Thursday against a Maybe
      When Minesh reads the clash
      Then the Must is pushed down
      And it says the Thursday run clashes with that Maybe

    Scenario: The other run clashes with a pick of the same tier
      Given a Must that also runs Thursday against another Must
      When Minesh reads the clash
      Then the Must keeps its place
      And it says the Thursday run clashes with that other Must

    Scenario: The other run falls in blocked time
      Given a Must that also runs Thursday during a customer dinner Minesh blocked
      When Minesh reads the clash
      Then the Must keeps its place
      And it says the Thursday run clashes with the blocked time

    Scenario: The other run clashes with a seat Minesh reserved
      Given a Must that also runs Thursday against a Want with a reserved seat
      When Minesh reads the clash
      Then the Must keeps its place
      And it says the Thursday run clashes with that reserved Want

    Scenario: A reserved seat is never pushed down
      Given a reserved lab that also runs Thursday with nothing against it
      When Minesh reads the clash
      Then the reserved lab is still ranked first
