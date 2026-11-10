Feature: Suggesting sessions like the ones Minesh picked
  With hundreds of sessions left unrated, Minesh wants the few that most resemble his picks
  listed first, each with the reason it was suggested, so he can judge a suggestion at a glance.

  Rule: Suggestions start once two sessions are picked

    Scenario: One pick is not enough to suggest anything
      Given Minesh has picked one session
      When the suggestions are worked out
      Then no session is suggested

    Scenario: Two picks are enough
      Given Minesh has picked two sessions
      When the suggestions are worked out
      Then sessions like his picks are suggested

    Scenario: A device with no picks yet
      Given Minesh has picked nothing
      When the suggestions are worked out
      Then no session is suggested

  Rule: A session that shares something with a pick ranks above an unrelated one

    Scenario: The same speaker
      Given Minesh picked a session by Ada Lovelace
      When the suggestions are worked out
      Then another session by Ada Lovelace ranks above an unrelated session
      And it says "Speaker you picked elsewhere: Ada Lovelace"

    Scenario: The same track
      Given Minesh picked two sessions on the "Cloud" track
      When the suggestions are worked out
      Then another "Cloud" session ranks above an unrelated session

    Scenario: The same topic
      Given Minesh picked two sessions on the "Security" topic
      When the suggestions are worked out
      Then another "Security" session ranks above an unrelated session

    Scenario: Wording shared with a pick
      Given Minesh picked a session about Terraform fleet operations
      When the suggestions are worked out
      Then a session about Terraform fleets ranks above an unrelated session

  Rule: A pick Minesh wants more pulls harder

    Scenario: A Must outweighs a Maybe
      Given Minesh wants a "Cloud" session more than a "Science" session
      When the suggestions are worked out
      Then another "Cloud" session ranks above another "Science" session

  Rule: Only the sessions Minesh wants shape the suggestions

    Scenario: A pick with no weight attracts nothing
      Given a pick carries no weight
      When the suggestions are worked out
      Then a session that shares everything with it is not suggested

    Scenario: The planner knows which sessions are already picked
      Given Minesh has picked two sessions
      When the suggestions are worked out
      Then both are known as picked
      And an unrated session is not

  Rule: Damaged catalog records are skipped, never fatal

    Scenario: Malformed records among good ones
      Given the catalog has malformed records
      When the suggestions are worked out
      Then every session gets a score
      And a well-formed session like Minesh's picks is still suggested
