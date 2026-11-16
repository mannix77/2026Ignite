# Issue 155. The layout rules live in a pure module so they can be checked without a browser.
Feature: My plan can show the day as a calendar grid
  The list tells Minesh the order of his day; a grid shows its shape: how long each session
  is, where the gaps are, and where several of his picks fall at the same time. The list stays
  the default. A List / Grid switch changes only how the day's timed sessions are drawn.
  In the grid one minute is one unit of height, so position and height mean real time.

  Rule: The list is the default and the switch is remembered per conference

    Scenario: First visit
      Given Minesh has never used the switch
      When he opens My plan
      Then the day is shown as the list
      And the switch shows "List" as selected

    Scenario: Switching to the grid
      Given My plan shows Tuesday as the list
      When Minesh chooses "Grid"
      Then Tuesday's timed sessions are shown as the grid, not the list
      And the day tabs, clashes, "What you'll miss", "Picks without a time yet", "Watch later", "Suggested for you" and "Online / on demand" are unchanged

    Scenario: The grid follows the day tabs
      Given My plan shows Tuesday as the grid
      When Minesh taps the Wednesday tab
      Then Wednesday is shown as the grid

    Scenario: The choice survives a reload
      Given Minesh chose "Grid" in the Ignite planner
      When he reopens the Ignite planner
      Then My plan shows the grid

    Scenario: The choice does not leak to another conference
      Given Minesh chose "Grid" in the Ignite planner
      When he opens the re:Invent planner on the same device
      Then My plan shows the list

    Scenario: A saved choice that is neither list nor grid
      Given the saved choice is "week"
      When Minesh opens My plan
      Then the day is shown as the list

  Rule: The grid shows every timed pick of the day, chosen or not

    Scenario: A pick the plan dropped is still on the grid
      Given a Must from 10:00 to 10:45 that is in the plan
      And a Maybe from 10:00 to 10:45 that the plan dropped
      When the grid is laid out
      Then both sessions are on the grid
      And the Maybe is still listed under "What you'll miss"

    Scenario: Blocked time and lunch are on the grid
      Given blocked time from 9:00 to 10:00 and lunch from 12:00 to 12:45
      When the grid is laid out
      Then each is a block at its own time

    Scenario: A pick without a time is not on the grid
      Given a Want with no time yet
      When the grid is laid out
      Then the Want is not on the grid
      And it is still listed under "Picks without a time yet"

    Scenario: A watch-later pick is not on the grid
      Given a Want from 10:00 to 10:45 that is on the watch-later list
      When the grid is laid out
      Then the Want is not on the grid

  Rule: The grid runs from the hour before the first pick to the hour after the last

    Scenario: Picks that start and end between hours
      Given the day's picks run from 9:14 AM to 4:40 PM
      When the grid is laid out
      Then the hour lines run from 9 AM to 5 PM

    Scenario: Picks that start and end on the hour
      Given the day's picks run from 9:00 AM to 5:00 PM
      When the grid is laid out
      Then the hour lines run from 9 AM to 5 PM

    Scenario: A day with no timed picks
      Given the day has no timed picks, blocked time or lunch
      When Minesh looks at the grid
      Then it shows "Nothing planned" as the list does, with no hour lines

  Rule: A session's block sits at its start time and is as tall as it is long

    Scenario: A 50-minute session on a grid that starts at 9 AM
      Given the grid starts at 9 AM
      And a Must from 10:00 to 10:50 with nothing else at that time
      When the grid is laid out
      Then its block starts 60 units down and is 50 units tall
      And the block is full width and shows its time, title and room

  Rule: Two sessions at the same time sit side by side; three or more collapse into one pill

    Scenario: Two sessions that overlap
      Given a Must from 1:30 to 2:30 and a Want from 2:00 to 3:00
      When the grid is laid out
      Then the two are side by side, each half width, each at its own start time

    Scenario: Two sessions that only touch
      Given a Must from 1:30 to 2:30 and a Want from 2:30 to 3:30
      When the grid is laid out
      Then each is a full-width block

    Scenario: Three sessions at the same time
      Given a Must, a Maybe and a Want, all from 10:00 to 10:45
      When the grid is laid out
      Then there is one pill at 10:00 that says "3 sessions at this time"
      And the pill has three dots: one Must, one Want, one Maybe
      And none of the three is drawn as a block of its own

    Scenario: Three sessions linked by overlaps
      Given sessions from 9:00 to 10:00, 9:30 to 10:30 and 10:15 to 11:00
      When the grid is laid out
      Then there is one pill from 9:00 to 11:00 that says "3 sessions at this time"

    Scenario: A pair and a later single are separate
      Given two sessions from 10:00 to 10:45 and one from 11:00 to 11:45
      When the grid is laid out
      Then the first two are side by side
      And the third is a full-width block

  Rule: Tapping a pill opens it into a list of its sessions; tapping again closes it

    Scenario: Opening a pill
      Given a collapsed pill of a Must, a Want and a Maybe at 10:00
      When Minesh taps the pill
      Then it shows three rows, Must first, then Want, then Maybe
      And each row shows the session's title and room

    Scenario: Closing a pill
      Given an open pill at 10:00
      When Minesh taps its header
      Then it is one pill that says "3 sessions at this time" again

    Scenario: Changing day closes open pills
      Given an open pill on Tuesday
      When Minesh taps the Wednesday tab and then the Tuesday tab
      Then Tuesday's pill is collapsed

  Rule: An open pill pushes everything after it down, hour lines included

    An open pill is 32 units of header plus 44 units per row.

    Background:
      Given the grid starts at 9 AM
      And a pill of three sessions from 10:00 to 10:45
      And a Must from 11:00 to 11:45

    Scenario: Collapsed, everything is at its real time
      When the pill is collapsed
      Then the pill is 45 units tall
      And the 11 AM hour line is 120 units down
      And the Must starts 120 units down

    Scenario: Open, later sessions and hour lines move by the same amount
      When the pill is open
      Then the pill is 164 units tall
      And the 11 AM hour line is 239 units down
      And the Must starts 239 units down
      And the grid is 119 units taller than when the pill was collapsed

    Scenario: Nothing before the end of the pill moves
      When the pill is open
      Then the 10 AM hour line is 60 units down
      And the pill starts 60 units down

    Scenario: A time just inside the pill does not move; its end does
      When the pill is open
      Then 10:44 is 104 units down
      And 10:45 is 224 units down

    Scenario: Closing the pill puts everything back
      Given the pill is open
      When Minesh closes it
      Then the 11 AM hour line is 120 units down
      And the Must starts 120 units down

    Scenario: Two open pills add up
      Given a second pill of three sessions from 1:00 to 1:45
      And a Want from 2:00 to 2:45
      When both pills are open
      Then the Want starts 538 units down

  Rule: A pill that is already taller than its list does not shrink the day

    Scenario: Three sessions spread over three hours
      Given the grid starts at 9 AM
      And a pill of three sessions from 9:00 to 12:00
      And a Must from 12:00 to 12:45
      When the pill is open
      Then the pill is 180 units tall
      And the Must starts 180 units down

  Rule: Tapping a session opens the same details as the list

    Scenario Outline: Tapping <where>
      Given the grid shows session BRK101 as <where>
      When Minesh taps it
      Then the session details for BRK101 open

      Examples:
        | where                    |
        | a full-width block       |
        | one of a side-by-side pair |
        | a row in an open pill    |

    Scenario: Blocked time and lunch have no details
      Given the grid shows blocked time and lunch
      When Minesh taps either
      Then no session details open
