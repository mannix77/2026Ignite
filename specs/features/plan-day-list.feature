Feature: The day list shows blocked time on a day with no planned session
  My plan's List view drew blocked time only between planned sessions. A day with blocked time
  and no planned session said "Nothing planned" and showed none of it, so the day looked free
  when it was not (issue #156). Blocked time is part of the day with or without a session.

  Rule: Blocked time is listed at its own time when no session is planned

    Background:
      Given Friday has no planned session

    Scenario: A day with only blocked time
      Given blocked time "Flight home" on Friday from 3:00 PM to 4:00 PM
      When Minesh opens Friday in the List view
      Then "Flight home" is listed from 3:00 PM to 4:00 PM as blocked time
      And the day still says "Nothing planned on Fri, Nov 20"

    Scenario: Blocked time and lunch are listed in time order
      Given blocked time on Friday from 8:00 AM to 9:00 AM
      And blocked time on Friday from 3:00 PM to 4:00 PM
      When Minesh opens Friday in the List view
      Then the rows are the 8:00 AM blocked time, lunch, then the 3:00 PM blocked time

    Scenario: A day with no blocked time
      Given Friday has no blocked time
      When Minesh opens Friday in the List view
      Then the day says "Nothing planned on Fri, Nov 20"
      And no row is listed under it
