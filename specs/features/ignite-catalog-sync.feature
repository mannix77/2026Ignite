Feature: Keeping the Ignite catalog current without false alarms
  The scheduled sync refuses a catalog that looks broken and keeps the last good copy. A
  session can have several runs, and Microsoft adds and removes runs as it publishes rooms
  and times; that must not look like sessions being cancelled.

  Rule: The partial-catalog guard counts sessions, not runs

    Scenario: Dropping placeholder runs is accepted
      Given the last good catalog has 953 sessions with 2 runs each
      When Microsoft's catalog lists the same 953 sessions with 1 run each
      Then the sync accepts the catalog
      And the catalog keeps all 953 sessions

    Scenario: Losing sessions is refused even when extra runs keep the count up
      Given the last good catalog has two hundred sessions
      When Microsoft's catalog lists 119 of them with 3 runs each
      Then the sync keeps the last good catalog

  Rule: A refusal explains itself

    Scenario: A partial catalog is diagnosed
      Given the last good catalog has two hundred sessions
      When Microsoft's catalog lists ninety of them
      Then the refusal shows the session counts with up to ten of the missing sessions
      And it says whether every missing session was a placeholder

    Scenario: Only placeholders went missing
      Given the last good catalog holds a hundred placeholder sessions that have neither a room nor a time
      When Microsoft's catalog lists everything but those
      Then the refusal says every missing session was a placeholder

  Rule: A refused catalog can be accepted from a phone

    Scenario: Accepting a partial catalog
      Given the sync refused a catalog that lists ninety of two hundred sessions
      When Minesh runs the workflow accepting a partial catalog
      Then the ninety sessions become the catalog
      And the change log records who accepted it

    Scenario: Acceptance covers one run only
      Given Minesh accepted a partial catalog
      When the next run loses half the sessions again
      Then the sync keeps the last good catalog

  Rule: A feed whose field shapes changed is refused, never read as empty

    Scenario: The room field arrives in a new shape
      Given the last good catalog has rooms for four hundred sessions
      When Microsoft's feed carries every room in a shape the sync has never seen
      Then the sync keeps the last good catalog
      And the refusal names the room field with an example of the new shape

    Scenario: A few odd records are not a format change
      When one session in twenty carries a room in an unknown shape
      Then the sync accepts the catalog

    Scenario: Unpublished values are blank, not a new shape
      When every session's room is still blank
      Then the sync accepts the catalog

    Scenario: The browser agrees with the sync
      When the live check reads a feed whose room field changed shape
      Then it refuses the feed with the same words as the sync

  Rule: A value that is not published yet is never a room or a time

    Scenario: A test room is not a room
      Given a session has a time
      When the catalog gives it a test room
      Then the session shows "Room TBA"
      And it is not counted among the sessions with rooms

    Scenario: An end time after the event is a placeholder
      Given a session starts on the second day of the event
      When the catalog gives it an end time of 31 December
      Then its end time comes from its length
      And the end is counted among the placeholder times ignored

    Scenario: The browser counts placeholders like the sync
      When the live check reads a catalog full of placeholders
      Then it counts the same published sessions as the sync

  Rule: Change notices tell runs apart from sessions

    Scenario: A dropped run is not reported as a cancelled session
      Given a session in the catalog has 2 runs
      When one of its runs is dropped
      Then the change notice reports 1 extra run dropped
      And the change notice reports 0 sessions removed

    Scenario: A new session with several runs is one session and its extra runs
      Given Microsoft adds a session with 3 runs
      Then the change notice reports 1 session added
      And the change notice reports 2 extra runs added

    Scenario: A session dropped with all its runs is one session and its extra runs
      Given a session in the catalog has 2 runs
      When the whole session is dropped
      Then the change notice reports 1 session removed
      And the change notice reports 1 extra run dropped

    Scenario: Every short summary counts the same way
      Given a change with 1 session added and 2 extra runs dropped
      Then the Changes tab headers, the live header and the sync log line each show 1 added and 2 extra runs dropped
      And none of them shows a removed session

  Rule: A sync that hangs does not stop the next one

    Scenario: The site publish of one run never finishes
      Given a sync run has been waiting on the site publish since the morning
      When the next scheduled sync starts
      Then the waiting run is cancelled in favour of the new one
      And no production issue is opened for the cancelled run
