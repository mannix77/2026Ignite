#!/usr/bin/env python3
"""Send run telemetry to Honeycomb (issue #140). Stdlib only, so sync.py and the importers
gain no new dependency.

Telemetry never breaks a sync: every network call has a timeout; a failed or slow send is
logged to stderr and skipped, never raised; and with no `HONEYCOMB_API_KEY` set, nothing is
sent at all (`configured()` returns False, callers can skip the work of building an event).

Each event type has its own allow-list (`SYNC_RUN_FIELDS`, `APP_ERROR_FIELDS`, `SPAN_FIELDS`);
`allowed()` drops anything not on the list before a payload ever reaches the network, so no
caller can accidentally widen what is sent without a reviewer seeing the list change.

    from honeycomb import send_event, configured
    send_event("sync-runs", SYNC_RUN_FIELDS, {"conference": "ignite2026", ...})
"""
import json
import os
import sys
import urllib.error
import urllib.request

API_HOST = os.environ.get("HONEYCOMB_API_HOST", "https://api.honeycomb.io")
TIMEOUT = 5  # seconds; telemetry must never hold up a sync or a deploy
KEY_ENV = "HONEYCOMB_API_KEY"

# The only fields ever sent for a sync/import run (CLAUDE.md test rule 11: no picks, notes,
# profile answers, settings or ids that identify a person).
SYNC_RUN_FIELDS = frozenset({
    "event_type", "conference", "started_at", "duration_ms", "fetch_status",
    "records_fetched", "records_accepted", "records_skipped",
    "guard_refused", "guard", "added", "removed", "changed",
    "commit_outcome", "deploy_outcome",
})

# App errors from the PWA: no picks, notes, profile answers or anything identifying a person,
# not even a free-text error message (it could echo catalog content); only a classification.
APP_ERROR_FIELDS = frozenset({
    "event_type", "app_version", "conference", "browser_family", "error_name", "at",
})

# One row per Actions workflow step, shaped as a Honeycomb trace span.
SPAN_FIELDS = frozenset({
    "trace.trace_id", "trace.span_id", "trace.parent_id", "name", "service.name",
    "duration_ms", "workflow", "run_id", "conclusion",
})


def configured():
    """Whether an ingest key is set. Callers can skip building an event entirely when False."""
    return bool(os.environ.get(KEY_ENV))


def allowed(fields, event):
    """Keep only the keys in `fields`; drop everything else, including anything unexpected."""
    return {k: v for k, v in event.items() if k in fields and v is not None}


def _post(dataset, rows, timeout):
    """POST a batch of {time, data} rows to Honeycomb. True on a 2xx, False otherwise (never
    raises): a failed or slow send must never fail the sync it is reporting on."""
    key = os.environ.get(KEY_ENV)
    if not key or not rows:
        return False
    body = json.dumps(rows, default=str).encode("utf-8")
    req = urllib.request.Request(
        "%s/1/batch/%s" % (API_HOST, dataset), data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Honeycomb-Team": key},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
        return 200 <= r.status < 300
    except Exception as e:  # network error, timeout, bad status: log and move on
        print("honeycomb: send to %s skipped (%s)" % (dataset, e), file=sys.stderr)
        return False


def send_event(dataset, fields, event, timeout=TIMEOUT):
    """Allow-list `event` against `fields` and send it as one row. No-op (returns False)
    when no key is configured, so callers never need their own `if configured():` guard."""
    if not configured():
        return False
    return _post(dataset, [{"data": allowed(fields, event)}], timeout)


def send_batch(dataset, fields, events, timeout=TIMEOUT):
    """Like send_event, for several rows (a trace's spans) in one request. A span is usually
    sent well after it happened (the workflow learns the timing only once the run is over), so
    an event may carry a reserved `_time` key (an ISO8601 string): it becomes that row's
    Honeycomb event time instead of "now", and is never itself allow-listed or sent as data."""
    if not configured():
        return False
    rows = []
    for e in events:
        e = dict(e)
        when = e.pop("_time", None)
        row = {"data": allowed(fields, e)}
        if when:
            row["time"] = when
        rows.append(row)
    return _post(dataset, rows, timeout)
