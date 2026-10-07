Feature: Importing the re:Invent session catalog
  So that an attendee can plan re:Invent alongside Ignite and Gartner,
  the planner keeps a normalized copy of the public AWS catalog and
  a log of every change to it.

  Rule: Repeat runs of a session are one choice

    Example: The one where a session runs three times
      Given the Iceberg analytics talk is listed three times, at three different times
      When the catalog is imported
      Then the planner treats the three runs as one session to choose a time for
      And no run title carries the "[REPEAT]" marker

  Rule: Sponsored sessions name their sponsor as a vendor

    Example: The one with a partner-sponsored breakout
      Given "DVT212-S" is a breakout sponsored by CodeRabbit
      When the catalog is imported
      Then the session is listed with CodeRabbit as its vendor

  Rule: Self-paced sessions stay in the catalog without a slot

    Example: The one with a self-paced gamified session
      Given a gamified-learning session is self-paced, with no scheduled slot
      When the catalog is imported
      Then the session is kept with no start time
      And it needs no seat reservation

  Rule: Every scheduled in-person session needs a reserved seat

    Example: The one with a scheduled chalk talk
      Given a chalk talk is scheduled on Monday at 16:30 Pacific
      When the catalog is imported
      Then the session needs a seat reservation
      And it starts at 00:30 UTC on Tuesday

  Rule: A refresh that loses most of the catalog is refused

    Example: The one where the catalog comes back half empty
      Given the last import held 2169 sessions
      When a refresh returns only 1000 sessions
      Then the saved catalog still holds 2169 sessions

  Rule: A refresh that loses most session times or rooms is refused

    Example: The one where AWS renames the start-time field
      Given the last import held 20 sessions with times
      When a refresh returns every session but none of their times
      Then the saved catalog still shows the 20 sessions with times

    Example: The one where the times really were withdrawn
      Given the last import held 20 sessions with times
      And the maintainer confirms the withdrawal is real
      When a refresh returns every session but none of their times
      Then the saved catalog shows no session times

  Rule: Every change between imports is logged

    Example: The one where a session moves room
      Given the Iceberg analytics talk was in Grand 122 at the MGM Grand
      When a refresh shows it in Room 301 at the MGM Grand
      Then the change log records that the Iceberg analytics talk moved room
