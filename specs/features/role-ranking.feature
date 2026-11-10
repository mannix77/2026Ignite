Feature: Ranking the catalog for an attendee's role
  Each conference names its audiences differently, so a role maps to what fits it.
  For an Enterprise Architect that is track D, the Enterprise Architecture spotlight and
  the Enterprise Architecture topic at Gartner (our call: Gartner publishes no role
  agendas), and the "Solution / Systems Architect" and "IT Executive" audiences at
  re:Invent. Sessions that rank equal are listed by session code.

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
