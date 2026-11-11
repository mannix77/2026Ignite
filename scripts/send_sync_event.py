#!/usr/bin/env python3
"""Send one Honeycomb event for a finished sync/import run (issue #140).

sync.py (and the re:Invent and Gartner importers) record what they know about their own run
into their `telemetry` meta.json field, but a GitHub Actions run commits and deploys in
separate jobs after the sync job finishes, so only the workflow knows the commit and deploy
outcome. This script is the one place that puts the two together and sends the single event
Honeycomb gets for the run; it never raises and never requires an ingest key (honeycomb.py
no-ops without one), so it is always safe to run as the last step of a workflow.

    python3 scripts/send_sync_event.py --conference ignite2026 \
        --telemetry-json "$TELEMETRY_JSON" --commit-outcome success --deploy-outcome success
"""
import argparse
import json
import sys

import honeycomb

DATASET = "sync-runs"


def build_event(conference, telemetry_json, commit_outcome, deploy_outcome):
    """Pure: the event honeycomb.send_event will allow-list and send. `telemetry_json` is the
    JSON the sync/import job emitted (empty or unparseable when that job failed before it got
    that far); `conference` is the fallback so the event still names a conference even then."""
    try:
        telemetry = json.loads(telemetry_json) if telemetry_json else {}
        if not isinstance(telemetry, dict):
            telemetry = {}
    except ValueError:
        telemetry = {}
    event = dict(telemetry)
    event.setdefault("conference", conference)
    event["event_type"] = "sync-run"
    if commit_outcome:
        event["commit_outcome"] = commit_outcome
    if deploy_outcome:
        event["deploy_outcome"] = deploy_outcome
    return event


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--conference", required=True, help="fallback conference id, used when --telemetry-json has none")
    ap.add_argument("--telemetry-json", default="", help="the sync/import job's `telemetry` meta.json field, as JSON")
    ap.add_argument("--commit-outcome", default="", help="the commit step's outcome (success|failure|skipped|cancelled)")
    ap.add_argument("--deploy-outcome", default="", help="the deploy job/step's outcome")
    ap.add_argument("--dataset", default=DATASET)
    args = ap.parse_args()
    event = build_event(args.conference, args.telemetry_json, args.commit_outcome, args.deploy_outcome)
    try:
        sent = honeycomb.send_event(args.dataset, honeycomb.SYNC_RUN_FIELDS, event)
    except Exception as e:  # belt and braces: this step must never fail the workflow
        print("send_sync_event: skipped (%s)" % e, file=sys.stderr)
        sent = False
    print("sync-run event %s" % ("sent" if sent else "not sent (no key configured, or the send failed)"))


if __name__ == "__main__":
    main()
