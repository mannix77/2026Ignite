Feature: Sync and deploy runs are visible without opening Actions logs
  Every Ignite, re:Invent and Gartner run tells Honeycomb what it did: whether the feed could
  be read, how many records it kept or skipped, what changed, and whether the catalog reached
  the site. Honeycomb also raises an alert on its own when a conference goes quiet, a guard
  turns a feed away, or a deploy never finishes. None of this ever stands between a run and the
  catalog it keeps for Gino, and nothing leaves a visitor's browser unless they choose it.

  Rule: A finished run always reports what it did

    Scenario: A clean run reports what it fetched and what changed
      Given the Ignite feed is reachable and the catalog changed
      When the scheduled run finishes
      Then Honeycomb gets one event naming the conference and how long the run took
      And that event names how many records were fetched, accepted and skipped
      And it names how many sessions were added, removed and changed

    Scenario: A guard's refusal names which guard refused the feed
      Given a feed shrinks far enough that a guard would refuse it
      When the scheduled run finishes
      Then Honeycomb's event says the feed was refused
      And the event names the guard that refused it

    Scenario: A run that never reaches the catalog step still names a conference
      Given an earlier step of the run fails before the catalog step starts
      When the workflow's reporting step runs anyway
      Then Honeycomb still gets an event naming the conference
      And that event carries the commit and deploy outcome known by then

  Rule: Nothing is sent to Honeycomb unless an ingest key is configured

    Scenario: A run with no ingest key sends no event at all
      Given no Honeycomb ingest key is configured for the run
      When the scheduled run finishes
      Then no event is sent
      And nothing about it is attempted over the network

  Rule: A reporting problem never breaks the run it is reporting on

    Scenario: Honeycomb being unreachable does not fail the run
      Given Honeycomb cannot be reached when the run tries to report
      When the scheduled run finishes
      Then the catalog and the site are unaffected
      And the failed attempt is logged rather than raised

    Scenario: A slow report is abandoned rather than held open
      Given Honeycomb accepts the connection but never answers
      When the run tries to report
      Then the attempt is abandoned once its own timeout passes

  Rule: No information that identifies a person is ever sent

    Scenario: A sync event carries only the conference's own counts
      Given a finished run's report is about to be sent
      When the event reaching Honeycomb is inspected
      Then it holds only the run's own counts and outcome
      And it carries no pick, no note, no profile answer and no setting

    Scenario: An app error carries only a classification, never a message
      Given the planner reports an error from a visitor's device
      When the event reaching Honeycomb is inspected
      Then it holds only the app version, conference, browser family and an error name
      And it holds neither the error's own wording nor anything that identifies the visitor

  Rule: Each run becomes one trace, with a span for every step

    Scenario: A finished run's jobs and steps appear as one connected trace
      Given a workflow run has reached its last job
      When its timing is sent to Honeycomb
      Then every job of that run appears as a span under one trace for the run
      And every step of each job appears as a span under its job

    Scenario: A step still in progress contributes no span
      Given a workflow run ended while one of its steps was still recorded as running
      When its timing is sent to Honeycomb
      Then that step contributes no span, since a span needs a known duration

  Rule: Sending error reports from the browser is off until a visitor turns it on

    Scenario: A freshly opened planner reports nothing on its own
      Given a visitor has never changed the error-reporting setting
      When the planner hits an error it would otherwise report
      Then nothing is sent, because the setting defaults to off

    Scenario: Turning the setting on is what allows a report to be sent
      Given a visitor has turned the error-reporting setting on
      When the planner hits an error it detects on its own
      Then a report for that error is sent

  Rule: A telemetry call is never cached and never retried for a visitor

    Scenario: A telemetry call is never served from, or saved to, offline storage
      Given the planner is sending an error report
      When its request goes out
      Then offline storage neither answers that request nor keeps a copy of it

    Scenario: A telemetry call that fails is dropped, not retried later
      Given a visitor's error report does not reach Honeycomb
      When the planner notices that
      Then the report is dropped rather than tried again on the next visit

  Rule: Honeycomb raises an alert when a conference's runs stop arriving

    Scenario: A conference's silence during its own event dates raises an alert
      Given re:Invent is in its active date range
      When two hours pass with no sync event recorded for re:Invent
      Then an alert reaches the owner by email

    Scenario: The same silence outside the conference's date range raises nothing
      Given Ignite is well outside its active date range
      When several hours pass with no sync event recorded for Ignite
      Then no silence alert fires for Ignite

  Rule: A refused feed or an unfinished deploy alerts right away, not after a delay

    Scenario: A refused feed alerts as soon as the refusal is reported
      Given a run reports that a guard refused its feed
      When that event reaches Honeycomb
      Then an alert reaches the owner by email without waiting for a quiet period

    Scenario: A deploy that never finishes alerts as soon as that is known
      Given a run reports a deploy outcome other than success
      When that event reaches Honeycomb
      Then an alert reaches the owner by email without waiting for a quiet period
