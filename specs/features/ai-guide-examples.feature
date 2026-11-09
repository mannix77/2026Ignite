Feature: The AI guide's example codes stay valid
  The guide for assistants shows a worked import link with real session codes. Catalogs
  change with every sync, so a code can vanish, and an assistant would copy an example that no
  longer imports cleanly. The sync checks the examples and says so, without ever holding up
  the deploy.

  Rule: A stale example is reported within one sync run

    Scenario: An example's session leaves the catalog
      Given the guide's worked example names a session the re:Invent catalog no longer lists
      When the scheduled sync runs
      Then an issue for the guide names the missing code with its conference
      And the deploy goes ahead

    Scenario: The same stale example on the next run
      Given an issue for the guide is already open
      When the next sync still finds the same code missing
      Then that issue is updated, not duplicated

    Scenario: The example is fixed
      Given an issue for the guide is open
      When a sync finds every example code in its catalog
      Then the issue is closed

  Rule: The check reads every import link in the guide

    Scenario: Codes in tokens and locked runs
      Given a worked example with a rating token, a scored token, a watch-later token, a locked run
      When the examples are checked
      Then every code is looked up, the locked run's included, in the conference the link names

    Scenario: A link to a conference without a catalog
      Given an example link for a conference whose catalog file is missing
      When the examples are checked
      Then that link is reported as unverifiable, not as stale
