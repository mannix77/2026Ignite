Feature: Ranking the catalog for an attendee's role
  Each conference names its audiences differently, so a role maps to what fits it.
  For an Enterprise Architect that is track D, the Enterprise Architecture spotlight and
  the Enterprise Architecture topic at Gartner (our call: Gartner publishes no role
  agendas), and the "Solution / Systems Architect" and "IT Executive" audiences at
  re:Invent.

  Rule: Sessions that fit the chosen role head the shortlist

    Scenario: Enterprise Architecture sessions rank first at Gartner
      Given Minesh is an Enterprise Architect attending Gartner IT Symposium/Xpo 2026
      And the role is Minesh's only preference
      When Minesh opens the shortlist
      Then every session that fits an Enterprise Architect is listed first
      But "Architecting Value in the Agentic AI Era" is listed after them

    Scenario: Architect sessions rank first at re:Invent
      Given Minesh is an Enterprise Architect attending AWS re:Invent 2026
      And the role is Minesh's only preference
      When Minesh opens the shortlist
      Then every session that fits an Enterprise Architect is listed first
      But a session for IT managers is listed after them

  Rule: Sessions that rank equal are listed earliest first, then by session code

    Scenario: Equal sessions at different times
      Given two sessions rank equal for Minesh
      And the later one has the lower session code
      When Minesh opens the shortlist
      Then the earlier one is listed first

    Scenario: Equal sessions at the same time
      Given two sessions rank equal for Minesh
      And they start at the same time
      When Minesh opens the shortlist
      Then they are listed by session code

    Scenario: An equal session with no time yet
      Given two sessions rank equal for Minesh
      And only one of them has a time
      When Minesh opens the shortlist
      Then the one with a time is listed first

    Scenario: An equal session that runs more than once
      Given two sessions rank equal for Minesh
      And one of them has its first run before the other session
      When Minesh opens the shortlist
      Then the session with the earlier first run is listed first
