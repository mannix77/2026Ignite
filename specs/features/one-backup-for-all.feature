Feature: One backup file for every conference on this device
  Someone going to Ignite, Gartner and re:Invent used to need three backup files and had to
  remember all three. One file now covers every conference on the device, and restoring it
  puts each conference's picks back in their own place.

  Rule: Save a backup writes every conference the device has picks or settings for

    Scenario: Two conferences in one file
      Given Minesh rated sessions at Ignite, with blocked time set
      And Gino's copy aside, Minesh also rated sessions at Gartner on this device
      When Minesh saves a backup
      Then the file holds Ignite's picks with their settings
      And the file holds Gartner's picks too

    Scenario: A conference never touched is left out
      Given Minesh has nothing saved for re:Invent
      When Minesh saves a backup
      Then the file has no re:Invent part

    Scenario: A conference whose saved data cannot be read is named
      Given Gartner's saved data on this device cannot be read
      When Minesh saves a backup
      Then Minesh is told Gartner is not in the file

    Scenario: Saving counts as a backup for every conference in the file
      Given Gartner has picks not yet backed up
      When Minesh saves a backup while viewing Ignite
      Then Gartner no longer reminds Minesh to back up

  Rule: Restore puts each conference back in its own place

    Scenario: A fresh device
      Given a backup with Ignite picks together with Gartner picks
      And a device with no picks at all
      When Minesh restores the backup while viewing Ignite
      Then Ignite shows the backup's Ignite picks
      And switching to Gartner shows the backup's Gartner picks

    Scenario: Adding keeps newer ratings in every conference
      Given a Gartner session rated Want on this device after the backup was made
      And the backup rates that session Skip
      When Minesh adds the backup to what is here
      Then the Gartner session is still Want

    Scenario: An old single-conference backup still restores
      Given a backup file made before backups covered every conference
      When Minesh restores it
      Then it restores as it always did

  Rule: Restoring never loses what is already saved on the device

    Scenario: Unreadable saved data is kept aside
      Given Gartner's saved data on this device cannot be read
      When Minesh restores a backup holding Gartner picks
      Then the unreadable Gartner data is kept as a copy
      And Gartner has the backup's picks

    Scenario: Data saved by a newer version is left alone
      Given Gartner was last saved by a newer version of the planner
      When Minesh restores a backup holding Gartner picks
      Then Gartner's saved data is unchanged
      And Minesh is told Gartner was not restored

    Scenario: The conference on screen was saved by a newer version
      Given Ignite was last saved by a newer version of the planner
      When Minesh restores a backup holding Ignite picks while viewing Ignite
      Then Ignite's saved data is unchanged
      And Minesh is told Ignite was not restored

    Scenario: A damaged conference in the file is left out
      Given a backup whose Gartner part cannot be read
      When Minesh restores it while viewing Ignite
      Then Ignite has the backup's picks
      And Minesh is told Gartner was not restored

    Scenario: A conference that cannot be written is named
      Given the device's storage is too full for Gartner's restored picks
      When Minesh restores a backup holding Gartner picks
      Then Minesh is told Gartner was not restored

    Scenario: The conference on screen cannot be written
      Given the device's storage is too full for Ignite's restored picks
      When Minesh restores a backup holding Ignite picks while viewing Ignite
      Then Minesh is told Ignite was not restored

    Scenario: A damaged blocked time in the file is dropped
      Given a backup whose Ignite settings hold a blocked time with an unreadable day
      When Minesh replaces Ignite's data with the backup
      Then Ignite has the backup's picks
      And Ignite keeps the backup's other blocked times

  Rule: A backup belongs to the copy of the site it was made in

    Scenario: Restoring the main copy's backup in a colleague's copy
      Given a backup saved in the main copy of the site
      When Gino restores it in his copy
      Then he is warned that the backup was made in another copy before anything changes
