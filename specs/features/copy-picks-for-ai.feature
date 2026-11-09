Feature: Handing my picks to an AI assistant
  An assistant that updates someone's picks should start from what they already have, not
  guess or scrape the screen. One button copies a readable list the assistant can read back
  as an import link.

  Rule: The copy lists every rated session with what the person decided

    Scenario: A rated list is copied
      Given Minesh rated three sessions, one each of Must, Want, Skip
      When he copies his picks for an AI
      Then each line names the code, the rating, the day with the time, then the title

    Scenario: Scores, watch-later and notes travel with the line
      Given a Want with his score of 87.5, kept for the recording, with a note
      When he copies his picks for an AI
      Then the line shows the score, says watch later, then ends with the note

    Scenario: A locked run is named
      Given a Must locked to its Thursday run
      When he copies his picks for an AI
      Then the line names the run he will attend

    Scenario: Unrated sessions are left out
      Given a session he never rated
      When he copies his picks for an AI
      Then that session is not in the copy

  Rule: The copy explains how to answer with an import link

    Scenario: The format reminder
      When Minesh copies his picks for an AI
      Then the copy ends with the token format, the rating digits, then the address of the guide

  Rule: Notes stay out of share links

    Scenario: The same picks as a share link
      Given a pick with a note
      When Minesh copies a link to his picks
      Then the link carries the rating without the note
