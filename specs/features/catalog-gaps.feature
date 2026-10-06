Feature: Living with an out-of-date catalog
  The Gartner catalog is a copy of one attendee's Conference Navigator export. It ages,
  and some events people register for never appear in it. Everyone using a copy of the
  planner should see how old it is, and be able to plan around what's missing.

  Rule: An export-based catalog says when it is getting old

    Scenario: A day-old export is flagged
      Given the Gartner catalog was exported 13 hours ago
      When 12 more hours pass
      Then Gino sees that the catalog is a day old
      And Gino sees who can refresh it

    Scenario: A fresh export is not flagged
      Given the Gartner catalog was exported 2 hours ago
      When Gino opens his plan
      Then no warning about the catalog's age is shown

    Scenario: The live Ignite catalog is never flagged as an old export
      Given the Ignite catalog was synced 3 days ago
      When Gino opens his plan
      Then no warning about an old export is shown

  Rule: A session missing from the catalog can be added to your own plan

    Scenario: A registered reception is planned with walking time
      Given the "Healthcare & Life Sciences Networking Reception" is not in the catalog
      When Gino adds it for Monday 6:15 PM to 8:00 PM at the Yacht & Beach Club
      Then his plan includes it as a Must
      And the walk to the Yacht & Beach Club is counted before it

    Scenario: An added session belongs only to the person who added it
      Given Gino added the reception to his copy of the planner
      When Minesh opens his own copy
      Then the reception is not in Minesh's plan

    Scenario: An added session that later appears in the catalog is pointed out
      Given Gino added the reception by hand
      When a fresh export lists the reception on the same day
      Then Gino is told his added copy is now in the catalog
