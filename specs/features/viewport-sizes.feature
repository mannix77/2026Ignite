Feature: The app fits current iPhone screen sizes
  The app is phone-first, with a fixed bottom tab bar holding six destinations and dialogs
  that take over the whole screen. The two current iPhone sizes (16e at 390x844 CSS px,
  18 Pro Max at 440x956 CSS px, both under the app's 520px breakpoint) are checked with a
  real layout engine so overflow, crowded tap targets, and oversized dialogs are caught
  before a phone owner finds them (issue #145).

  Rule: No screen scrolls sideways

    Scenario Outline: A tab renders with no horizontal overflow
      Given the app is open at an iPhone 16e or iPhone 18 Pro Max viewport
      When the <tab> tab is selected
      Then the page does not scroll horizontally

      Examples:
        | tab      |
        | browse   |
        | triage   |
        | plan     |
        | now      |
        | changes  |
        | settings |

  Rule: The bottom tab bar always shows all six destinations

    Scenario: Six tabs fit side by side without overlapping
      Given the app is open at an iPhone 16e or iPhone 18 Pro Max viewport
      Then all six tabs are visible
      And no tab's bounding box overlaps another's
      And every tab stays within the screen's width

  Rule: A full-screen dialog never exceeds the screen it covers

    Scenario: A session's detail dialog fits the screen
      Given the app is open at an iPhone 16e or iPhone 18 Pro Max viewport
      When a session's details are opened from the browse tab
      Then the dialog is no wider and no taller than the screen
      And the dialog's close control is reachable within the screen's width
