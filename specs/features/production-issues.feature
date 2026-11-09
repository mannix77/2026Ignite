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

    Scenario: A failed re:Invent redeploy request opens an issue instead of closing them
      Given a production issue is open for the re:Invent sync
      When the re:Invent sync succeeds but its request to redeploy the site fails
      Then a production issue is opened for the redeploy
      And the open re:Invent issue is not closed

  Rule: A one-off deploy failure is retried before it becomes a problem

    Scenario: A deploy that fails once succeeds on the retry
      Given the Ignite deploy fails on its first attempt
      When the deploy is tried again after 60 seconds and succeeds
      Then the run succeeds
      And no production issue is opened

    Scenario: A deploy that fails twice still opens an issue
      Given the Ignite deploy fails on its first attempt
      When the retry after 60 seconds fails too
      Then a production issue is opened for the deploy

    Scenario: A deploy that succeeds the first time is not retried
      When the Ignite deploy succeeds on its first attempt
      Then there is no wait and no second deployment

  Rule: The issue carries the diagnosis

    Scenario: A refused sync explains itself in the issue
      When the Ignite sync refuses a catalog
      Then the production issue shows the refusal's diagnosis

    Scenario: A repeat refreshes the diagnosis
      Given a production issue is open for a refused Ignite sync
      When the next run refuses the catalog with other examples
      Then the same issue shows the new diagnosis

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
