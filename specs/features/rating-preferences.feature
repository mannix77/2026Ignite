Feature: Setting preferences across a large catalog
  An attendee facing 700-950 sessions sets broad preferences once, so that only a
  short, well-ranked list is left to rate one by one.

  Background:
    Given Minesh is an Enterprise Architect attending Microsoft Ignite 2026
    And the catalog has 944 sessions

  Rule: Quick-start answers rank the catalog

    Scenario: Sessions on the topics Minesh came for rank first
      Given Minesh came for the "Cloud & AI" topic
      When Minesh opens the shortlist
      Then sessions on "Cloud & AI" rank above sessions on "Windows"
      And each ranked session explains the match, such as "Interest: Cloud & AI"

    Scenario: Leadership goals lift sessions about influence and executive presence
      Given Minesh's goals include "executive presence"
      When Minesh opens the shortlist
      Then a session about executive presence outranks an otherwise equal session

  Rule: Skipping a whole group hides its sessions without rating them

    Scenario: Skipping a topic hides its sessions but leaves them unrated
      Given Minesh skips the "Windows" topic as a group
      When Minesh opens the shortlist
      Then no "Windows" session is listed
      And none of the 72 "Windows" sessions counts as a Skip in the plan

    Scenario: A wanted group keeps sessions that a skipped group would hide
      Given Minesh skips the "Windows" topic as a group
      And Minesh wants the "Security" topic as a group
      When Minesh opens the shortlist
      Then a Windows security session is still listed

    Scenario: Hidden sessions can be brought back
      Given Minesh skipped the "Windows" topic as a group
      When Minesh clears that group choice
      Then the "Windows" sessions are listed again

  Rule: A rating given one by one always wins over group choices

    Scenario: A session rated Must stays in the plan even in a skipped group
      Given Minesh rated "Evolution of Windows security" as Must
      When Minesh skips the "Windows" topic as a group
      Then "Evolution of Windows security" is still in Minesh's plan as Must

  Rule: Only a short list is left to rate one by one

    Scenario: The shortlist is capped and the rest is parked
      Given 600 sessions are neither rated nor hidden
      When Minesh opens the shortlist with a size of 100
      Then 100 sessions are offered to rate
      And the other sessions are parked below the cut

  Rule: Starting preferences come from the attendee's profile file

    Scenario: A fresh device starts from the shipped profile
      Given the conference ships a profile naming the role "Enterprise architect"
      And this device has no saved preferences
      When Minesh opens the app
      Then the quick start shows "Enterprise architect" as Minesh's role
