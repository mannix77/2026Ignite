Feature: An AI assistant can update Gino's picks with one link
  Gino asks his AI assistant to rate sessions for him. The assistant reads the guide
  published with each copy of the planner, builds an import link from the catalog,
  and sends it to Gino, who opens it on his own phone.

  Rule: The guide's import examples import the ratings it says they do

    Scenario: Following the worked example in the guide
      Given the guide's example link rates AIM314-R Must with the AIM314-R1 run locked
      When Gino opens the example link in his own planner
      Then AIM314-R is a Must
      And its AIM314-R1 run is locked

    Scenario: A rating the guide calls invalid is ignored
      Given the guide says a rating of 4 is not accepted
      When Gino opens a link that rates BRK201 with 4
      Then BRK201 is not imported

  Rule: Each copy's guide points at that copy

    Scenario: Gino's copy publishes a guide with Gino's address
      Given the planner has a copy for Gino
      When the site is published
      Then Gino's guide gives links under Gino's copy
      And the main site's guide gives links under the main site

    Scenario: Gino finds where his copy's guide lives
      Given Gino uses his own copy of the planner
      When he looks for the guide for AI assistants
      Then he is pointed at the guide in Gino's copy
