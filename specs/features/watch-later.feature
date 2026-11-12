Feature: Watch later never promises a recording that doesn't exist
  "Watch the recording instead of attending" parks a session outside the live plan without
  rating it Skip. For a session confirmed not recorded, that promise is simply false, so the
  option and the list it feeds are honest about which sessions have no recording to catch
  (issue #152).

  Rule: The detail view never offers a recording that won't exist

    Scenario: A confirmed-unrecorded session has no "watch the recording" checkbox
      Given a session confirmed not recorded
      When its detail view is open
      Then there is no "Watch the recording instead of attending" checkbox

    Scenario: A session whose recording status is unknown still offers the checkbox
      Given a session whose recording status is unknown
      When its detail view is open
      Then the "Watch the recording instead of attending" checkbox is offered

    Scenario: A recorded session still offers the checkbox
      Given a session confirmed recorded
      When its detail view is open
      Then the "Watch the recording instead of attending" checkbox is offered

  Rule: A session already parked before its recording status turned out false is flagged, not hidden

    Scenario: A session's recording status is confirmed false after it was parked
      Given a session was parked in Watch later while its recording status was unknown
      When a catalog sync confirms the session is not recorded
      Then the session stays listed under Watch later
      And its entry notes that it is not recorded
