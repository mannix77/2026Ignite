"""A sync that hangs must not stop the next one (specs/features/ignite-catalog-sync.feature).

    python3 -m unittest tests.test_sync_self_heal -v

On 2026-11-05 the Ignite deploy job sat in "waiting" on the github-pages environment for 35
hours; with cancel-in-progress off, every later scheduled run queued behind it and was cancelled
by the one after, so no catalog reached the site. Both sync workflows now cancel a run that is
still going when the next one starts (a healthy run takes about a minute; schedules are 30
minutes or more apart), and the report job skips a cancelled sync so that cancellation never
opens a production issue. Stdlib only, like tests/test_workflows.py: the YAML is read as text.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOWS = {"sync.yml": "sync", "reinvent-sync.yml": "reinvent-sync"}
CONCURRENCY = re.compile(r"^concurrency:\n  group: (\S+)\n  cancel-in-progress: (true|false)\n", re.M)
REPORT = re.compile(r"^  report:\n    needs: ([^\n]+)\n    if: ([^\n]+)\n", re.M)


def text(name):
    with open(os.path.join(ROOT, ".github", "workflows", name), encoding="utf-8") as f:
        return f.read()


class SelfHealTests(unittest.TestCase):
    def test_should_cancel_a_run_still_going_when_the_next_sync_starts(self):
        for name, group in WORKFLOWS.items():
            with self.subTest(workflow=name):
                found = CONCURRENCY.findall(text(name))
                self.assertEqual(found, [(group, "true")])

    def test_should_not_open_a_production_issue_for_the_cancelled_run(self):
        for name in WORKFLOWS:
            with self.subTest(workflow=name):
                found = REPORT.findall(text(name))
                self.assertEqual(len(found), 1, name)
                needs, cond = found[0]
                self.assertIn("sync", re.findall(r"[\w-]+", needs))
                self.assertEqual(cond, "always() && needs.sync.result != 'cancelled'")


if __name__ == "__main__":
    unittest.main()
