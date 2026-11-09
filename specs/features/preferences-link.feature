Feature: Setting Triage preferences from a link
  Deciding whole groups at once is the biggest time saver in Triage, and an assistant cannot
  click through it. A link carries the quick-start answers and whole-group choices; opening it
  shows what it would change and asks before applying. It never rates a session.

  Rule: The link sets preferences, never ratings

    Scenario: Skipping a whole group
      Given a Gartner preferences link whose group choice hides the "Solution Provider Sessions" kind of session
      When Minesh confirms the link
      Then those sessions are hidden from Triage
      And none of them is rated

    Scenario: A link field replaces that preference
      Given Minesh's goals are architecture, strategy
      When he confirms a link that names only the AI goal
      Then his goals are AI alone

    Scenario: Group choices are added to the ones he has
      Given Minesh already wants the AI topic
      When he confirms a link that skips the Pre-recorded format
      Then he still wants the AI topic
      And the Pre-recorded format is skipped

  Rule: Nothing changes until Minesh confirms

    Scenario: Declining the link
      Given a preferences link whose group choice hides a format
      When Minesh declines the link
      Then his preferences are unchanged

  Rule: Values the conference does not have are left out and named

    Scenario: An unknown role next to a known goal
      Given a link with a role the conference does not offer, beside the AI goal
      When Minesh opens it
      Then the confirmation names the unknown role as left out
      And confirming sets the AI goal
