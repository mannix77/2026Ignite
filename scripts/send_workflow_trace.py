#!/usr/bin/env python3
"""Send one Honeycomb trace per Actions run: a root span for the run, a span per job, and a
span per step inside it (issue #140, "workflow timing"). Run as the last step of a job that
needs: every other job, so the Actions API already has every job's and step's timing by the
time this reads it. Never raises and never requires an ingest key (honeycomb.py no-ops
without one), so it's always safe at the end of a workflow, win or lose.

    python3 scripts/send_workflow_trace.py --repo mannix77/2026Ignite --run-id "$GITHUB_RUN_ID" \
        --workflow "Sync Ignite catalog & deploy"
"""
import argparse
import datetime as dt
import json
import subprocess
import sys

import honeycomb

DATASET = "actions-runs"
GH_TIMEOUT = 60  # seconds per GitHub CLI call


def fetch_jobs(repo, run_id, runner=None):
    """The run's jobs, each with its steps (gh api, paginated); [] on any CLI failure (a run
    this script can't read is not worth failing the workflow over)."""
    runner = runner or (lambda args: subprocess.run(args, check=True, capture_output=True, text=True,
                                                     timeout=GH_TIMEOUT).stdout)
    try:
        out = runner(["gh", "api", "-R", repo, "--paginate",
                     "repos/%s/actions/runs/%s/jobs" % (repo, run_id)])
    except Exception as e:
        print("send_workflow_trace: could not read job timing (%s)" % e, file=sys.stderr)
        return []
    jobs = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            jobs.extend(json.loads(line).get("jobs") or [])
        except ValueError:
            continue
    return jobs


def parse_time(s):
    if not s:
        return None
    try:
        return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def ms_between(a, b):
    return int(round((b - a).total_seconds() * 1000))


def build_spans(workflow, run_id, jobs):
    """Pure: jobs (as the Actions API returns them) -> a list of span dicts, root first. A job
    or step with no completed_at yet (still running, or skipped) gets no span: a span needs a
    duration. The root span covers the earliest start to the latest finish across every job."""
    spans = []
    starts, ends = [], []
    trace_id = str(run_id)
    for job in jobs:
        js, je = parse_time(job.get("started_at")), parse_time(job.get("completed_at"))
        if not js or not je:
            continue
        starts.append(js)
        ends.append(je)
        job_span_id = "job-%s" % job.get("id")
        spans.append({
            "trace.trace_id": trace_id, "trace.span_id": job_span_id, "trace.parent_id": "run",
            "name": job.get("name"), "service.name": workflow, "duration_ms": ms_between(js, je),
            "workflow": workflow, "run_id": trace_id, "conclusion": job.get("conclusion"),
            "_time": job["started_at"],
        })
        for i, step in enumerate(job.get("steps") or []):
            ss, se = parse_time(step.get("started_at")), parse_time(step.get("completed_at"))
            if not ss or not se:
                continue
            spans.append({
                "trace.trace_id": trace_id, "trace.span_id": "%s-step-%d" % (job_span_id, i),
                "trace.parent_id": job_span_id, "name": step.get("name"), "service.name": workflow,
                "duration_ms": ms_between(ss, se), "workflow": workflow, "run_id": trace_id,
                "conclusion": step.get("conclusion"), "_time": step["started_at"],
            })
    if starts and ends:
        root_start = min(starts)
        spans.insert(0, {
            "trace.trace_id": trace_id, "trace.span_id": "run", "name": workflow,
            "service.name": workflow, "duration_ms": ms_between(root_start, max(ends)),
            "workflow": workflow, "run_id": trace_id, "_time": root_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
    return spans


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--workflow", required=True)
    ap.add_argument("--dataset", default=DATASET)
    args = ap.parse_args()
    try:
        jobs = fetch_jobs(args.repo, args.run_id)
        spans = build_spans(args.workflow, args.run_id, jobs)
        sent = honeycomb.send_batch(args.dataset, honeycomb.SPAN_FIELDS, spans) if spans else False
    except Exception as e:  # this step must never fail the workflow
        print("send_workflow_trace: skipped (%s)" % e, file=sys.stderr)
        sent = False
    print("workflow trace %s (%s)" % ("sent" if sent else "not sent", args.run_id))


if __name__ == "__main__":
    main()
