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

  Rule: A backup belongs to the copy of the site it was made in

    Scenario: Restoring the main copy's backup in a colleague's copy
      Given a backup saved in the main copy of the site
      When Gino restores it in his copy
      Then he is warned that the backup was made in another copy before anything changes
