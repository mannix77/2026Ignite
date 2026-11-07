Feature: Knowing a room is full before walking there
  During Ignite the official map reports how full each room is. The planner shows that next
  to the room, so a full room is not a wasted walk, and it never passes off an old reading as
  live or guesses at one it cannot read.

  Rule: A room's fullness shows next to the room while the reading is fresh

    Scenario: A room the feed calls full
      Given the feed read ten minutes ago calls the room full
      When Minesh looks at a session in that room
      Then the session shows "Room full"

    Scenario: A room that is filling up
      Given the feed read ten minutes ago has the room four fifths occupied
      When Minesh looks at a session in that room
      Then the session shows "Filling"

    Scenario: A room with space
      Given the feed read ten minutes ago has the room a third occupied
      When Minesh looks at a session in that room
      Then the session shows nothing about fullness

    Scenario: A reading too old to trust
      Given the feed was read forty minutes ago
      When Minesh looks at a session in that room
      Then the session shows nothing about fullness

  Rule: A reading the planner cannot make sense of is left out, never shown wrong

    Scenario: A room with a value the planner does not understand
      Given the feed gives the room a reading of an unknown kind
      When Minesh looks at a session in that room
      Then the session shows nothing about fullness

  Rule: The feed is captured only while it reads cleanly

    Scenario: The feed reports failure
      Given the last capture of the feed was good
      When the feed reports failure
      Then the last good capture is kept

    Scenario: The feed holds junk next to good rooms
      When the feed lists rooms with a few junk entries among them
      Then the good rooms are captured
      And the junk entries are counted
