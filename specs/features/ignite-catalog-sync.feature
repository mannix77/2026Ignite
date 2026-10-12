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
