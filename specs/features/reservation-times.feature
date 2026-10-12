Feature: Reservation times are shown in your own time zone
  A seat-reservation time is stored as one instant and shown in the time zone of the device
  that is looking at it, labelled with that zone, whichever conference it belongs to.

  Rule: The time is converted for the viewer and labelled

    Scenario: Viewing from Eastern time
      Given seats open at 13:00 UTC
      When Gino views the session from a device on Eastern time
      Then the chip says reservations open at 9:00 AM EDT

    Scenario: Viewing from Pacific time
      Given seats open at 16:00 UTC
      When Gino views the session from a device on Pacific time
      Then the chip says reservations open at 9:00 AM PDT

    Scenario: Viewing from a device with no special setting
      Given seats open at 15:00 UTC
      When Gino views the session from a device on Tokyo time
      Then the chip says reservations open at midnight the next day, GMT+9

  Rule: A missing or unreadable time is not guessed

    Scenario: No reservation time known
      Given a session needs a reservation but has no opening time
      Then the chip says only that a reservation is required
