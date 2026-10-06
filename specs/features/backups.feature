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
