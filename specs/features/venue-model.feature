Feature: Walking times reach every building the catalog uses
  The planner only trades sessions off well when it knows where each room is. Ignite put
  89 sessions in the Metreon (the AMC theaters on level 3 and The Aviary on the roof), a
  block from Moscone West. A room in a building the model does not know gets a guessed walk,
  and nobody hears about it.

  Rule: The Metreon is a building of its own

    Scenario: A session in an AMC Metreon theater
      When the catalog places a session in "AMC Metreon | Level 3, Theater 9"
      Then the planner puts it in the Metreon on level 3

    Scenario: A session at The Aviary
      When the catalog places a session in "The Aviary, Labs"
      Then the planner puts it in the Metreon on level 4

    Scenario: Walking from the Metreon to Moscone West
      Given a session in the Metreon
      When the next session is in Moscone West
      Then the walk between them is 5 minutes

    Scenario: The Metreon can be tuned in Settings
      When Minesh opens the walking matrix in Settings
      Then it has a Metreon row

  Rule: A room in an unknown building is announced the first time it appears

    Scenario: A sponsor opens a new venue
      Given the last catalog had no room at "Sponsor Pavilion, Stage 2"
      When the sync finds 3 sessions in "Sponsor Pavilion, Stage 2"
      Then the change notice names "Sponsor Pavilion, Stage 2" as a room in an unknown building

    Scenario: The same unknown room on the next run
      Given the last catalog already had "Sponsor Pavilion, Stage 2"
      When the sync runs again
      Then the change notice does not mention an unknown building

    Scenario: A placeholder is not a room
      When the sync finds sessions whose room is still a placeholder
      Then the change notice does not mention an unknown building
