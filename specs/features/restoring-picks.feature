Feature: Seeing what a backup or link will change before it is applied
  Restoring a backup or opening a picks link used to ask an OK/Cancel question where
  Cancel meant "merge". People see exactly what will change, and choose with clearly
  labelled actions.

  Rule: Nothing changes until a choice is made

    Scenario: A backup's changes are listed before they are applied
      Given Minesh rated "Signature Series: CEO Watch 2026" as Want
      And his backup has it as Must, plus two sessions he hasn't rated
      When Minesh opens the backup
      Then he sees 1 changed rating, 2 new picks
      And his picks are unchanged

    Scenario: Cancelling applies nothing
      Given Minesh is looking at a backup's changes
      When Minesh cancels
      Then his picks are unchanged

  Rule: Adding to what's here keeps what only this device knows

    Scenario: Adding a backup keeps notes and reserved seats on this device
      Given Minesh wrote a note on a session on this phone
      And Minesh reserved a seat for it
      When Minesh adds a backup that rates the same session
      Then the note is still there
      And the reserved seat is still there

    Scenario: The changes applied are exactly the ones shown
      Given Minesh is looking at a backup's changes
      When Minesh adds the backup to what's here
      Then every change he was shown has been made
      And nothing else has changed

  Rule: Replacing says what it will remove

    Scenario: Replacing lists the picks that are not in the backup
      Given Minesh rated a session that his backup doesn't have
      When Minesh considers replacing everything with the backup
      Then he is told that session's rating would be removed

  Rule: A picks link is previewed the same way

    Scenario: A link's changes are shown before they are applied
      Given an assistant sent Gino a link rating three sessions
      When Gino opens the link
      Then he sees what the link will change
      And his picks are unchanged until he applies it
