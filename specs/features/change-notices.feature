Feature: A catalog change is announced once, after it is saved
  The sync workflows post what changed to a tracking issue. The announcement follows the
  saved catalog, so a change that was not saved is never announced, and one that was
  announced is not announced again.

  Rule: Nothing is announced until the catalog is pushed

    Scenario: The push fails
      Given a sync found changes
      When the catalog could not be pushed
      Then nothing is posted to the tracking issue
      And the next run finds the same changes and announces them once

  Rule: A summary that could not be posted is retried, once

    Scenario: Posting fails
      Given the catalog was pushed with its summary pending
      When the summary could not be posted
      Then the summary stays pending
      And the next run posts it once

    Scenario: Posted, but the pending file was not cleared
      Given a summary is already on the issue
      When a later run still finds it pending
      Then it is not posted again
      And it is cleared

    Scenario: Several summaries are waiting
      Given two summaries are pending and the second fails to post
      Then the first is posted and cleared, and the second stays pending
