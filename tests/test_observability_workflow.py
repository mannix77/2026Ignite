"""Pins the Honeycomb wiring in the workflow YAML (issue #140): the ingest key always comes
from `secrets.HONEYCOMB_API_KEY` (never hard-coded), both workflows send a sync-run event and
a workflow trace, and the report job can actually read this run's job/step timing.
Spec: specs/features/observability.feature

    python3 -m unittest tests.test_observability_workflow -v
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKFLOWS = os.path.join(ROOT, ".github", "workflows")


def read(name):
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as f:
        return f.read()


class SyncRunEventTests(unittest.TestCase):
    def test_every_sync_workflow_sends_a_sync_run_event_with_the_right_conference(self):
        expected = {"sync.yml": "ignite2026", "reinvent-sync.yml": "reinvent2026"}
        for name, conference in expected.items():
            with self.subTest(workflow=name):
                text = read(name)
                m = re.search(r"python3 scripts/send_sync_event\.py[^\n]*\n(?:[ \t]+\S[^\n]*\n)*", text)
                self.assertIsNotNone(m, name + ": no send_sync_event.py step")
                self.assertIn("--conference %s" % conference, m.group(0))
                self.assertIn("--telemetry-json", m.group(0))
                self.assertIn("--commit-outcome", m.group(0))
                self.assertIn("--deploy-outcome", m.group(0))

    def test_the_ingest_key_always_comes_from_the_repo_secret(self):
        for name in ("sync.yml", "reinvent-sync.yml"):
            with self.subTest(workflow=name):
                text = read(name)
                self.assertIn("HONEYCOMB_API_KEY: ${{ secrets.HONEYCOMB_API_KEY }}", text)
                # Never a literal key anywhere near it (a copy-paste accident), and never from
                # a plain env var that any step could set.
                self.assertNotRegex(text, r"HONEYCOMB_API_KEY:\s*[\"']?hc[a-z]{3}_")

    def test_the_telemetry_reading_step_runs_even_after_a_failed_run(self):
        for name, data_dir in (("sync.yml", "ignite2026"), ("reinvent-sync.yml", "reinvent2026")):
            with self.subTest(workflow=name):
                text = read(name)
                m = re.search(r"- name: Read sync telemetry\nid: telemetry\nif: ([^\n]+)\n"
                              r"run: \|\n(?:[^\n]*\n)*?[^\n]*data/%s/meta\.json" % re.escape(data_dir),
                              "\n".join(l.strip() for l in text.splitlines()))
                self.assertIsNotNone(m, name + ": telemetry step not found reading data/%s/meta.json" % data_dir)
                self.assertEqual(m.group(1), "always()")


class WorkflowTraceTests(unittest.TestCase):
    def test_every_workflow_sends_its_own_trace(self):
        expected = {"sync.yml": "Sync Ignite catalog & deploy", "reinvent-sync.yml": "Sync re:Invent catalog"}
        for name, workflow_name in expected.items():
            with self.subTest(workflow=name):
                text = read(name)
                self.assertIn("send_workflow_trace.py", text)
                self.assertIn("--workflow \"${{ github.workflow }}\"", text)

    def test_the_report_job_can_read_this_runs_job_timing(self):
        for name in ("sync.yml", "reinvent-sync.yml"):
            with self.subTest(workflow=name):
                report = read(name).split("\n  report:")[1]
                self.assertIn("actions: read", report)

    def test_the_report_job_checks_out_the_honeycomb_scripts(self):
        for name in ("sync.yml", "reinvent-sync.yml"):
            with self.subTest(workflow=name):
                report = read(name).split("\n  report:")[1]
                for script in ("scripts/honeycomb.py", "scripts/send_sync_event.py", "scripts/send_workflow_trace.py"):
                    self.assertIn(script, report)


if __name__ == "__main__":
    unittest.main()
