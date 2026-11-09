Feature: What a session's rating, lock and reserved seat are, read from the saved picks
  Ratings are saved per session record, but a session can run several times, be renamed, or
  be cancelled. Every view reads one effective pick per repeat group, so the rules that
  decide it live in one place that can be tested.

  Rule: The newest rating wins; a lock or reservation comes from the record that holds it

    Scenario: A later rating replaces an earlier one
      Given a session rated Want on Monday
      And the same session rated Must on Tuesday
      When the planner reads the pick
      Then the session is a Must

    Scenario: The newest record is a Skip while an older record holds a lock
      Given a session with two runs where the newer record rates it Skip
      And the older record locks the second run
      When the planner reads the pick
      Then the session is a Skip
      And the lock still points at the second run

    Scenario: A reserved seat pins its run
      Given a session whose record reserves a seat for its Thursday run
      When the planner reads the pick
      Then the lock is the Thursday run

    Scenario: A lock on a run that left the catalog gives way to the reservation
      Given a record that locks a run no longer in the catalog
      And a record that reserves a run still in it
      When the planner reads the pick
      Then the lock is the reserved run

  Rule: A lock made in preview does not count once the real schedule is out

    Scenario: The schedule is published
      Given a lock made while the schedule was simulated
      When the planner reads the pick with the official schedule
      Then there is no lock

    Scenario: The schedule is still simulated
      Given a lock made while the schedule was simulated
      When the planner reads the pick in preview
      Then the lock stands

  Rule: A pick stays attached when its session is renamed or cancelled

    Scenario: The session code changed
      Given a pick saved under a session the catalog no longer lists
      And the pick remembers its code, which the catalog still has
      When the picks are indexed
      Then the pick belongs to that session's group

    Scenario: The code gained a repeat suffix
      Given a pick that remembers a code with a repeat suffix
      And the catalog lists the base code
      When the picks are indexed
      Then the pick belongs to the base code's group

    Scenario: The session was cancelled
      Given a pick whose session has left the catalog under every name it had
      When the picks are indexed
      Then the pick is an orphan
