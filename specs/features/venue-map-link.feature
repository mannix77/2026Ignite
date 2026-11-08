Feature: Finding the room on the official map
  Ignite publishes an indoor map with every room, floor and a drawn route, reachable by a link
  that names the room and the session. The planner knows both for every session, so one tap
  takes Minesh from "which way do I go" to the room on that map, and no map has to be drawn.

  Rule: A session with a published room links to its room on the official map

    Scenario: A breakout with a room
      Given a breakout in Moscone West, Level 3, Room 3014
      When Minesh looks at the session
      Then the Map link opens the official map at that room for that session

    Scenario: A room with commas and symbols in its name
      Given a table talk at Esplanade Ballroom, Table 9, on the Upper Mezzanine of Moscone South
      When Minesh looks at the session
      Then the Map link carries the whole room name unchanged

  Rule: No room, no link

    Scenario: A room that is still a placeholder
      Given a breakout parked in a rescheduling room
      When Minesh looks at the session
      Then there is no Map link

    Scenario: An online-only session
      Given a pre-recorded session that is online only
      When Minesh looks at the session
      Then there is no Map link

    Scenario: A conference without an official map
      Given a Gartner session in Lark 1 at the Swan
      When Minesh looks at the session
      Then there is no Map link
