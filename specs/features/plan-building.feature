Feature: The plan is the best day the rules allow
  The plan page promises the most valuable day Minesh can actually walk. The planner's own
  random check prices plans with the planner's own arithmetic, so a wrong weight or a wrong
  walking rule would agree with itself. These are the rules as the Settings page states them,
  with its default numbers; an independent check holds the planner to them at all three venues.

  Rule: A session is worth its tier, adjusted for recording and format

    Scenario: A Must that is not recorded
      Given a Must breakout that will not be recorded
      When the planner builds the plan
      Then the breakout is worth 110 points

    Scenario: A recorded Maybe lab
      Given a Maybe lab that will be recorded
      When the planner builds the plan
      Then the lab is worth 15 points

    Scenario: A workbook score replaces the tier
      Given a Must with a workbook score of 7
      When the planner builds the plan
      Then the session is worth 70 points

  Rule: A move between rooms takes the walk plus a 2-minute buffer, and a keynote 15 minutes more

    Scenario: Five minutes missed between buildings is accepted at a cost
      Given a Want in Moscone South ends 11 minutes before a Want at the Marriott starts
      When the planner builds the plan
      Then both Wants are planned for 90 points

    Scenario: An easy move beats a tight one worth a little more
      Given a Want in Moscone South ends 11 minutes before a Want at the Marriott starts
      And a recorded Want lab starts at the same time in the same South room
      When the planner builds the plan
      Then the lab is planned, for 95 points

    Scenario: Six minutes missed is too many
      Given a Want in Moscone South ends 10 minutes before a Want at the Marriott starts
      When the planner builds the plan
      Then only one Want is planned

    Scenario: A 19-minute session can only be missed by 4 minutes
      Given a Want in Moscone South ends 11 minutes before a 19-minute Want at the Marriott
      When the planner builds the plan
      Then only one Want is planned

    Scenario: Getting into a keynote one floor up
      Given a Want on level 2 of Moscone West ends 22 minutes before a keynote on level 3
      When the planner builds the plan
      Then both are planned for 100 points

    Scenario: Too little time to get into the keynote
      Given a Want on level 2 of Moscone West ends 16 minutes before a keynote on level 3
      When the planner builds the plan
      Then only one is planned

  Rule: Lunch fits only in a gap with room for the walk

    Scenario: A gap one minute short of lunch and the walk
      Given a Want in Moscone West ends at noon
      And a Want in Moscone South starts at 12:38
      When the planner builds the plan with lunch worth 40
      Then both Wants are planned without lunch, for 100 points

    Scenario: A gap just long enough for lunch and the walk
      Given a Want in Moscone West ends at noon
      And a Want in Moscone South starts at 12:39
      When the planner builds the plan with lunch worth 40
      Then the plan holds both Wants with lunch, for 140 points

  Rule: Locked sessions and blocked time stay in the plan

    Scenario: A locked Maybe beats a Must at the same time
      Given a locked Maybe overlaps a Must
      When the planner builds the plan
      Then the Maybe is planned in place of the Must

    Scenario: A Must during blocked time
      Given blocked time in Moscone West overlaps a Must
      When the planner builds the plan
      Then the blocked time is planned in place of the Must

  Rule: No plan the rules allow is worth more than the planner's

    Scenario: Small random weeks at Moscone, Las Vegas and the Swan and Dolphin
      Given 300 small random weeks mixing locks, blocked time, lunch windows, repeat runs
      When the planner builds a plan for each
      Then each plan is worth as much as the best combination found by trying them all
