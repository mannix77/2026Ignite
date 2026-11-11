"""Tests for scripts/send_sync_event.py: the one place that combines what sync.py/an importer
knew about its own run with the commit and deploy outcome the workflow learns afterwards.
Spec: specs/features/observability.feature

    python3 -m unittest tests.test_send_sync_event -v
"""
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
import honeycomb  # noqa: E402
import send_sync_event as sse  # noqa: E402


class BuildEventTests(unittest.TestCase):
    def test_merges_the_sync_jobs_telemetry_with_the_later_outcomes(self):
        telemetry = json.dumps({"conference": "ignite2026", "fetch_status": "ok", "added": 3})
        event = sse.build_event("ignite2026", telemetry, "success", "success")
        self.assertEqual(event["conference"], "ignite2026")
        self.assertEqual(event["fetch_status"], "ok")
        self.assertEqual(event["added"], 3)
        self.assertEqual(event["commit_outcome"], "success")
        self.assertEqual(event["deploy_outcome"], "success")
        self.assertEqual(event["event_type"], "sync-run")

    def test_falls_back_to_the_given_conference_when_telemetry_is_empty(self):
        # The sync job can fail before it ever reaches the step that reads meta.json's
        # telemetry field (e.g. the checkout or the test step failed): the event must still
        # name a conference so the "no sync event in N hours" alert attributes it correctly.
        event = sse.build_event("ignite2026", "", "skipped", "skipped")
        self.assertEqual(event["conference"], "ignite2026")
        self.assertEqual(event["commit_outcome"], "skipped")
        self.assertEqual(event["deploy_outcome"], "skipped")

    def test_tolerates_unparseable_telemetry_json(self):
        event = sse.build_event("reinvent2026", "{not json", "failure", "")
        self.assertEqual(event["conference"], "reinvent2026")
        self.assertEqual(event["commit_outcome"], "failure")
        self.assertNotIn("deploy_outcome", event)   # an empty outcome is left out, not sent blank

    def test_tolerates_telemetry_json_that_is_not_an_object(self):
        event = sse.build_event("ignite2026", "[1, 2, 3]", "", "")
        self.assertEqual(event["conference"], "ignite2026")

    def test_output_never_carries_a_field_outside_the_allow_list(self):
        telemetry = json.dumps({"conference": "ignite2026", "picks": {"x": 1}, "github_actor": "mannix77"})
        event = sse.build_event("ignite2026", telemetry, "success", "success")
        self.assertTrue(set(honeycomb.allowed(honeycomb.SYNC_RUN_FIELDS, event)) <= honeycomb.SYNC_RUN_FIELDS)
        sent = honeycomb.allowed(honeycomb.SYNC_RUN_FIELDS, event)
        self.assertNotIn("picks", sent)
        self.assertNotIn("github_actor", sent)


class MainTests(unittest.TestCase):
    """main() is the workflow's last step for this; it must never raise, with or without a key."""

    def run_main(self, argv, env):
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", argv):
            sse.main()

    def test_no_network_call_without_a_key(self):
        argv = ["send_sync_event.py", "--conference", "ignite2026", "--telemetry-json",
                json.dumps({"conference": "ignite2026"}), "--commit-outcome", "success", "--deploy-outcome", "success"]
        with mock.patch("urllib.request.urlopen") as m:
            self.run_main(argv, {})
        m.assert_not_called()

    def test_sends_with_a_key_and_never_raises_on_bad_input(self):
        cm = mock.MagicMock()
        cm.__enter__.return_value.read.return_value = b"{}"
        cm.__enter__.return_value.status = 200
        argv = ["send_sync_event.py", "--conference", "ignite2026", "--telemetry-json", "not json at all",
                "--commit-outcome", "failure", "--deploy-outcome", ""]
        with mock.patch("urllib.request.urlopen", return_value=cm) as m:
            self.run_main(argv, {"HONEYCOMB_API_KEY": "k"})
        sent = json.loads(m.call_args.args[0].data.decode("utf-8"))[0]["data"]
        self.assertEqual(sent["conference"], "ignite2026")
        self.assertEqual(sent["commit_outcome"], "failure")
        self.assertNotIn("deploy_outcome", sent)

    def test_a_network_failure_does_not_raise(self):
        argv = ["send_sync_event.py", "--conference", "ignite2026"]
        with mock.patch("urllib.request.urlopen", side_effect=OSError("down")):
            self.run_main(argv, {"HONEYCOMB_API_KEY": "k"})   # no exception


if __name__ == "__main__":
    unittest.main()
