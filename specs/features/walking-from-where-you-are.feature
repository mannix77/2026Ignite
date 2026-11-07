@pending
Feature: Walking time starts from where I am standing, not from the building as a whole
  A building has more than one end. From the end nearest a neighbouring building the walk is
  shorter than from the far end, so the estimate should use the side I am on (issue 99).

  Rule: A known side gives a walk from that side

    Scenario: Standing at the end of the Dolphin nearest the Swan
      Given the Dolphin to Swan walk is 8 minutes from the far end and 4 from the Swan end
      And I say I am at the Dolphin, Swan end
      When I look at a session in the Swan
      Then it shows a 4 minute walk

    Scenario: Standing at the far end
      Given I say I am at the Dolphin, far end
      Then the same session shows an 8 minute walk

  Rule: An unknown side keeps today's estimate

    Scenario: I only say which building
      Given I say I am at the Dolphin without a side
      Then the same session shows the building-to-building estimate, not the shortest

  Rule: A position fix is used only when it is good enough

    Scenario: A precise fix picks the side
      Given my position is accurate to 15 metres and is nearest the Swan end of the Dolphin
      Then the walk is measured from the Swan end

    Scenario: A vague fix does not pick a side
      Given my position is accurate only to 200 metres
      Then the side stays unknown and the building-level estimate is used

  Rule: Sides are only defined where we know them

    Scenario: A building with no side data
      Given the venue defines no sides for the Marriott Marquis
      Then walks from it use the building-level estimate and no side choice is offered
