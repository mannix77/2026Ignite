Feature: Seeing whether a seat can still be had
  re:Invent seats are reserved per session. The portal export says, for each favorite,
  whether seats are still open, few, gone, or walk-up only, so that Minesh reserves the
  ones he still can and plans the full ones as walk-ups.

  Rule: What the portal says about seats is shown on the session

    Example: The one that is already full
      Given the portal reports "IND327-R" as full
      When Minesh looks at the session
      Then it is marked "Session full"
      And he is not asked to reserve a seat for it

    Example: The one with a few seats left
      Given the portal reports "SVS350" with seats to reserve and few left
      When Minesh looks at the session
      Then it is marked "Few seats left"
      And he is still asked to reserve a seat for it

    Example: The one that takes no reservations
      Given the portal reports "ARC320-R" as walk-up only
      When Minesh looks at the session
      Then it is marked "Walk-up"
      And he is not asked to reserve a seat for it

  Rule: Seat records that don't belong to the catalog are ignored

    Example: The one with a seat record for an unknown session
      Given the seat file names a session that is not in the catalog
      When the catalog is loaded
      Then every session is shown exactly as the catalog has it
