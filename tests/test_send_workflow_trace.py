"""Tests for scripts/send_workflow_trace.py: one trace per Actions run, each job and step as a
span (issue #140, specs/features/observability.feature).

    python3 -m unittest tests.test_send_workflow_trace -v
"""
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
import honeycomb  # noqa: E402
import send_workflow_trace as swt  # noqa: E402

JOBS_PAGE = {
    "jobs": [
        {"id": 1, "name": "sync", "conclusion": "success",
         "started_at": "2026-11-17T08:00:00Z", "completed_at": "2026-11-17T08:01:30Z",
         "steps": [
             {"name": "Run tests", "conclusion": "success",
              "started_at": "2026-11-17T08:00:05Z", "completed_at": "2026-11-17T08:00:35Z"},
             {"name": "Sync the catalog", "conclusion": "success",
              "started_at": "2026-11-17T08:00:35Z", "completed_at": "2026-11-17T08:01:20Z"},
             {"name": "Still running", "conclusion": None, "started_at": "2026-11-17T08:01:20Z",
              "completed_at": None},
         ]},
        {"id": 2, "name": "deploy", "conclusion": "success",
         "started_at": "2026-11-17T08:01:35Z", "completed_at": "2026-11-17T08:02:05Z", "steps": []},
    ],
}


class BuildSpansTests(unittest.TestCase):
    def test_builds_a_root_span_covering_every_job(self):
        spans = swt.build_spans("Sync Ignite catalog & deploy", "42", JOBS_PAGE["jobs"])
        root = spans[0]
        self.assertEqual(root["trace.span_id"], "run")
        self.assertIsNone(root.get("trace.parent_id"))
        self.assertEqual(root["duration_ms"], 125000)   # 08:00:00 -> 08:02:05
        self.assertEqual(root["_time"], "2026-11-17T08:00:00Z")

    def test_each_job_is_a_span_under_the_root(self):
        spans = swt.build_spans("wf", "42", JOBS_PAGE["jobs"])
        job_spans = {s["name"]: s for s in spans if s["trace.span_id"].startswith("job-") and "step" not in s["trace.span_id"]}
        self.assertEqual(job_spans["sync"]["trace.parent_id"], "run")
        self.assertEqual(job_spans["sync"]["duration_ms"], 90000)
        self.assertEqual(job_spans["deploy"]["duration_ms"], 30000)

    def test_each_finished_step_is_a_span_under_its_job(self):
        spans = swt.build_spans("wf", "42", JOBS_PAGE["jobs"])
        step_spans = {s["name"]: s for s in spans if s["trace.span_id"].startswith("job-1-step-")}
        self.assertEqual(set(step_spans), {"Run tests", "Sync the catalog"})   # the unfinished step is left out
        self.assertEqual(step_spans["Run tests"]["duration_ms"], 30000)
        self.assertEqual(step_spans["Run tests"]["trace.parent_id"], "job-1")
        self.assertEqual(step_spans["Sync the catalog"]["duration_ms"], 45000)

    def test_a_job_with_no_completed_at_yet_produces_no_span(self):
        running = [{"id": 9, "name": "still-going", "conclusion": None,
                    "started_at": "2026-11-17T08:00:00Z", "completed_at": None, "steps": []}]
        spans = swt.build_spans("wf", "42", running)
        self.assertEqual(spans, [])   # no finished job: not even a root span

    def test_no_jobs_produces_no_spans(self):
        self.assertEqual(swt.build_spans("wf", "42", []), [])

    def test_every_span_shares_the_same_trace_id(self):
        spans = swt.build_spans("wf", "42", JOBS_PAGE["jobs"])
        self.assertEqual({s["trace.trace_id"] for s in spans}, {"42"})

    def test_spans_never_carry_a_field_outside_the_allow_list(self):
        spans = swt.build_spans("wf", "42", JOBS_PAGE["jobs"])
        for s in spans:
            allowed_keys = set(s) - {"_time"}
            self.assertTrue(allowed_keys <= honeycomb.SPAN_FIELDS, allowed_keys - honeycomb.SPAN_FIELDS)


class FetchJobsTests(unittest.TestCase):
    def test_parses_one_paginated_line_per_page(self):
        runner = mock.Mock(return_value=json.dumps(JOBS_PAGE) + "\n")
        jobs = swt.fetch_jobs("mannix77/2026Ignite", "42", runner=runner)
        self.assertEqual([j["id"] for j in jobs], [1, 2])
        runner.assert_called_once()
        self.assertIn("--paginate", runner.call_args.args[0])

    def test_merges_several_pages(self):
        page2 = {"jobs": [{"id": 3, "name": "report", "conclusion": "success",
                           "started_at": "2026-11-17T08:02:10Z", "completed_at": "2026-11-17T08:02:20Z", "steps": []}]}
        runner = mock.Mock(return_value=json.dumps(JOBS_PAGE) + "\n" + json.dumps(page2) + "\n")
        jobs = swt.fetch_jobs("mannix77/2026Ignite", "42", runner=runner)
        self.assertEqual([j["id"] for j in jobs], [1, 2, 3])

    def test_a_cli_failure_returns_no_jobs_instead_of_raising(self):
        runner = mock.Mock(side_effect=OSError("gh not found"))
        self.assertEqual(swt.fetch_jobs("mannix77/2026Ignite", "42", runner=runner), [])


class MainTests(unittest.TestCase):
    def test_no_network_call_without_a_key(self):
        argv = ["send_workflow_trace.py", "--repo", "mannix77/2026Ignite", "--run-id", "42", "--workflow", "wf"]
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(sys, "argv", argv), \
                mock.patch.object(swt, "fetch_jobs", return_value=JOBS_PAGE["jobs"]), \
                mock.patch("urllib.request.urlopen") as m:
            swt.main()
        m.assert_not_called()

    def test_sends_a_batch_with_a_key_configured(self):
        cm = mock.MagicMock()
        cm.__enter__.return_value.read.return_value = b"{}"
        cm.__enter__.return_value.status = 200
        argv = ["send_workflow_trace.py", "--repo", "mannix77/2026Ignite", "--run-id", "42", "--workflow", "wf"]
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), mock.patch.object(sys, "argv", argv), \
                mock.patch.object(swt, "fetch_jobs", return_value=JOBS_PAGE["jobs"]), \
                mock.patch("urllib.request.urlopen", return_value=cm) as m:
            swt.main()
        body = json.loads(m.call_args.args[0].data.decode("utf-8"))
        self.assertGreater(len(body), 1)

    def test_a_github_cli_failure_never_raises(self):
        argv = ["send_workflow_trace.py", "--repo", "mannix77/2026Ignite", "--run-id", "42", "--workflow", "wf"]
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), mock.patch.object(sys, "argv", argv), \
                mock.patch.object(swt, "fetch_jobs", side_effect=RuntimeError("boom")):
            swt.main()   # no exception


if __name__ == "__main__":
    unittest.main()
