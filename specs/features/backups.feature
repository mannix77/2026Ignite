Feature: Restoring a backup never costs you the plan you have
  A backup moves a plan between devices, or back after a reset. Restoring one must never
  leave Gino with less than he had, whichever way he restores it.

  Rule: A backup with no picks the planner can read is refused before anything changes

    Scenario: Replacing the plan with a backup in an unreadable format
      Given Gino's plan has 12 rated sessions
      And a backup whose ratings this planner can't read
      When Gino restores it, replacing his plan
      Then Gino is told the backup has no picks the planner can read
      And Gino's plan still has its 12 rated sessions

    Scenario: Replacing the plan with a readable backup
      Given Gino's plan has 12 rated sessions
      And a backup with 3 rated sessions
      When Gino restores it, replacing his plan
      Then Gino's plan has the backup's 3 rated sessions

  Rule: Merging a backup never overwrites a newer change on this device

    Scenario: Merging a backup that doesn't say when its picks were made
      Given Gino locked "Iceberg tables" as a Must this morning
      And a backup that rates "Iceberg tables" Skip without saying when
      When Gino merges the backup into his plan
      Then "Iceberg tables" is still a locked Must

    Scenario: Merging a backup made after the change on this device
      Given Gino rated "Iceberg tables" Must yesterday
      And a backup made today that rates "Iceberg tables" Skip
      When Gino merges the backup into his plan
      Then "Iceberg tables" is rated Skip

    Scenario: An undated pick for a session not in the plan is still added
      Given Gino's plan doesn't include "Iceberg tables"
      And a backup that rates "Iceberg tables" Want without saying when
      When Gino merges the backup into his plan
      Then "Iceberg tables" is rated Want
