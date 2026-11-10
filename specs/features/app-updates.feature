Feature: A new version of the planner installs its own files
  The planner keeps a copy of its app files on the phone so it works on conference Wi-Fi.
  Right after a deploy the site's cache can still hand out the previous files for a while,
  and a copy made from those would keep the old app until the next deploy.

  Rule: A new version saves only files fetched fresh for that version

    Scenario: The site's cache still holds the previous files right after a deploy
      Given a new version of the planner has just been published
      And the site still hands out the previous files at their usual addresses
      When Gino's phone installs the new version
      Then the offline copy holds the new version's files

  Rule: A version is installed only once all its files are saved

    Scenario: One app file can't be fetched while a new version installs
      Given Gino is using the current version of the planner
      When a new version can't fetch one of its app files
      Then nothing of the new version is kept
      And Gino keeps the current version until the next try

    Scenario: The phone runs out of space while a new version saves its files
      Given Gino is using the current version of the planner
      When his phone runs out of space while a new version saves its app files
      Then nothing of the new version is kept
      And Gino keeps the current version until the next try

    Scenario: An update that leaves the app files unchanged runs out of space
      Given Gino's offline copy already holds this version's app files
      When an update to the offline handling alone runs out of space saving them again
      Then Gino keeps the offline copy he is using
