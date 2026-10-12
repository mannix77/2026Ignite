Feature: A GitHub issue for every production problem
  The scheduled syncs and the deploy can hit problems the code can't fix by itself, such as a
  catalog it refuses or a failing deploy. Each problem becomes one GitHub issue, so it can be
  dealt with later instead of being lost in a stream of failure emails.

  Rule: A new problem opens one issue

    Scenario: A refused Ignite sync opens a production issue
      Given there is no open production issue
      When the Ignite sync refuses a catalog that lost half its sessions
      Then a production issue explains the refusal
      And the issue links to the failed run

    Scenario: A different problem opens its own issue
      Given a production issue is open for a refused Ignite sync
      When the Ignite deploy fails
      Then a second production issue is opened for the deploy

  Rule: The same problem again updates its issue instead of adding noise

    Scenario: A repeat of the same refusal updates the existing issue
      Given a production issue is open for a refused Ignite sync
      When the next run refuses the catalog again with slightly different counts
      Then no new issue is opened
      And the existing issue shows it happened twice

  Rule: Problems close themselves when the workflow recovers

    Scenario: A successful run closes that workflow's open issues
      Given a production issue is open for the Ignite sync
      And a production issue is open for the re:Invent sync
      When the Ignite sync next succeeds
      Then the Ignite issue is closed with a link to that run
      And the re:Invent issue stays open
