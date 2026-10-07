Feature: A change is saved even when you leave straight away
  The planner saves a moment after each change, so a burst of edits is written once.
  Leaving the page in that moment must not lose the last change.

  Rule: Hiding or leaving the page saves the change just made

    Scenario: Switching conference right after rating a session
      Given Gino has just rated a session Must
      When he switches to another conference straight away
      Then the Must rating is there when he comes back

    Scenario: Putting the phone away right after adding a note
      Given Gino has just added a note to a session
      When he locks his phone straight away
      Then the note is there when he opens the planner again
