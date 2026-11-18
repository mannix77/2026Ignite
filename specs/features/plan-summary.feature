Feature: The top of My plan stays out of the way
  On a phone, a seat-reservation notice and four number tiles filled the screen before the
  day's plan began. Minesh wants the day in view when he opens My plan, with the totals in one
  line and only the numbers that need him.

  Rule: The plan's totals are one line, and a zero is left out

    Scenario: A plan with clashes and missed picks
      Given a plan of 21 sessions with 16 clashes to decide, no tight transfer and 57 picks missed
      When Minesh opens My plan
      Then one line reads 21 sessions in your plan, 16 clashes to decide, 57 picks you'll miss
      And the clashes are marked as needing attention

    Scenario: A plan with nothing to sort out
      Given a plan of 12 sessions with no clash, no tight transfer and no pick missed
      When Minesh opens My plan
      Then the line reads 12 sessions in your plan and nothing else

    Scenario: A single one of each
      Given a plan of 1 session with 1 clash, 1 tight transfer and 1 pick missed
      When Minesh opens My plan
      Then each total is worded in the singular

  Rule: The seat-reservation notice is one line until it is opened

    Scenario: Picks that need a seat
      Given 6 of Minesh's Must and Want picks need a seat reservation
      When Minesh opens My plan
      Then the notice says so in one line
      And how to reserve and which sessions show when he opens it

    Scenario: Reservations have not opened yet
      Given picks that need a seat whose reservations open later
      When Minesh opens My plan
      Then the notice also says when reservations open, without being opened
