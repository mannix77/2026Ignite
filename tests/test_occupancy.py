"""Tests for scripts/occupancy.py and .github/workflows/occupancy.yml (specs/features/room-occupancy.feature).

    python3 -m unittest tests.test_occupancy -v
"""
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import occupancy  # noqa: E402

NOW = dt.datetime(2026, 11, 18, 17, 10, tzinfo=dt.timezone.utc)
GOOD = {"success": True, "enabled": True,
        "occupancy": {"Moscone West | Level 3, Room 3014": {"status": "Full", "percentage": 100},
                      " Moscone South | Level 2, Room 209 ": 42,
                      "AMC Metreon | Level 3, Theater 9": "Available"}}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class FeedTests(unittest.TestCase):
    """The envelope is checked; readings are kept as they come."""

    def test_should_keep_every_usable_room_reading_as_it_came(self):
        rooms, enabled, junk = occupancy.read_feed(GOOD)
        self.assertEqual((rooms, enabled, junk), ({
            "Moscone West | Level 3, Room 3014": {"status": "Full", "percentage": 100},
            "Moscone South | Level 2, Room 209": 42,
            "AMC Metreon | Level 3, Theater 9": "Available"}, True, 0))

    def test_should_skip_and_count_junk_rooms_next_to_good_ones(self):
        doc = {"success": True, "enabled": True, "occupancy": {
            "Moscone West | Level 3, Room 3014": 80, "": 10, "   ": 10, "Room A": None, "Room B": True, "Room C": [1, 2]}}
        rooms, enabled, junk = occupancy.read_feed(doc)
        self.assertEqual((rooms, enabled, junk), ({"Moscone West | Level 3, Room 3014": 80}, True, 5))

    def test_should_keep_the_first_reading_of_a_room_listed_twice_and_count_the_second(self):
        doc = {"success": True, "enabled": True, "occupancy": {
            "Moscone West | Level 3, Room 3014": 80, " Moscone West | Level 3, Room 3014 ": 10, "AMC Metreon | Level 3, Theater 9": "Full"}}
        self.assertEqual(occupancy.read_feed(doc), ({"Moscone West | Level 3, Room 3014": 80, "AMC Metreon | Level 3, Theater 9": "Full"}, True, 1))

    def test_should_report_a_feed_that_is_switched_off(self):
        self.assertEqual(occupancy.read_feed({"success": True, "enabled": False, "occupancy": {}}), ({}, False, 0))

    def test_should_refuse_a_feed_that_reports_failure(self):
        with self.assertRaisesRegex(RuntimeError, "did not report success"):
            occupancy.read_feed({"success": False, "occupancy": {"Room": 1}})

    def test_should_refuse_a_feed_without_a_room_table(self):
        for doc in ({"success": True, "occupancy": []}, {"success": True}, None, "junk", {"success": "true", "occupancy": {}}):
            with self.subTest(doc=doc), self.assertRaises(RuntimeError):
                occupancy.read_feed(doc)


class RunDir:
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)

    def capture(self, doc, now=NOW):
        args = types.SimpleNamespace(from_file=None, data_dir=self.dir)
        return occupancy.run(args, get=lambda url: doc, now=now)

    def written(self):
        return load(os.path.join(self.dir, "occupancy.json"))


class RunTests(RunDir, unittest.TestCase):
    def test_should_write_the_feed_with_the_time_it_was_read(self):
        self.assertEqual(self.capture(GOOD), 0)
        doc = self.written()
        self.assertEqual((doc["conference"], doc["fetchedAt"], doc["enabled"], doc["rooms"], doc["source"]),
                         ("ignite2026", "2026-11-18T17:10:00Z", True, {
                             "Moscone West | Level 3, Room 3014": {"status": "Full", "percentage": 100},
                             "Moscone South | Level 2, Room 209": 42,
                             "AMC Metreon | Level 3, Theater 9": "Available"},
                          "https://wayfinding.event.microsoft.com/home/GetOccupancyList"))

    def test_should_keep_the_last_good_file_when_the_feed_fails(self):
        self.assertEqual(self.capture(GOOD), 0)
        before = self.written()
        self.assertEqual(self.capture({"success": False}, now=NOW + dt.timedelta(minutes=10)), 3)
        self.assertEqual(self.written(), before)

    def test_should_keep_the_last_good_file_when_the_fetch_raises(self):
        self.assertEqual(self.capture(GOOD), 0)
        before = self.written()
        args = types.SimpleNamespace(from_file=None, data_dir=self.dir)

        def boom(url):
            raise RuntimeError("HTTP 503")
        self.assertEqual(occupancy.run(args, get=boom, now=NOW), 3)
        self.assertEqual(self.written(), before)

    def test_should_write_an_empty_table_when_the_feed_is_on_but_quiet(self):
        self.assertEqual(self.capture({"success": True, "enabled": True, "occupancy": {}}), 0)
        self.assertEqual((self.written()["rooms"], self.written()["enabled"]), ({}, True))

    def test_should_read_a_saved_response_from_the_command_line(self):
        path = os.path.join(self.dir, "feed.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(GOOD, f)
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "occupancy.py"), "--from-file", path, "--data-dir", self.dir],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, "occupancy: enabled=True rooms=3 junk=0"))
        self.assertEqual(len(self.written()["rooms"]), 3)


class WorkflowTests(unittest.TestCase):
    """The capture workflow runs only during the event, pushes safely, and asks for a redeploy."""

    def setUp(self):
        with open(os.path.join(ROOT, ".github", "workflows", "occupancy.yml"), encoding="utf-8") as f:
            self.text = f.read()

    def test_should_cancel_a_run_still_going_when_the_next_one_starts(self):
        self.assertEqual(re.findall(r"^concurrency:\n  group: (\S+)\n  cancel-in-progress: (true|false)\n", self.text, re.M),
                         [("occupancy", "true")])

    def test_should_abort_a_failed_rebase_inside_the_push_retry_loop(self):
        lines = self.text.splitlines()
        pulls = [i for i, l in enumerate(lines) if "git pull --rebase" in l]
        self.assertEqual(len(pulls), 1)
        self.assertIn("git rebase --abort", lines[pulls[0] + 1])

    def test_should_stage_only_the_occupancy_file(self):
        adds = re.findall(r"git add (.+)", self.text)
        self.assertEqual(adds, ["-- data/ignite2026/occupancy.json"])

    def test_should_check_out_the_branch_not_the_trigger_commit(self):
        self.assertIn("ref: ${{ github.ref_name }}", self.text)

    def test_should_ask_the_sync_workflow_to_redeploy_after_a_push(self):
        self.assertEqual(("gh workflow run sync.yml --ref main" in self.text, "steps.commit.outputs.pushed == 'true'" in self.text), (True, True))

    def test_should_only_run_during_the_event(self):
        self.assertEqual(("20261117" in self.text, "20261121" in self.text, "active=false" in self.text), (True, True, True))


if __name__ == "__main__":
    unittest.main()
