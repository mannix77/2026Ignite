Feature: The feature files are checked for the shape this repo writes them in
  CLAUDE.md asks for a scenario before the code, kept brief. The checker that used to hold
  specs to that was never part of this repository, so nothing did. Its rules now live in
  scripts/bdd_lint.py, are taken from what the existing feature files already do, and run
  with the tests, so a spec that drifts shows up on the pull request.

  Rule: A file is one feature, described, with every scenario under a rule

    Scenario: A well-formed feature file
      Given a file with one described feature, a rule, and a three-step scenario under it
      When the file is checked
      Then nothing is reported

    Scenario: A scenario outside any rule
      Given a feature whose first scenario comes before its first rule
      When the file is checked
      Then the scenario's line is reported as needing a rule

    Scenario: A feature with no description
      Given a feature whose title is followed directly by a rule
      When the file is checked
      Then the feature's line is reported as needing a description

    Scenario: A rule with no scenario
      Given a rule that is followed directly by the next rule
      When the file is checked
      Then the empty rule's line is reported

  Rule: A scenario is brief and reads Given, When, Then

    Scenario: Six steps are allowed
      Given a scenario with six steps
      When the file is checked
      Then nothing is reported

    Scenario: A seventh step is too many
      Given a scenario with seven steps
      When the file is checked
      Then the seventh step's line is reported

    Scenario: No outcome
      Given a scenario with a Given and a When but no Then
      When the file is checked
      Then the scenario's line is reported as having no Then

    Scenario: Steps out of order or repeated
      Given a scenario with a When after its Then, and another with two Then steps
      When the file is checked
      Then the misplaced When and the second Then are each reported on their own line

    Scenario: Two scenarios with the same title
      Given a file where two scenarios share a title
      When the file is checked
      Then the second one's line is reported

    Scenario: A background sets the scene once, first
      Given a rule with a background after its first scenario, and another with two backgrounds
      When the file is checked
      Then the late background and the second background are each reported

  Rule: An outline brings its own examples, and nothing else does

    Scenario: An outline with no example rows
      Given a scenario outline whose examples table has a header and no rows
      When the file is checked
      Then the outline's line is reported

    Scenario: A placeholder with no column
      Given an outline step that uses a placeholder its examples table has no column for
      When the file is checked
      Then the step's line is reported

    Scenario: Signs that are not a placeholder
      Given an outline step that says "a count < 5 and > 2"
      When the file is checked
      Then nothing is reported

    Scenario: A second examples table
      Given an outline with two examples tables, the second with a header and no rows
      When the file is checked
      Then the outline's line is reported

    Scenario: Examples under a plain scenario
      Given a plain scenario followed by an examples table
      When the file is checked
      Then the examples line is reported

  Rule: A line that is not Gherkin is reported, not skipped

    Scenario: A misspelled step
      Given a scenario with a line starting "Whne"
      When the file is checked
      Then that line is reported as not being a step

    Scenario: A description under a feature or a rule
      Given free text directly under a feature title and directly under a rule title
      When the file is checked
      Then nothing is reported

    Scenario: A description line that starts like a step
      Given a feature description whose second line starts with "And"
      When the file is checked
      Then nothing is reported

    Scenario: Tags and doc strings
      Given a scenario with a tag above it and a doc string under a step
      When the file is checked
      Then each is reported as not used in this repo

  Rule: The layout is the one every file already uses

    Scenario: Indentation
      Given a step indented four spaces under a scenario indented four spaces
      When the file is checked
      Then the step's line is reported with the indentation it should have

    Scenario: Stray whitespace
      Given a line with a tab, a line with trailing spaces, and no newline at the end of the file
      When the file is checked
      Then each of the three is reported on its own line

  Rule: Every feature file in the repository is checked with the tests

    Scenario: The files on disk are clean
      Given every feature file under specs
      When the tests run
      Then each one is checked and none has a finding

    Scenario: The command reports and fails
      Given a feature file with a finding
      When the checker is run on it from the command line
      Then it prints the file, the line and the reason, and exits with an error

    Scenario: A file that cannot be read
      Given a path that is missing and a file that is not text
      When the checker is run on both
      Then each is reported as a finding and the run does not crash

    Scenario: Nothing to check
      Given a folder with no feature files
      When the checker is run with no file named
      Then it exits with an error, not a pass
