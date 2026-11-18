Feature: The top of My plan stays out of the way
  On a phone, a seat-reservation notice and four number tiles filled the screen before the
  day's plan began. Minesh wants the day in view when he opens My plan, with the totals in one
  line and only the numbers that need him.

  Rule: The plan's totals are one line; a clash, tight-walk or missed total of zero is left out

    Scenario: A plan with clashes and missed picks
      Given a plan of 21 sessions with 16 clashes to decide, no tight walk and 57 picks missed
      When Minesh opens My plan
      Then one line reads 21 sessions, 16 clashes, 57 missed
      And the clashes are marked as needing attention

    Scenario: A plan with nothing to sort out
      Given a plan of 12 sessions with no clash, no tight walk and no pick missed
      When Minesh opens My plan
      Then the line reads 12 sessions and nothing else

    Scenario: A plan that fits no session
      Given picks of which none fits the plan
      When Minesh opens My plan
      Then the line still reads 0 sessions

    Scenario: All four totals on a phone
      Given a plan of 88 sessions with 88 clashes, 88 tight walks and 88 picks missed
      When Minesh opens My plan on a 375-point-wide phone
      Then 88 sessions, 88 clashes, 88 tight walks and 88 missed all show on one line

    Scenario: A single one of each
      Given a plan of 1 session with 1 clash, 1 tight walk and 1 pick missed
      When Minesh opens My plan
      Then each total is worded in the singular

  Rule: The seat-reservation notice is one line until it is opened

    Scenario: Picks that need a seat
      Given 6 of Minesh's Must and Want picks need a seat reservation
      When Minesh opens My plan
      Then the notice says 6 picks need a seat reservation, on one line on a 375-point-wide phone
      And how to reserve and which sessions show when he opens it

    Scenario: Before the schedule is published
      Given picks that need a seat, whose reservations are already open, and no published dates yet
      When Minesh opens My plan
      Then the notice shows how to reserve and which sessions without being opened
      And once Minesh closes it, it is still closed after the page is rebuilt

    Scenario: Reservations have not opened yet
      Given picks that need a seat whose reservations open later
      When Minesh opens My plan
      Then the notice also says when reservations open, without being opened
