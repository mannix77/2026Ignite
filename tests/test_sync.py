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
                            out, window[0], window[1]], check=True, cwd=ROOT)
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

    def test_moved_run_is_a_change(self):
        prev = [self.rec("T1", "2026-11-18T18:00:00Z", "W3006")]
        cur = [self.rec("T1", "2026-11-18T19:00:00Z", "S207")]
        _, _, changed = sync.diff(prev, cur)
        self.assertEqual(set(changed[0]["f"]), {"start", "room"})


class RunTests(unittest.TestCase):
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

    def test_partial_catalog_keeps_last_good_data(self):
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
                              capture_output=True, text=True)
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
                               "--allow-withdrawal"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)


if __name__ == "__main__":
    unittest.main()
