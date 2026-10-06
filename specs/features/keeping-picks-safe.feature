Feature: Keeping picks safe on the device
  Picks are stored only in the browser or installed app that shows the planner. People
  should see whether their picks will last, and get nudged to install the app and keep a
  backup before it matters.

  Rule: The app says how picks are being kept

    Scenario: The installed app reports that picks are kept
      Given Gino opened the planner from his Home Screen
      When Gino looks at his data settings
      Then he is told his picks are saved in this installed app

    Scenario: A browser tab without protected storage suggests installing
      Given Gino rates sessions in a Safari tab
      And the browser has not protected the site's storage
      When Gino looks at his data settings
      Then he is told the browser may clear his picks
      And he is shown how to install the app

    Scenario: Storage that can't be written is reported as not saved
      Given the browser refuses to save
      When Gino looks at his data settings
      Then he is told his changes are not being saved

  Rule: People are reminded to keep a backup

    Scenario: Many changes since the last backup prompt a reminder
      Given Minesh saved a backup yesterday
      When Minesh changes 20 picks
      Then he is reminded to save a backup

    Scenario: A week-old backup prompts a reminder
      Given Minesh's last backup is 8 days old
      When Minesh opens the planner
      Then he is reminded to save a backup

    Scenario: The day before a conference prompts a reminder
      Given Minesh changed a Gartner pick since his last backup
      When Minesh opens the planner the day before Gartner starts
      Then he is reminded to save a backup

    Scenario: A fresh backup silences the reminder
      Given Minesh was reminded to save a backup
      When Minesh saves a backup
      Then the reminder is gone
      And his data settings say the last backup was today
