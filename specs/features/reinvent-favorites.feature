Feature: Bringing re:Invent favorites and reserved seats into the plan
  The public re:Invent catalog knows nothing about an attendee's choices. An export of
  "my favorites + my schedule" from the registration portal supplies them, so that the
  plan starts from what Minesh already favorited and reserved.

  Rule: A reserved seat is a commitment pinned to that run

    Example: The one with a reserved workshop
      Given Minesh reserved a seat for "PEX403-R1"
      When the export is imported
      Then "PEX403-R1" is rated Must, locked to that run, and marked reserved

  Rule: Favorites rank by whether a seat can still be had

    Example: The one with seats still open
      Given Minesh favorited "SVS304-R", which still has seats to reserve
      When the export is imported
      Then "SVS304-R" is rated Want

    Example: The one that is already full
      Given Minesh favorited "IND327-R", which the portal shows as full
      When the export is imported
      Then "IND327-R" is rated Maybe, since only the walk-up line is left

  Rule: Seat availability travels with the favorites

    Example: The one with a few seats left
      Given the portal shows "SVS350" with 3 of 84 seats left
      When the export is imported
      Then the seat file records 3 seats left of 84 and "few seats left"

  Rule: Only sessions in the catalog are imported, and nothing personal is published

    Example: The one with an invitation-only evening
      Given "ESES26" is in the export but not in the public catalog
      When the export is imported
      Then "ESES26" is skipped and counted
      And every imported pick has an empty note
