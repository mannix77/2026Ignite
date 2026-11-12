Feature: Calendar exports stay in step with the plan
  "Add plan to calendar (.ics)" already publishes the resolved plan with stable per-session
  ids and walk-time alarms. What it never did: tell the calendar app when a session drops out
  of the plan, so a cancelled or un-locked session's event sat in the person's calendar
  forever. The next export now republishes a dropped session as cancelled, and a single
  session can be added on its own from its detail view without creating a duplicate entry if
  it's also in the bulk export (issue #147).

  Rule: A session that leaves the exported plan is cancelled, not left behind

    Scenario: A session exported last time is no longer in this export
      Given AIM314-R was exported in the plan's last calendar file
      When AIM314-R is unlocked and the plan no longer includes it
      And the plan is exported to a calendar file again
      Then the new file publishes AIM314-R's event with status cancelled
      And the cancelled event's id matches the one originally exported

    Scenario: A session still in the plan is not re-cancelled
      Given AIM314-R was exported in the plan's last calendar file
      When the plan is exported again with AIM314-R still in it
      Then the new file does not publish a cancellation for AIM314-R

  Rule: A single session can be added without duplicating the bulk export

    Scenario: The same session's quick-add and bulk export share one calendar entry
      Given BRK201 has a scheduled time and is in the resolved plan
      When BRK201 is added to the calendar from its detail view
      And the plan is also exported to a calendar file
      Then both files use the same event id for BRK201's calendar entry

    Scenario: A quick-added session gets its own reminder
      Given BRK201 has a scheduled time
      When BRK201 is added to the calendar from its detail view
      Then its calendar entry has a reminder 15 minutes before it starts
