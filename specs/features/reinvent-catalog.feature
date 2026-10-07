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

    Example: The one where the sponsor is named after a dash
      Given "GHJ308-S-R" is titled "Agentic AI Jam - sponsored by Nvidia"
      And it lists no sponsor speaker
      When the catalog is imported
      Then the session names Nvidia as its vendor

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

  Rule: A catalog fetch that stops early is refused

    Example: The one where a page comes back as an error
      Given the AWS catalog reports 2169 sessions
      When the third page of the catalog comes back as an error
      Then the refresh is refused
      And the saved catalog is unchanged

    Example: The one where paging ends short of the total
      Given the AWS catalog reports 2169 sessions
      When paging ends after 2100 sessions
      Then the refresh is refused

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

  Rule: A broken record is skipped, never fatal

    Example: The one with an empty record in the feed
      Given the catalog feed holds an empty record among 21 sessions
      When the catalog is imported
      Then the 21 sessions are imported
      And the empty record is counted as malformed

    Example: The one with a garbled speaker entry
      Given the Iceberg analytics talk lists a garbled speaker entry
      When the catalog is imported
      Then the talk is imported with its other speakers

  Rule: A run the planner can't show is reported, not silently dropped

    Example: The one where a session lists two times
      Given the Iceberg analytics talk lists two scheduled times
      When the catalog is imported
      Then the talk is imported at its first time
      And the import reports the extra run

  Rule: Every change between imports is logged

    Example: The one where a session moves room
      Given the Iceberg analytics talk was in Grand 122 at the MGM Grand
      When a refresh shows it in Room 301 at the MGM Grand
      Then the change log records that the Iceberg analytics talk moved room
