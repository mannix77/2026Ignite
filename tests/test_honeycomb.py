"""Tests for scripts/honeycomb.py (issue #140): telemetry never breaks a sync, no personal
information is sent, and every network call has a timeout.
Spec: specs/features/observability.feature

    python3 -m unittest tests.test_honeycomb -v
"""
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
import honeycomb as hc  # noqa: E402


def fake_urlopen_ok(status=200):
    cm = mock.MagicMock()
    cm.__enter__.return_value.read.return_value = b"{}"
    cm.__enter__.return_value.status = status
    return cm


class ConfiguredTests(unittest.TestCase):
    def test_not_configured_without_a_key(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(hc.configured())

    def test_configured_with_a_key(self):
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True):
            self.assertTrue(hc.configured())


class NoSendWithoutAKeyTests(unittest.TestCase):
    """Rule: with no key set, nothing is sent at all (not even a request attempt)."""

    def test_send_event_makes_no_network_call_without_a_key(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch("urllib.request.urlopen") as m:
            result = hc.send_event("sync-runs", hc.SYNC_RUN_FIELDS, {"conference": "ignite2026"})
        self.assertFalse(result)
        m.assert_not_called()

    def test_send_batch_makes_no_network_call_without_a_key(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch("urllib.request.urlopen") as m:
            result = hc.send_batch("actions-runs", hc.SPAN_FIELDS, [{"name": "a"}])
        self.assertFalse(result)
        m.assert_not_called()


class AllowListTests(unittest.TestCase):
    """Rule: no personal information is sent; each event type has an explicit allow-list,
    asserted against the payload actually sent (CLAUDE.md test rule 11), not a helper's return."""

    def test_sync_run_event_sends_only_allow_listed_fields(self):
        event = {
            "event_type": "sync-run", "conference": "ignite2026", "started_at": "2026-11-17T08:00:00Z",
            "duration_ms": 1234, "fetch_status": "ok", "records_fetched": 900, "records_accepted": 880,
            "records_skipped": 20, "guard_refused": False, "guard": None, "added": 3, "removed": 1,
            "changed": 2, "commit_outcome": "success", "deploy_outcome": "success",
            # Never allowed, even if a caller passed them by mistake:
            "picks": {"BRK101": {"p": 3, "note": "meet Sam after"}}, "profile": {"groups": {"x": 1}},
            "settings": {"buffer": 10}, "id": "device-123", "github_actor": "mannix77",
        }
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=fake_urlopen_ok()) as m:
            sent = hc.send_event("sync-runs", hc.SYNC_RUN_FIELDS, event)
        self.assertTrue(sent)
        req = m.call_args.args[0]
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(len(body), 1)
        data = body[0]["data"]
        self.assertEqual(set(data.keys()), hc.SYNC_RUN_FIELDS - {"guard"})  # guard=None is dropped
        for field in ("picks", "profile", "settings", "id", "github_actor"):
            self.assertNotIn(field, data)
        self.assertEqual(data["conference"], "ignite2026")
        self.assertEqual(data["records_accepted"], 880)
        self.assertEqual(data["commit_outcome"], "success")

    def test_app_error_event_sends_only_allow_listed_fields(self):
        event = {
            "event_type": "uncaught-exception", "app_version": "ignite26-abc123", "conference": "ignite2026",
            "browser_family": "Safari", "error_name": "TypeError", "at": "2026-11-17T08:00:00Z",
            # Never allowed: free-text message, user agent string, device/user identifiers.
            "message": "Cannot read properties of undefined (reading 'p')", "user_agent": "Mozilla/5.0 ...",
            "device_id": "abc", "picks": {}, "note": "my secret note",
        }
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=fake_urlopen_ok()) as m:
            hc.send_event("app-errors", hc.APP_ERROR_FIELDS, event)
        data = json.loads(m.call_args.args[0].data.decode("utf-8"))[0]["data"]
        self.assertEqual(set(data.keys()), hc.APP_ERROR_FIELDS)
        for field in ("message", "user_agent", "device_id", "picks", "note"):
            self.assertNotIn(field, data)

    def test_allowed_drops_unlisted_keys_and_none_values(self):
        out = hc.allowed(frozenset({"a", "b"}), {"a": 1, "b": None, "c": 3})
        self.assertEqual(out, {"a": 1})


class FailureIsNeverFatalTests(unittest.TestCase):
    """Rule: telemetry never breaks a sync. A failed or slow send is logged and skipped."""

    def test_a_network_error_is_swallowed(self):
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", side_effect=OSError("network down")):
            result = hc.send_event("sync-runs", hc.SYNC_RUN_FIELDS, {"conference": "ignite2026"})
        self.assertFalse(result)  # no exception raised

    def test_a_timeout_is_swallowed(self):
        import socket
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")):
            result = hc.send_event("sync-runs", hc.SYNC_RUN_FIELDS, {"conference": "ignite2026"})
        self.assertFalse(result)

    def test_a_bad_http_status_is_swallowed(self):
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", side_effect=hc.urllib.error.HTTPError(
                    "u", 401, "unauthorized", {}, None)):
            result = hc.send_event("sync-runs", hc.SYNC_RUN_FIELDS, {"conference": "ignite2026"})
        self.assertFalse(result)


class TimeoutTests(unittest.TestCase):
    """CLAUDE.md test rule 12: every network call in a test (and in the code) has a timeout."""

    def test_every_send_passes_the_default_timeout(self):
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=fake_urlopen_ok()) as m:
            hc.send_event("sync-runs", hc.SYNC_RUN_FIELDS, {"conference": "ignite2026"})
        self.assertEqual(m.call_args.kwargs.get("timeout"), hc.TIMEOUT)

    def test_a_caller_can_pass_a_shorter_timeout(self):
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=fake_urlopen_ok()) as m:
            hc.send_event("sync-runs", hc.SYNC_RUN_FIELDS, {"conference": "ignite2026"}, timeout=2)
        self.assertEqual(m.call_args.kwargs.get("timeout"), 2)


class BatchTests(unittest.TestCase):
    def test_send_batch_sends_one_row_per_event_allow_listed(self):
        spans = [
            {"trace.trace_id": "t1", "trace.span_id": "s1", "trace.parent_id": None, "name": "sync",
             "service.name": "sync.yml", "duration_ms": 500, "workflow": "Sync Ignite catalog & deploy",
             "run_id": "42", "conclusion": "success", "secret": "nope"},
            {"trace.trace_id": "t1", "trace.span_id": "s2", "trace.parent_id": "s1", "name": "Run tests",
             "service.name": "sync.yml", "duration_ms": 100, "workflow": "Sync Ignite catalog & deploy",
             "run_id": "42", "conclusion": "success"},
        ]
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=fake_urlopen_ok()) as m:
            sent = hc.send_batch("actions-runs", hc.SPAN_FIELDS, spans)
        self.assertTrue(sent)
        body = json.loads(m.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(len(body), 2)
        self.assertNotIn("secret", body[0]["data"])
        self.assertEqual(body[1]["data"]["trace.parent_id"], "s1")
        self.assertNotIn("trace.parent_id", body[0]["data"])  # root span: None was dropped

    def test_send_batch_uses_an_explicit_time_per_row_and_never_sends_it_as_data(self):
        events = [
            {"_time": "2026-11-17T08:00:00Z", "name": "sync", "trace.trace_id": "t1", "trace.span_id": "s1"},
            {"name": "deploy", "trace.trace_id": "t1", "trace.span_id": "s2"},  # no _time: ingested as "now"
        ]
        with mock.patch.dict(os.environ, {"HONEYCOMB_API_KEY": "k"}, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=fake_urlopen_ok()) as m:
            hc.send_batch("actions-runs", hc.SPAN_FIELDS, events)
        body = json.loads(m.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(body[0]["time"], "2026-11-17T08:00:00Z")
        self.assertNotIn("_time", body[0]["data"])
        self.assertNotIn("time", body[1])


if __name__ == "__main__":
    unittest.main()
