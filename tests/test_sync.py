"""Tests for scripts/sync.py (and parity with the browser normalizer in assets/js/live.js).

    python3 -m unittest discover -s tests -v
"""
import copy
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import sync  # noqa: E402

JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
JS_RUNNER = [JSC, "-m"] if os.path.exists(JSC) else (["node"] if shutil.which("node") else None)
W26 = ("2026-11-17", "2026-11-20")
W25 = ("2025-11-18", "2025-11-21")


def load(name):
    with open(os.path.join(HERE, "data", name), encoding="utf-8") as f:
        return json.load(f)


def by_code(recs):
    return {r["code"]: r for r in recs}


class NormalizeTests(unittest.TestCase):
    def setUp(self):
        self.raw26 = load("raw_2026_sample.json")
        self.spk26 = load("speakers_2026_sample.json")
        self.raw25 = load("raw_2025_sample.json")

    def test_drops_test_records(self):
        recs, dropped, _ = sync.normalize(self.raw26, self.spk26, W26)
        self.assertIn("LAB685", dropped)
        self.assertEqual(sum(1 for r in recs if r["code"] == "LAB685"), 1)
        self.assertFalse(any(r["title"].lower() == "test" for r in recs))

    def test_2026_placeholders_are_not_presented_as_schedule(self):
        recs, _, _ = sync.normalize(self.raw26, self.spk26, W26)
        self.assertTrue(all(r["start"] is None for r in recs))
        self.assertTrue(all(r["roomTbd"] for r in recs if r["room"]))
        self.assertTrue(any(r["slot"] for r in recs), "raw TimeSlot kept for reference")

    def test_times_outside_event_window_are_drafts(self):
        raw = copy.deepcopy(self.raw26[:3])
        raw[0]["startDateTime"] = "2026-11-14T17:00:00Z"   # the fake day seen in the index
        raw[0]["endDateTime"] = "2026-11-14T17:45:00Z"
        raw[1]["startDateTime"] = "2026-11-18T17:00:00Z"   # Wed 9:00 PT
        raw[1]["endDateTime"] = "2026-11-18T17:45:00Z"
        recs, _, draft = sync.normalize(raw, [], W26)
        got = {r["id"]: r for r in recs}
        self.assertIsNone(got[raw[0]["sessionId"]]["start"])
        self.assertEqual(got[raw[1]["sessionId"]]["start"], "2026-11-18T17:00:00Z")
        self.assertEqual(got[raw[1]["sessionId"]]["dur"], 45)
        self.assertEqual(draft, 1)

    def test_2025_published_shape(self):
        recs, _, _ = sync.normalize(self.raw25, [], W25)
        c = by_code(recs)
        self.assertEqual(c["BRK101"]["start"], "2025-11-17T22:30:00Z")
        self.assertEqual(c["BRK101"]["room"], "Moscone West, Level 3, Room 3006")
        self.assertFalse(c["BRK101"]["roomTbd"])
        self.assertTrue(all("In-person" in r["delivery"] or r["delivery"] != ["In person"] for r in recs))
        self.assertTrue(any("In-person" in r["delivery"] for r in recs), "'In person' normalized")

    def test_repeat_groups_from_codes_and_links(self):
        recs, _, _ = sync.normalize(self.raw25, [], W25)
        c = by_code(recs)
        self.assertEqual(c["PBRK415"]["group"], "PBRK415")
        self.assertEqual(c["PBRK415-R1"]["group"], "PBRK415")
        self.assertIn("PBRK415-R1", c["PBRK415"]["repeats"])
        lab = [r for r in recs if r["code"].startswith("LAB531")]
        self.assertGreaterEqual(len(lab), 2)
        self.assertEqual({r["group"] for r in lab}, {"LAB531"})

    def test_repeat_groups_from_shared_session_id(self):
        raw = copy.deepcopy(self.raw26[:2])
        raw[1]["sessionId"] = raw[0]["sessionId"]           # 2026-style repeat: same session, new time id
        raw[1]["sessionInstanceId"] = raw[0]["sessionId"] + "-other"
        recs, _, _ = sync.normalize(raw, [], W26)
        self.assertEqual(len({r["group"] for r in recs}), 1)

    def test_speakers_from_speaker_feed(self):
        recs, _, _ = sync.normalize(self.raw26, self.spk26, W26)
        with_company = [r for r in recs if any(p[1] for p in r["speakers"])]
        self.assertTrue(with_company)

    def test_recorded_flag_both_vocabularies(self):
        recs26, _, _ = sync.normalize(self.raw26, [], W26)
        self.assertEqual({r["recorded"] for r in recs26} - {None}, {True, False})
        raw = copy.deepcopy(self.raw26[:2])
        raw[0]["viewingOptions"] = [{"displayValue": "Recorded"}]
        raw[1]["viewingOptions"] = [{"displayValue": "Not recorded"}]
        recs, _, _ = sync.normalize(raw, [], W26)
        got = {r["id"]: r["recorded"] for r in recs}
        self.assertEqual(got[raw[0]["sessionId"]], True)
        self.assertEqual(got[raw[1]["sessionId"]], False)


@unittest.skipUnless(JS_RUNNER, "no JavaScript runtime (jsc or node) available")
class ParityTests(unittest.TestCase):
    """The browser re-normalizes the CDN copy; it must agree with the sync exactly."""

    def js_normalize(self, raw_name, spk_name, window):
        out = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        try:
            subprocess.run(JS_RUNNER + [os.path.join(HERE, "normalize_cli.js"), "--",
                            os.path.join(HERE, "data", raw_name),
                            os.path.join(HERE, "data", spk_name) if spk_name else "-",
                            out, window[0], window[1]], check=True, cwd=ROOT, timeout=120)
            with open(out, encoding="utf-8") as f:
                return json.load(f)
        finally:
            os.unlink(out)

    def check(self, raw_name, spk_name, window):
        raw = load(raw_name)
        spk = load(spk_name) if spk_name else []
        py, dropped, draft = sync.normalize(raw, spk, window)
        js = self.js_normalize(raw_name, spk_name, window)
        self.assertEqual(js["dropped"], dropped)
        self.assertEqual(js["draft"], draft)
        self.assertEqual(len(js["sessions"]), len(py))
        for a, b in zip(py, js["sessions"]):
            self.assertEqual(a, b, "mismatch for %s" % a["code"])

    def test_parity_2026(self):
        self.check("raw_2026_sample.json", "speakers_2026_sample.json", W26)

    def test_parity_2025(self):
        self.check("raw_2025_sample.json", None, W25)

    def test_parity_edge_cases(self):
        self.check("raw_edge_cases.json", None, W26)

    def test_should_agree_with_the_browser_at_the_event_window_bounds(self):
        self.check("raw_window_bounds.json", None, W25)


class EdgeCaseTests(unittest.TestCase):
    def setUp(self):
        self.recs, self.dropped, self.draft = sync.normalize(load("raw_edge_cases.json"), [], W26)
        self.c = by_code(self.recs)

    def test_timestamp_shapes(self):
        self.assertEqual(self.c["BRK801"]["start"], "2026-11-18T17:00:00Z")   # naive = UTC
        self.assertEqual(self.c["BRK802"]["start"], "2026-11-18T17:00:00Z")   # -0800
        self.assertEqual(self.c["BRK803"]["start"], "2026-11-19T10:15:00Z")   # millis + offset
        self.assertIsNone(self.c["BRK804"]["start"])                         # placeholder day
        self.assertIsNone(self.c["BRK805"]["start"])
        self.assertEqual(self.draft, 1)

    def test_text_cleanup_and_shapes(self):
        self.assertEqual(self.c["BRK801"]["title"], "Naive time")
        self.assertEqual([p[0] for p in self.c["BRK801"]["speakers"]], ["Ada Lovelace", "Grace Hopper"])
        self.assertEqual(self.c["BRK802"]["room"], "Moscone South, The Hub, Theater A")   # list-shaped location
        self.assertEqual(self.c["BRK803"]["room"], "Marriott Marquis, Yerba Buena Ballroom, BO2")
        self.assertEqual(self.c["BRK805"]["speakers"], [])
        self.assertIsNone(self.c["BRK805"]["room"])

    def test_impossible_dates_are_ignored_not_fatal(self):
        for code in ("BRK810", "BRK811", "BRK812", "BRK813"):
            self.assertIsNone(self.c[code]["start"], code)

    def test_levels_both_formats(self):
        self.assertEqual(self.c["BRK801"]["level"], 200)
        self.assertEqual(self.c["BRK802"]["level"], 300)

    def test_test_time_id_dropped_and_zero_length_kept(self):
        self.assertIn("BRK807", self.dropped)
        self.assertEqual(self.c["LTG808"]["dur"], 0)
        self.assertEqual(self.c["LTG808"]["delivery"], ["In-person", "Online"])
        self.assertIs(self.c["LTG808"]["recorded"], False)

    def test_junk_shapes_are_tolerated(self):
        c = self.c
        self.assertEqual(c["BRK820"]["dur"], 45)                                   # 45.0 counts as whole minutes
        self.assertEqual(c["BRK820"]["end"], "2026-11-18T19:30:00Z")
        self.assertEqual(c["BRK821"]["end"], "2026-11-18T18:45:00Z")           # end before start -> from the slot
        self.assertEqual(c["BRK821"]["dur"], 45)                                   # True is not a duration
        self.assertIsNone(c["BRK822"]["start"])
        self.assertIsNone(c["BRK822"]["end"])                                      # an end on its own is noise
        self.assertIsNone(c["BRK822"]["dur"])
        self.assertIs(c["BRK822"]["recorded"], True)                               # single object, not a list
        self.assertEqual(c["BRK822"]["related"], [])
        self.assertEqual(c["BRK822"]["repeats"], [])
        self.assertEqual(c["BRK822"]["speakers"], [])
        self.assertEqual(c["BRK822"]["room"], "zTest1")
        self.assertTrue(c["BRK822"]["roomTbd"])
        self.assertEqual(c["BRK822"]["level"], 300)
        self.assertEqual(c["BRK823"]["id"], "23")
        self.assertEqual(c["BRK823"]["inst"], "23")
        self.assertEqual(c["BRK823"]["start"], "2026-11-19T17:00:00Z")           # NBSP-padded timestamp
        self.assertIsNone(c["BRK823"]["dur"])                                      # 20000 minutes is not a session
        self.assertEqual(c["BRK823"]["room"], "Moscone South, Level 1, Room 101")

    def test_shared_session_id_runs_are_one_group(self):
        runs = [r for r in self.recs if r["id"] == "e6"]
        self.assertEqual(len(runs), 2)
        self.assertEqual({r["group"] for r in runs}, {"BRK806"})


class EventWindowBoundsTests(unittest.TestCase):
    """Times count from midnight UTC the day before the event until midnight UTC two days
    after its last day; anything outside is a placeholder schedule (a draft)."""

    def start_of(self, code):
        recs, _, _ = sync.normalize(load("raw_window_bounds.json"), [], W25)
        return by_code(recs)[code]["start"]

    def test_should_treat_a_session_just_before_the_pre_day_as_a_draft(self):
        self.assertIsNone(self.start_of("WIN100"))

    def test_should_keep_a_session_at_the_first_instant_of_the_pre_day(self):
        self.assertEqual(self.start_of("WIN101"), "2025-11-17T00:00:00Z")

    def test_should_keep_a_session_at_4pm_pacific_on_the_last_day(self):
        self.assertEqual(self.start_of("WIN102"), "2025-11-22T00:00:00Z")

    def test_should_keep_a_session_late_on_the_spare_day(self):
        self.assertEqual(self.start_of("WIN103"), "2025-11-22T23:59:00Z")

    def test_should_treat_a_session_at_the_end_of_the_spare_day_as_a_draft(self):
        self.assertIsNone(self.start_of("WIN104"))


class DiffTests(unittest.TestCase):
    def rec(self, inst, start, room, sid="S"):
        return {"id": sid, "inst": inst, "code": "BRK1", "title": "T", "type": "Breakout", "start": start, "end": None,
                "dur": 45, "room": room, "speakers": [], "level": 200, "delivery": [], "recorded": True, "desc": ""}

    def test_new_earlier_run_is_only_an_addition(self):
        prev = [self.rec("T1", "2026-11-18T18:00:00Z", "W3006"), self.rec("T2", "2026-11-19T22:00:00Z", "S207")]
        cur = [self.rec("T0", "2026-11-17T17:00:00Z", "N121")] + prev
        added, removed, changed = sync.diff(prev, cur)
        self.assertEqual([a["inst"] for a in added], ["T0"])
        self.assertEqual((removed, changed), ([], []))

    def test_cancelled_run_is_only_a_removal(self):
        prev = [self.rec("T1", "2026-11-18T18:00:00Z", "W3006"), self.rec("T2", "2026-11-19T22:00:00Z", "S207")]
        added, removed, changed = sync.diff(prev, prev[1:])
        self.assertEqual([r["inst"] for r in removed], ["T1"])
        self.assertEqual((added, changed), ([], []))

    def test_should_pair_runs_whose_ids_were_regenerated_without_reporting_them(self):
        prev = [self.rec("T1", "2026-11-18T18:00:00Z", "W3006"), self.rec("T2", "2026-11-19T22:00:00Z", "S207")]
        cur = [self.rec("N1", "2026-11-18T18:00:00Z", "W3006"), self.rec("N2", "2026-11-19T22:00:00Z", "S207")]
        self.assertEqual(sync.diff(prev, cur), ([], [], []))

    def test_should_report_a_move_of_a_run_whose_id_was_regenerated(self):
        prev = [self.rec("T1", "2026-11-18T18:00:00Z", "W3006")]
        cur = [self.rec("N1", "2026-11-18T18:00:00Z", "S207")]
        added, removed, changed = sync.diff(prev, cur)
        self.assertEqual((added, removed, [set(c["f"]) for c in changed]), ([], [], [{"room"}]))

    def test_moved_run_is_a_change(self):
        prev = [self.rec("T1", "2026-11-18T18:00:00Z", "W3006")]
        cur = [self.rec("T1", "2026-11-18T19:00:00Z", "S207")]
        added, removed, changed = sync.diff(prev, cur)
        self.assertEqual((added, removed, [set(c["f"]) for c in changed]), ([], [], [{"start", "room"}]))


class SummaryTests(unittest.TestCase):
    """The change summary posted to the issue and the changelog."""
    LONG = "Edge-to-Action: Powering Agentic AI via Cloudera's Anywhere Cloud"

    def summary(self, old, new):
        batch = {"milestones": [], "added": [], "removed": [],
                 "changed": [{"code": "AIM101-S", "title": new, "f": {"title": [old, new]}}]}
        return sync.summary_markdown(batch, set())

    def test_should_show_where_two_long_titles_differ(self):
        self.assertIn("→ …Cloud (sponsored by Cloudera)", self.summary(self.LONG, self.LONG + " (sponsored by Cloudera)"))

    def test_should_show_a_suffix_that_makes_a_short_title_long(self):
        self.assertIn("→ …SecOps (sponsored by Splunk", self.summary(
            "Turn AWS Security Signals into Action with AI-First SecOps",
            "Turn AWS Security Signals into Action with AI-First SecOps (sponsored by Splunk, a Cisco Company)"))

    def test_should_show_a_difference_after_a_long_unbroken_word(self):
        word = "x" * 70
        self.assertIn("→ …" + "x" * 20 + "-v2", self.summary(word, word + "-v2"))

    def test_should_keep_a_short_title_change_whole(self):
        self.assertIn("title: Old name → New name", self.summary("Old name", "New name"))


@unittest.skipUnless(shutil.which("node"), "needs node")
class InstanceConferenceTests(unittest.TestCase):
    """The deploy checks instances/<name>/conference with scripts/conference_id.js before stamping it."""

    def check(self, conf):
        return subprocess.run(["node", os.path.join(ROOT, "scripts", "conference_id.js"), conf],
                              cwd=ROOT, capture_output=True, timeout=120).returncode

    def test_should_accept_a_conference_id(self):
        self.assertEqual(self.check("reinvent2026"), 0)

    def test_should_reject_a_venue_id(self):
        self.assertNotEqual(self.check("las-vegas"), 0)


class SyncDir:
    """A temporary data directory to run the sync into."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)

    def write(self, name, obj):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        return path

    def run_sync(self, raw, window=W25, settings=None):
        args = types.SimpleNamespace(
            from_file=self.write("raw.json", raw), speakers_file=None,
            settings_file=self.write("settings.json", settings) if settings else None,
            event_window="%s:%s" % window, summary_out=os.path.join(self.tmp, "summary.md"),
            data_dir=os.path.join(self.tmp, "data"))
        return sync.run(args)

    def data(self, name):
        with open(os.path.join(self.tmp, "data", name), encoding="utf-8") as f:
            return json.load(f)


class RunTests(SyncDir, unittest.TestCase):
    def test_baseline_then_publication_then_moves(self):
        published = load("raw_2025_sample.json")
        unpublished = copy.deepcopy(published)
        for s in unpublished:
            s.pop("startDateTime", None)
            s.pop("endDateTime", None)
            s["location"] = {"displayValue": "zTest1", "logicalValue": "zTest1"}

        code, changed = self.run_sync(unpublished)
        self.assertEqual((code, changed), (0, False))
        self.assertEqual(self.data("changes.json")["batches"], [])
        self.assertTrue(all(r["firstSeen"] is None for r in self.data("sessions.json")["sessions"]))

        code, changed = self.run_sync(published)
        self.assertTrue(changed)
        batch = self.data("changes.json")["batches"][0]
        self.assertTrue(any("dates/times published" in m for m in batch["milestones"]))
        self.assertTrue(any("Rooms published" in m for m in batch["milestones"]))
        with open(os.path.join(self.tmp, "summary.md"), encoding="utf-8") as f:
            self.assertIn("published", f.read())

        moved = copy.deepcopy(published)
        target = next(s for s in moved if s["sessionCode"] == "BRK101")
        target["startDateTime"] = "2025-11-19T18:00:00Z"
        target["endDateTime"] = "2025-11-19T19:00:00Z"
        target["location"] = "Moscone South, Level 3, Room 301"
        moved.append(dict(copy.deepcopy(moved[-1]), sessionId="new-1", sessionInstanceId="new-1", sessionCode="BRK999"))
        moved = [s for s in moved if s["sessionCode"] != "PBRK415-R1"]
        self.run_sync(moved)
        batch = self.data("changes.json")["batches"][0]
        ch = {x["code"]: x for x in batch["changed"]}
        self.assertEqual(set(ch["BRK101"]["f"]) >= {"start", "end", "room"}, True)
        self.assertEqual(ch["BRK101"]["f"]["room"][1], "Moscone South, Level 3, Room 301")
        self.assertEqual([x["code"] for x in batch["added"]], ["BRK999"])
        self.assertEqual([x["code"] for x in batch["removed"]], ["PBRK415-R1"])
        new = next(r for r in self.data("sessions.json")["sessions"] if r["code"] == "BRK999")
        self.assertIsNotNone(new["firstSeen"])

    def test_no_change_means_no_batch_and_no_rewrite(self):
        raw = load("raw_2026_sample.json")
        self.run_sync(raw, W26)
        before = os.path.getmtime(os.path.join(self.tmp, "data", "sessions.json"))
        for s in raw:
            s["lastUpdate"] = "2099-01-01T00:00:00Z"  # re-index noise must not count as a change
        code, changed = self.run_sync(raw, W26)
        self.assertEqual((code, changed), (0, False))
        self.assertEqual(os.path.getmtime(os.path.join(self.tmp, "data", "sessions.json")), before)

    def test_should_refuse_a_catalog_of_under_50_sessions(self):
        raw = load("raw_2025_sample.json")
        self.run_sync(raw)
        code, changed = self.run_sync(raw[:20])
        self.assertEqual(code, 3)
        self.assertFalse(changed)
        self.assertEqual(len(self.data("sessions.json")["sessions"]), len(raw))
        meta = self.data("meta.json")
        self.assertFalse(meta["ok"])
        self.assertIn("keeping last good data", meta["error"])

    def test_speaker_feed_outage_keeps_companies(self):
        raw = load("raw_2026_sample.json")
        spk_path = self.write("spk.json", load("speakers_2026_sample.json"))
        args = types.SimpleNamespace(from_file=self.write("raw.json", raw), speakers_file=spk_path, settings_file=None,
                                     event_window="%s:%s" % W26, summary_out=None, data_dir=os.path.join(self.tmp, "data"))
        sync.run(args)
        before = sum(1 for r in self.data("sessions.json")["sessions"] for p in r["speakers"] if p[1])
        args.speakers_file = None  # feed down
        sync.run(args)
        after = sum(1 for r in self.data("sessions.json")["sessions"] for p in r["speakers"] if p[1])
        self.assertGreater(before, 0)
        self.assertEqual(before, after)

    def test_unexpected_payload_is_recorded_not_silent(self):
        path = self.write("raw.json", [None, 42])
        out = os.path.join(self.tmp, "data")
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "sync.py"), "--from-file", path,
                               "--data-dir", out, "--event-window", "2026-11-17:2026-11-20"],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 3)
        meta = self.data("meta.json")
        self.assertFalse(meta["ok"])
        self.assertTrue(meta["error"])

    def test_last_changed_comes_from_committed_data(self):
        raw = load("raw_2026_sample.json")
        self.run_sync(raw, W26)
        first = self.data("sessions.json")["generatedAt"]
        os.remove(os.path.join(self.tmp, "data", "meta.json"))  # as in CI, where meta.json isn't committed
        self.run_sync(raw, W26)
        self.assertEqual(self.data("meta.json")["lastChanged"], first)

    def test_untracked_churn_does_not_move_last_changed(self):
        raw = load("raw_2026_sample.json")
        # Runs are seconds apart in CI; give each its own clock minute.
        base = sync.utcnow()
        clock = iter(base + dt.timedelta(minutes=i) for i in range(1, 10))
        self.addCleanup(setattr, sync, "utcnow", sync.utcnow)
        sync.utcnow = lambda: next(clock)
        self.run_sync(raw, W26)
        first = self.data("sessions.json")["changedAt"]
        self.assertEqual(first, self.data("sessions.json")["generatedAt"])
        noisy = copy.deepcopy(raw)
        noisy[0]["isPopular"] = not noisy[0].get("isPopular")
        _, changed = self.run_sync(noisy, W26)
        self.assertFalse(changed)
        self.assertEqual(self.data("sessions.json")["changedAt"], first)
        self.assertEqual(self.data("meta.json")["lastChanged"], first)
        moved = copy.deepcopy(noisy)
        moved[1]["title"] = moved[1]["title"] + " (renamed)"
        _, changed = self.run_sync(moved, W26)
        self.assertTrue(changed)
        self.assertNotEqual(self.data("sessions.json")["changedAt"], first)
        self.assertEqual(self.data("meta.json")["lastChanged"], self.data("sessions.json")["changedAt"])

    def test_site_flag_flip_is_a_milestone(self):
        raw = load("raw_2026_sample.json")
        off = {"sessionDetailsFlags": {"showSessionTimeSlots": False}, "showLocations": False,
               "eventStartDate": "2026-11-17T08:00:00-08:00", "eventEndDate": "2026-11-20T17:00:00-08:00"}
        on = copy.deepcopy(off)
        on["sessionDetailsFlags"]["showSessionTimeSlots"] = True
        self.run_sync(raw, W26, off)
        _, changed = self.run_sync(raw, W26, on)
        self.assertTrue(changed)
        self.assertIn("switched on session times", self.data("changes.json")["batches"][0]["milestones"][0])


def catalog_of(n):
    """n distinct published sessions in the Ignite feed format, from one sample record."""
    base = {k: v for k, v in load("raw_2025_sample.json")[0].items() if k not in ("repeatedSessions", "relatedSessionCodes")}
    return [dict(base, sessionId="s%03d" % i, sessionInstanceId="s%03d" % i, sessionCode="BRK%03d" % i)
            for i in range(n)]


class PartialCatalogTests(SyncDir, unittest.TestCase):
    """A refresh above the 50-session floor that still loses over 40% of the catalog."""

    def test_should_refuse_a_refresh_that_keeps_under_60_percent(self):
        self.run_sync(catalog_of(200))
        self.assertEqual(self.run_sync(catalog_of(119)), (3, False))

    def test_should_keep_last_good_data_when_a_partial_refresh_is_refused(self):
        self.run_sync(catalog_of(200))
        self.run_sync(catalog_of(110))
        self.assertEqual(len(self.data("sessions.json")["sessions"]), 200)

    def test_should_accept_a_refresh_that_keeps_60_percent(self):
        self.run_sync(catalog_of(200))
        self.assertEqual(self.run_sync(catalog_of(120))[0], 0)


class CiSignalTests(SyncDir, unittest.TestCase):
    """The workflow posts to the change issue only when sync.py reports changed=true."""

    def cli(self, raw):
        """Runs sync.py as the workflow does; -> what it wrote to GITHUB_OUTPUT."""
        out = os.path.join(self.tmp, "github_output")
        open(out, "w").close()
        subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "sync.py"), "--from-file", self.write("raw.json", raw),
                        "--data-dir", os.path.join(self.tmp, "data"), "--event-window", "%s:%s" % W25],
                       env=dict(os.environ, GITHUB_OUTPUT=out), check=True, capture_output=True, timeout=120)
        with open(out, encoding="utf-8") as f:
            return f.read()

    def test_should_report_a_change_to_the_workflow(self):
        raw = load("raw_2025_sample.json")
        self.cli(raw)
        raw[0]["location"] = "Moscone South, Room 156"
        self.assertEqual(self.cli(raw), "changed=true\n")

    def test_should_report_no_change_to_the_workflow(self):
        raw = load("raw_2025_sample.json")
        self.cli(raw)
        self.assertEqual(self.cli(raw), "changed=false\n")


class FirstSeenTests(SyncDir, unittest.TestCase):
    """firstSeen drives the app's "new" badge; it must survive a regenerated instance id."""

    def sync_at(self, when, raw):
        with mock.patch.object(sync, "utcnow", return_value=dt.datetime(2025, 10, when, tzinfo=dt.timezone.utc)):
            self.run_sync(raw)
        return {r["id"]: r["firstSeen"] for r in self.data("sessions.json")["sessions"]}

    def test_should_keep_first_seen_when_a_session_gets_a_new_instance_id(self):
        self.sync_at(1, catalog_of(60))
        self.sync_at(2, catalog_of(61))  # s060 appears on the 2nd
        regenerated = catalog_of(61)
        regenerated[60]["sessionInstanceId"] = "s060-regenerated"
        self.assertEqual(self.sync_at(3, regenerated)["s060"], "2025-10-02T00:00:00Z")


class EventWindowTests(unittest.TestCase):
    """The site settings' eventStartDate/eventEndDate can be blank or a placeholder."""

    def window(self, start, end):
        return sync.event_window(types.SimpleNamespace(event_window=None), {"eventStart": start, "eventEnd": end})

    def test_should_fall_back_to_the_default_window_when_event_dates_are_empty(self):
        self.assertEqual(self.window("", ""), sync.DEFAULT_WINDOW)

    def test_should_fall_back_to_the_default_window_when_event_dates_are_not_dates(self):
        self.assertEqual(self.window("TBD", "TBD"), sync.DEFAULT_WINDOW)

    def test_should_fall_back_to_the_default_window_when_only_the_end_is_unusable(self):
        self.assertEqual(self.window("2026-11-17T08:00:00-08:00", "2026-13-40"), sync.DEFAULT_WINDOW)

    def test_should_take_the_window_from_iso_event_dates(self):
        self.assertEqual(self.window("2026-11-16T08:00:00-08:00", "2026-11-19T17:00:00-08:00"),
                         ("2026-11-16", "2026-11-19"))


class MalformedRecordTests(unittest.TestCase):
    """One junk record in the feed must not block every future sync."""

    def test_should_skip_a_null_record_in_the_catalog(self):
        raw = load("raw_2026_sample.json")
        recs, _, _ = sync.normalize(raw + [None], [], W26)
        self.assertEqual(recs, sync.normalize(raw, [], W26)[0])

    def test_should_skip_non_object_records_without_reporting_them_as_dropped(self):
        _, dropped, _ = sync.normalize([None, 42, "junk", True, [], [{"sessionId": "x"}]], [], W26)
        self.assertEqual(dropped, [])


class WithdrawalGuardTests(unittest.TestCase):
    """A renamed time/room field must not be committed as 'dates withdrawn'."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.published = load("raw_2025_sample.json")
        self.run_sync(self.published)

    def run_sync(self, raw, allow_withdrawal=False):
        path = os.path.join(self.tmp, "raw.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(raw, f)
        args = types.SimpleNamespace(from_file=path, speakers_file=None, settings_file=None,
                                     event_window="%s:%s" % W25, summary_out=None,
                                     data_dir=os.path.join(self.tmp, "data"), allow_withdrawal=allow_withdrawal)
        return sync.run(args)

    def data(self, name):
        with open(os.path.join(self.tmp, "data", name), encoding="utf-8") as f:
            return json.load(f)

    def renamed(self, old, new):
        return [{(new if k == old else k): v for k, v in s.items()} for s in self.published]

    def test_should_refuse_a_feed_whose_entries_are_largely_malformed(self):
        self.run_sync([None if i % 4 == 0 else s for i, s in enumerate(self.published)])
        self.assertIn("malformed", self.data("meta.json")["error"])

    def test_should_refuse_a_feed_whose_entries_largely_lack_session_ids(self):
        self.run_sync([{k: v for k, v in s.items() if k != "sessionId"} if i % 4 == 0 else s for i, s in enumerate(self.published)])
        self.assertIn("malformed", self.data("meta.json")["error"])

    def test_should_refuse_a_catalog_whose_times_vanished(self):
        self.assertEqual(self.run_sync(self.renamed("startDateTime", "startTime")), (3, False))

    def test_should_keep_last_good_times_when_they_vanish(self):
        before = self.data("sessions.json")["stats"]["withDates"]
        self.run_sync(self.renamed("startDateTime", "startTime"))
        self.assertEqual(self.data("sessions.json")["stats"]["withDates"], before)

    def test_should_record_vanished_times_in_meta(self):
        self.run_sync(self.renamed("startDateTime", "startTime"))
        self.assertIn("keeping last good data", self.data("meta.json")["error"])

    def test_should_refuse_a_catalog_whose_rooms_vanished(self):
        self.assertEqual(self.run_sync(self.renamed("location", "venue")), (3, False))

    def test_should_accept_a_withdrawal_when_explicitly_allowed(self):
        self.run_sync(self.renamed("startDateTime", "startTime"), allow_withdrawal=True)
        self.assertIn("Session dates were withdrawn from the catalog",
                      self.data("changes.json")["batches"][0]["milestones"])

    def test_should_accept_a_withdrawal_flag_on_the_command_line(self):
        path = os.path.join(self.tmp, "renamed.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.renamed("startDateTime", "startTime"), f)
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "sync.py"), "--from-file", path,
                               "--data-dir", os.path.join(self.tmp, "data"), "--event-window", "%s:%s" % W25,
                               "--allow-withdrawal"], capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)


if __name__ == "__main__":
    unittest.main()
