"""Tests for scripts/sync.py (and parity with the browser normalizer in assets/js/live.js).

    python3 -m unittest discover -s tests -v
"""
import contextlib
import copy
import datetime as dt
import io
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
import honeycomb  # noqa: E402
import sync  # noqa: E402
import venues  # noqa: E402

JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
JS_RUNNER = [JSC, "-m"] if os.path.exists(JSC) else (["node"] if shutil.which("node") else None)
W26 = ("2026-11-17", "2026-11-20")
W25 = ("2025-11-18", "2025-11-21")
# JavaScript's \s (ECMAScript WhiteSpace and LineTerminator): the only characters a room label's
# placeholder pattern may treat as spaces, on both sides.
JS_SPACE = {0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, *range(0x2000, 0x200b), 0x2028, 0x2029, 0x202f,
            0x205f, 0x3000, 0xfeff}


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
        self.assertEqual(js["stats"], sync.stats(py, draft))   # what the app's header counts
        self.assertEqual(len(js["sessions"]), len(py))
        for a, b in zip(py, js["sessions"]):
            self.assertEqual(a, b, "mismatch for %s" % a["code"])
        return py, js

    def test_parity_2026(self):
        self.check("raw_2026_sample.json", "speakers_2026_sample.json", W26)

    def test_parity_2025(self):
        self.check("raw_2025_sample.json", None, W25)

    def test_parity_edge_cases(self):
        self.check("raw_edge_cases.json", None, W26)

    def test_should_agree_with_the_browser_at_the_event_window_bounds(self):
        self.check("raw_window_bounds.json", None, W25)

    def test_should_agree_with_the_browser_on_placeholders_and_on_what_they_are(self):
        _, js = self.check("raw_placeholders.json", None, W26)
        got = {r["code"]: (r["room"], r["roomTbd"], r["start"], r["end"], r["dur"]) for r in js["sessions"]}
        self.assertEqual((got, js["stats"]), (PLACEHOLDERS_EXPECTED, PLACEHOLDERS_STATS))

    def test_should_read_every_character_of_a_room_label_as_the_browser_does(self):
        # Python's \s, \S, '.', '$' and re.I differ from JavaScript's (\x1c is whitespace to one and
        # not the other, ſ folds to s, '$' matches before a final newline), so the shared placeholder
        # pattern must be spelled out. Every BMP character is put at a point of each template that
        # one of those reads; both sides must call exactly the literal set below a placeholder.
        bmp = set(range(0x10000))
        letters = lambda c: {ord(c), ord(c.upper())}   # noqa: E731
        cases = {
            "zTest{}4": bmp - JS_SPACE, "zTest{}": bmp - JS_SPACE, "TBD{}": set(),
            "Rescheduling{}3": JS_SPACE, "Rescheduling 3{}B": bmp - {0x0a, 0x0d, 0x2028, 0x2029},
            "{}test": letters("z"), "z{}est": letters("t"), "zt{}st": letters("e"), "zte{}t": letters("s"),
            "ztes{}": letters("t"), "{}ba": letters("t"), "t{}d": letters("b"), "tb{}": letters("a") | letters("d"),
            "{}escheduling": letters("r"), "r{}scheduling": letters("e"), "re{}cheduling": letters("s"),
            "res{}heduling": letters("c"), "resc{}eduling": letters("h"), "resche{}uling": letters("d"),
            "resched{}ling": letters("u"), "reschedu{}ing": letters("l"), "reschedul{}ng": letters("i"),
            "rescheduli{}g": letters("n"), "reschedulin{}": letters("g"),
        }
        py = {t: {cp for cp in range(0x10000) if venues.PLACEHOLDER.match(t.replace("{}", chr(cp)))} for t in cases}
        js = {t: set(cps) for t, cps in js_run("placeholder_cli.js", sorted(cases)).items()}
        off = lambda got: {t: sorted(hex(cp) for cp in got[t] ^ cases[t]) for t in cases}   # noqa: E731
        self.assertEqual((off(py), off(js)), ({t: [] for t in cases},) * 2)   # characters read differently


def js_run(cli, *args):
    """Runs a tests/*_cli.js harness under the JS runner; -> its JSON output."""
    tmp = tempfile.mkdtemp()
    try:
        paths = []
        for i, a in enumerate(args):  # file paths pass through; data is written to a temp file
            if not isinstance(a, str):
                paths.append(os.path.join(tmp, "arg%d.json" % i))
                with open(paths[-1], "w", encoding="utf-8") as f:
                    json.dump(a, f)
            else:
                paths.append(a)
        out = os.path.join(tmp, "out.json")
        subprocess.run(JS_RUNNER + [os.path.join(HERE, cli), "--"] + paths[:2] + [out] + paths[2:],
                       check=True, cwd=ROOT, timeout=120)
        with open(out, encoding="utf-8") as f:
            return json.load(f)
    finally:
        shutil.rmtree(tmp)


@unittest.skipUnless(JS_RUNNER, "needs node or jsc")
class DiffParityTests(unittest.TestCase):
    """The browser decides "the live site has newer changes" with live.js diff(); it must
    report exactly what sync.diff() would."""

    def setUp(self):
        self.prev = sync.normalize(load("raw_2025_sample.json"), [], W25)[0]

    def agree(self, cur, expected):
        """Both diffs agree, and the agreed result is the expected one (agreement alone would
        also pass if both were wrong): expected = (added, removed, {code: changed fields})."""
        added, removed, changed = sync.diff(self.prev, cur)
        js = js_run("diff_cli.js", self.prev, cur)
        def canon(xs):
            return sorted(json.dumps(x, sort_keys=True) for x in xs)
        summary = (len(added), len(removed), {c["code"]: sorted(c["f"]) for c in changed})
        self.assertEqual(({k: canon(js[k]) for k in ("added", "removed", "changed")}, summary),
                         ({"added": canon(added), "removed": canon(removed), "changed": canon(changed)}, expected))

    def changed(self, fn):
        cur = copy.deepcopy(self.prev)
        fn(cur)
        return cur

    def test_should_agree_on_a_room_move(self):
        self.agree(self.changed(lambda c: c[0].update(room="Moscone South, Room 156")), (0, 0, {self.prev[0]["code"]: ["room"]}))

    def test_should_agree_on_a_retitle(self):
        self.agree(self.changed(lambda c: c[1].update(title="A new title")), (0, 0, {self.prev[1]["code"]: ["title"]}))

    def test_should_agree_that_reordered_speakers_are_no_change(self):
        with_two = next(i for i, r in enumerate(self.prev) if len(r["speakers"]) > 1)
        self.agree(self.changed(lambda c: c[with_two].update(speakers=list(reversed(c[with_two]["speakers"])))), (0, 0, {}))

    def test_should_agree_that_a_new_multi_run_session_is_one_session_plus_extra_runs(self):
        def add_runs(c):
            for n in range(3):
                extra = copy.deepcopy(c[0])
                extra.update(id="NEWSESSION", inst="NEWSESSION-%d" % n, code="NEW%d" % n, start="2026-11-1%dT18:00:00Z" % (7 + n))
                c.append(extra)
        self.agree(self.changed(add_runs), (3, 0, {}))
        added = sync.diff(self.prev, self.changed(add_runs))[0]
        self.assertEqual([a["repeat"] for a in added], [False, True, True])

    def test_should_agree_that_a_dropped_multi_run_session_is_one_session_plus_extra_runs(self):
        base = self.prev
        gone = []
        for n in range(3):
            r = copy.deepcopy(base[0])
            r.update(id="GONESESSION", inst="GONESESSION-%d" % n, code="GONE%d" % n, start="2026-11-1%dT18:00:00Z" % (7 + n))
            gone.append(r)
        self.prev = base + gone
        self.agree(base, (0, 3, {}))
        removed = sync.diff(self.prev, base)[1]
        self.assertEqual([r["repeat"] for r in removed], [False, True, True])

    def test_should_agree_on_a_cancellation(self):
        self.agree(self.changed(lambda c: c.pop(2)), (0, 1, {}))

    def test_should_agree_on_an_added_run(self):
        self.agree(self.changed(lambda c: c.append(dict(c[0], inst=c[0]["inst"] + "-extra", start="2025-11-21T17:00:00Z"))), (1, 0, {}))

    def test_should_agree_on_regenerated_run_ids(self):
        self.agree(self.changed(lambda c: [r.update(inst=r["inst"] + "-new") for r in c[:5]]), (0, 0, {}))

    def test_should_fill_speaker_companies_from_the_last_catalog_like_the_sync(self):
        raw, speakers = load("raw_2026_sample.json"), load("speakers_2026_sample.json")
        by_name = {p[0]: p for r in sync.normalize(raw, speakers, W26)[0] for p in r["speakers"] if p[1] or p[2]}
        py = sync.normalize(raw, [], W26, by_name)[0]
        js = js_run("normalize_cli.js", os.path.join(HERE, "data", "raw_2026_sample.json"), "-", W26[0], W26[1],
                    list(by_name.values()))["sessions"]
        filled = sum(1 for r in py for p in r["speakers"] if p[1])
        self.assertEqual((js, filled > 0), (py, True))


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

    def test_rescheduling_room_is_a_placeholder_not_a_room(self):
        # Microsoft parks a session in "Rescheduling 3" while it moves it: the label is kept (so a
        # change notice can show it) but it is no room, so it never counts as one in a known or
        # unknown building. tests/test_venues.py checks the Python and browser venue models agree.
        self.assertEqual((self.c["BRK824"]["room"], self.c["BRK824"]["roomTbd"]), ("Rescheduling 3", True))
        self.assertEqual((self.c["BRK823"]["room"], self.c["BRK823"]["roomTbd"]), ("Moscone South, Level 1, Room 101", False))

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


# What tests/data/raw_placeholders.json must normalize to under the 2026 window (16 Nov 00:00Z
# to 22 Nov 00:00Z), worked out by hand from the feature "A value that is not published yet is
# never a room or a time": code -> (room, roomTbd, start, end, dur).
ON_18TH = ("2026-11-18T17:00:00Z", "2026-11-18T17:45:00Z", 45)
REAL_ROOM = "Moscone West, Level 2, Room 2001"
PLACEHOLDERS_EXPECTED = {
    "PH01": ("zTest12", True) + ON_18TH,                  # test room as text
    "PH02": ("zTest3", True) + ON_18TH,                   # as a {displayValue} object
    "PH03": ("ZTEST9", True) + ON_18TH,                   # as a list, in capitals
    "PH04": ("TBD", True) + ON_18TH,
    "PH05": ("tba", True) + ON_18TH,                      # trimmed
    "PH06": ("Rescheduling Room", True) + ON_18TH,
    "PH07": (None, True) + ON_18TH,                       # blank
    "PH08": (None, True) + ON_18TH,                       # only spaces
    "PH09": (None, True) + ON_18TH,                       # null
    "PH10": (None, True) + ON_18TH,                       # an object with a blank displayValue
    "PH11": (REAL_ROOM, False) + ON_18TH,                 # published room and time
    "PH12": (REAL_ROOM, False, None, None, 45),           # the fake 14 Nov day: a draft time
    "PH13": (REAL_ROOM, False, None, None, 45),           # blank times
    "PH14": (REAL_ROOM, False) + ON_18TH,                 # 31 Dec end: a draft; the end comes from the length
    "PH15": (REAL_ROOM, False, "2026-11-21T23:15:00Z", "2026-11-22T00:00:00Z", 45),  # end on the window's edge: kept
    "PH16": (REAL_ROOM, False, "2026-11-21T23:15:00Z", None, None),  # end a minute past it: a draft, no length
    "PH17": (REAL_ROOM, False) + ON_18TH,                 # 14 Nov end (before the window): a draft too
    "PH18": (REAL_ROOM, False, None, None, 45),           # no start: a 31 Dec end alone is no time, not a draft
    "PH19": ("zTest\x1c4", True) + ON_18TH,              # \x1c is no space to JavaScript: a test room
}
# 19 runs; times on all but PH12/PH13/PH18; real rooms on PH11-PH18 only; draft times on PH12 (its
# start), PH14, PH16 and PH17 (their ends).
PLACEHOLDERS_STATS = {"sessions": 19, "withDates": 16, "withRooms": 8, "draftTimes": 4}


class PlaceholderRuleTests(unittest.TestCase):
    """One rule for "not published yet" (specs/features/ignite-catalog-sync.feature): a test or
    holding room, a blank value, and a time outside the event window are never a room or a time."""

    def setUp(self):
        self.recs, self.dropped, self.draft = sync.normalize(load("raw_placeholders.json"), [], W26)

    def test_should_read_every_placeholder_room_and_time_as_unpublished(self):
        got = {r["code"]: (r["room"], r["roomTbd"], r["start"], r["end"], r["dur"]) for r in self.recs}
        self.assertEqual((got, self.dropped), (PLACEHOLDERS_EXPECTED, []))   # a placeholder is unpublished, not dropped

    def test_should_not_count_a_placeholder_as_a_room_or_a_time(self):
        self.assertEqual(sync.stats(self.recs, self.draft), PLACEHOLDERS_STATS)
        self.assertEqual(sync.session_stats(self.recs), {"withDates": 16, "withRooms": 8})

    def test_should_keep_an_end_on_the_window_edge_and_count_one_a_minute_past_as_a_draft(self):
        # Both runs start at 23:15Z on 21 Nov (inside); the window closes at 22 Nov 00:00Z. 4 drafts in
        # all: PH12, PH14, PH16 and PH17.
        got = {r["code"]: (r["start"], r["end"], r["dur"]) for r in self.recs if r["code"] in ("PH15", "PH16")}
        self.assertEqual((got, self.draft), ({"PH15": ("2026-11-21T23:15:00Z", "2026-11-22T00:00:00Z", 45),
                                              "PH16": ("2026-11-21T23:15:00Z", None, None)}, 4))


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

    def test_a_new_session_with_three_runs_is_one_session_and_two_extra_runs(self):
        cur = [self.rec("A1", "2026-11-18T18:00:00Z", "W3006", "A"), self.rec("A2", "2026-11-19T18:00:00Z", "W3006", "A"),
               self.rec("A3", "2026-11-20T18:00:00Z", "W3006", "A"), self.rec("B1", "2026-11-18T19:00:00Z", "S207", "B")]
        added, removed, changed = sync.diff([], cur)
        self.assertEqual([(a["inst"], a["repeat"]) for a in added],
                         [("A1", False), ("A2", True), ("A3", True), ("B1", False)])
        self.assertEqual((removed, changed), ([], []))

    def test_a_dropped_session_with_two_runs_is_one_session_and_one_extra_run(self):
        prev = [self.rec("A1", "2026-11-18T18:00:00Z", "W3006", "A"), self.rec("A2", "2026-11-19T18:00:00Z", "W3006", "A"),
                self.rec("B1", "2026-11-18T19:00:00Z", "S207", "B")]
        added, removed, changed = sync.diff(prev, [])
        self.assertEqual([(r["inst"], r["repeat"]) for r in removed], [("A1", False), ("A2", True), ("B1", False)])
        self.assertEqual((added, changed), ([], []))

    def test_the_change_notice_headings_do_not_claim_the_session_is_still_listed(self):
        batch = {"at": "2026-10-12T00:00:00Z", "milestones": [], "changed": [],
                 "added": [{"code": "N1", "title": "New", "repeat": False}, {"code": "N1-R1", "title": "New", "repeat": True}],
                 "removed": [{"code": "G1", "title": "Gone", "repeat": False}, {"code": "G1-R1", "title": "Gone", "repeat": True}]}
        text = sync.summary_markdown(batch, set())
        self.assertIn("**Extra runs added**\n- `N1-R1` New", text)
        self.assertIn("**Extra runs dropped**\n- `G1-R1` Gone", text)
        self.assertNotIn("still in the catalog", text)
        self.assertNotIn("already listed", text)

    def test_the_console_summary_counts_sessions_and_extra_runs_apart(self):
        added = [{"code": "A", "repeat": False}, {"code": "A", "repeat": True}]
        removed = [{"code": "B", "repeat": False}, {"code": "B", "repeat": True}, {"code": "B", "repeat": True}]
        stats = {"sessions": 10, "withDates": 8, "withRooms": 7}
        self.assertEqual(sync.console_summary(stats, 0, added, removed, [{}], []),
                         "sessions=10 dates=8 rooms=7 draft=0 | added=1 removed=1 changed=1 | extra runs: added=1 dropped=2")
        self.assertEqual(sync.console_summary(stats, 2, [{"code": "A"}], [], [], ["dates published"]),
                         "sessions=10 dates=8 rooms=7 draft=2 | added=1 removed=0 changed=0 | dates published")

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

    # A run dropped from a session that is still listed (repeat=True) is not a cancellation.
    RUNS = {"milestones": [], "added": [], "changed": [], "removed": [
        {"code": "BRK201", "title": "The evolution of the Microsoft Copilot app", "repeat": True},
        {"code": "BRK999", "title": "A session that was cancelled"}]}

    def test_should_count_dropped_extra_runs_apart_from_removed_sessions(self):
        self.assertIn("Added 0 · removed 1 · changed 0 · 1 extra run dropped", sync.summary_markdown(self.RUNS, set()))

    def test_should_list_a_dropped_run_under_its_own_heading(self):
        text = sync.summary_markdown(self.RUNS, set())
        self.assertEqual((text.index("**Removed**") < text.index("BRK999") < text.index("**Extra runs dropped"),
                          text.index("**Extra runs dropped") < text.index("BRK201")), (True, True))


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

    def run_sync(self, raw, window=W25, settings=None, **more):
        args = types.SimpleNamespace(
            from_file=self.write("raw.json", raw), speakers_file=None,
            settings_file=self.write("settings.json", settings) if settings else None,
            event_window="%s:%s" % window, summary_out=os.path.join(self.tmp, "summary.md"),
            data_dir=os.path.join(self.tmp, "data"), **more)
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

    def test_should_exit_non_zero_for_a_feed_of_non_session_entries(self):
        path = self.write("raw.json", [None, 42])
        out = os.path.join(self.tmp, "data")
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "sync.py"), "--from-file", path,
                               "--data-dir", out, "--event-window", "2026-11-17:2026-11-20"],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 3)
        meta = self.data("meta.json")
        self.assertFalse(meta["ok"])
        self.assertTrue(meta["error"])

    def test_should_record_an_unexpected_error_instead_of_failing_silently(self):
        out = os.path.join(self.tmp, "data")
        argv = ["sync.py", "--from-file", self.write("raw.json", []), "--data-dir", out, "--event-window", "%s:%s" % W26]
        with mock.patch.object(sync, "run", side_effect=ValueError("unexpected shape")), mock.patch.object(sys, "argv", argv), \
                self.assertRaises(SystemExit) as exit_, contextlib.redirect_stderr(io.StringIO()):
            sync.main()
        self.assertEqual((exit_.exception.code, self.data("meta.json")["error"]), (3, "ValueError: unexpected shape"))

    def test_last_changed_comes_from_committed_data(self):
        raw = load("raw_2026_sample.json")
        def at(day):
            return mock.patch.object(sync, "utcnow", return_value=dt.datetime(2026, 10, day, tzinfo=dt.timezone.utc))
        with at(1):
            self.run_sync(raw, W26)
        os.remove(os.path.join(self.tmp, "data", "meta.json"))  # as in CI, where meta.json isn't committed
        with at(2):
            self.run_sync(raw, W26)
        self.assertEqual(self.data("meta.json")["lastChanged"], "2026-10-01T00:00:00Z")

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


def runs_of(n, runs):
    """n sessions with `runs` runs each: records sharing a sessionId, each its own instance."""
    return [dict(r, sessionInstanceId="%s-run%d" % (r["sessionId"], k)) for r in catalog_of(n) for k in range(runs)]


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

    # Oct 2026: Ignite published rooms as a second run of every session, then deleted the
    # placeholder runs; the guard must count sessions, not runs.
    def test_should_accept_dropping_extra_runs_of_the_same_sessions(self):
        self.run_sync(runs_of(200, 2))
        before = len(self.data("sessions.json")["sessions"])
        result = self.run_sync(runs_of(200, 1))
        self.assertEqual((before, result, len(self.data("sessions.json")["sessions"])), (400, (0, True), 200))

    def test_should_refuse_losing_sessions_even_when_extra_runs_keep_the_count_up(self):
        self.run_sync(runs_of(200, 2))
        result = self.run_sync(runs_of(119, 3))  # 357 runs (above 60% of 400), only 119 of 200 sessions
        self.assertEqual((result, len(self.data("sessions.json")["sessions"])), ((3, False), 400))

    def test_should_accept_keeping_60_percent_of_sessions_with_fewer_runs(self):
        ids = lambda: len({x["id"] for x in self.data("sessions.json")["sessions"]})
        baseline = self.run_sync(runs_of(200, 2))
        self.assertEqual((baseline, ids()), ((0, False), 200))  # a first import (nothing to diff), so the next run is a refresh
        refresh = self.run_sync(runs_of(120, 1))
        self.assertEqual((refresh, ids()), ((0, True), 120))


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

    def test_should_report_a_new_feed_field_alone_to_the_workflow(self):
        # No session changes (no batch), yet the summary must be queued: the workflow posts it only on changed=true.
        raw = load("raw_2025_sample.json")
        self.cli(raw)
        self.assertEqual(self.cli([dict(r, roomCapacity=12) for r in raw]), "changed=true\n")
        self.assertEqual((self.data("changes.json")["batches"], "roomCapacity" in self.data("sessions.json")["feedFields"]), ([], True))


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

    def test_should_fall_back_to_the_default_window_when_event_dates_are_reversed(self):
        self.assertEqual(self.window("2026-11-20T08:00:00-08:00", "2026-11-17T17:00:00-08:00"), sync.DEFAULT_WINDOW)

    def test_should_take_the_window_from_iso_event_dates(self):
        self.assertEqual(self.window("2026-11-16T08:00:00-08:00", "2026-11-19T17:00:00-08:00"),
                         ("2026-11-16", "2026-11-19"))


class FetchFallbackTests(unittest.TestCase):
    """Each feed is tried from the CDN copy first, then the API."""

    def test_should_use_the_api_when_the_cdn_copy_fails(self):
        def fake(url):
            if url == sync.SOURCES["sessions"][0]:
                raise RuntimeError("cdn down")
            return ["from the api"]
        with mock.patch.object(sync, "fetch_json", side_effect=fake):
            self.assertEqual(sync.fetch_first("sessions"), (["from the api"], sync.SOURCES["sessions"][1]))

    def test_should_report_both_errors_when_both_sources_fail(self):
        with mock.patch.object(sync, "fetch_json", side_effect=[RuntimeError("cdn down"), RuntimeError("api down")]):
            with self.assertRaisesRegex(RuntimeError, "cdn down; api down"):
                sync.fetch_first("sessions")


class SummaryListTests(unittest.TestCase):
    """The change summary posted to the issue: watchlist call-outs and long lists."""

    def batch(self, added=(), changed=()):
        return {"milestones": [], "removed": [],
                "added": [{"code": c, "title": "T"} for c in added],
                "changed": [{"code": c, "title": "T", "f": {"room": ["A", "B"]}} for c in changed]}

    def test_should_call_out_changes_to_watched_sessions(self):
        self.assertIn("**1 change(s) affect sessions on your watchlist:** BRK2",
                      sync.summary_markdown(self.batch(added=["BRK1"], changed=["BRK2"]), {"BRK2"}))

    def test_should_star_a_watched_session(self):
        self.assertIn("- ⭐ `BRK2` T", sync.summary_markdown(self.batch(changed=["BRK2"]), {"BRK2"}))

    def test_should_shorten_a_long_list_of_added_sessions(self):
        text = sync.summary_markdown(self.batch(added=["A%02d" % i for i in range(61)]), set())
        self.assertEqual((text.count("\n- `A"), "- …and 1 more" in text), (60, True))

    def test_should_shorten_a_long_list_of_changed_sessions(self):
        text = sync.summary_markdown(self.batch(changed=["C%02d" % i for i in range(81)]), set())
        self.assertEqual((text.count("\n- `C"), "- …and 1 more" in text), (80, True))


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

    def test_should_accept_a_feed_with_a_few_malformed_entries(self):
        self.assertEqual(self.run_sync([None] * 3 + self.published)[0], 0)  # 3 of 61 (4.9%): within the 5% limit

    def test_should_refuse_a_feed_just_over_the_malformed_limit(self):
        self.assertEqual(self.run_sync([None] * 4 + self.published), (3, False))  # 4 of 62 (6.5%)

    def test_should_refuse_a_catalog_that_lost_most_of_its_times(self):
        cut = round(0.6 * len(self.published))  # times vanish from 60% of sessions
        part = self.renamed("startDateTime", "startTime")[:cut] + self.published[cut:]
        self.assertEqual(self.run_sync(part), (3, False))

    def test_should_accept_a_catalog_that_kept_most_of_its_times(self):
        cut = round(0.4 * len(self.published))  # times vanish from 40% of sessions
        part = self.renamed("startDateTime", "startTime")[:cut] + self.published[cut:]
        self.assertEqual(self.run_sync(part, allow_withdrawal=False)[0], 0)

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


class FeedShapeTests(SyncDir, unittest.TestCase):
    """A field the app relies on arriving in a shape the sync has never seen is a format change
    (specs/features/ignite-catalog-sync.feature): the catalog is refused, never read as empty."""

    def odd_rooms(self, n, odd):
        raw = catalog_of(n)
        for r in raw[:odd]:
            r["location"] = {"id": 7}
        return raw

    def test_should_accept_the_committed_feed_samples(self):
        for name in ("raw_2026_sample.json", "raw_2025_sample.json", "raw_edge_cases.json", "raw_window_bounds.json"):
            with self.subTest(name=name):
                self.assertIsNone(sync.shape_problem(sync.field_shapes(load(name))))

    def test_should_refuse_a_field_in_a_new_shape_and_name_it_with_an_example(self):
        why = sync.shape_problem(sync.field_shapes(self.odd_rooms(20, 20)))
        self.assertEqual(why, 'feed format changed: `location` has an unrecognised shape in 20 of 20 sessions '
                              '(e.g. {"id":7}); keeping last good data')

    def test_should_tolerate_odd_shapes_in_up_to_one_session_in_twenty(self):
        self.assertIsNone(sync.shape_problem(sync.field_shapes(self.odd_rooms(20, 1))))
        self.assertIn("2 of 20", sync.shape_problem(sync.field_shapes(self.odd_rooms(20, 2))))

    def test_should_treat_blank_values_as_unpublished_not_as_a_new_shape(self):
        raw = catalog_of(20)
        for i, r in enumerate(raw):
            r["location"] = "" if i % 2 else None
            r["startDateTime"] = None
        self.assertIsNone(sync.shape_problem(sync.field_shapes(raw)))
        self.assertEqual(sync.field_shapes(raw)["location"], {"records": 20, "unknown": 0, "example": None})

    def test_should_accept_every_shape_each_field_is_read_in_and_no_other(self):
        raw = catalog_of(4)
        raw[0].update(sessionId=12, sessionInstanceId=34, title={"displayValue": "T"},
                      location=[{"displayValue": "Room 1"}], startDateTime="2025-11-18T17:00:00Z")
        raw[1].update(location=["Room 2"], title=["T2"])
        raw[2].update(location={"displayValue": "Room 3", "logicalValue": "r3"})
        self.assertIsNone(sync.shape_problem(sync.field_shapes(raw)))
        odd = catalog_of(4)
        odd[0].update(sessionId=True, sessionInstanceId=[1], title={"name": "x"}, location=[{"name": "x"}], startDateTime=1700000000)
        shapes = sync.field_shapes(odd)
        self.assertEqual({f: shapes[f]["unknown"] for f in sync.SHAPE_FIELDS},
                         {"sessionId": 1, "sessionInstanceId": 1, "title": 1, "location": 1, "startDateTime": 1})
        self.assertEqual(shapes["startDateTime"]["example"], "1700000000")

    def test_should_call_a_number_the_browser_cannot_hold_unknown(self):
        # JSON's 1e400 parses to inf here and to Infinity in the browser; an integer beyond a
        # double is finite here but Infinity there. Both sides must call them unknown.
        self.assertEqual([sync.value_shape(float("inf")), sync.value_shape(10 ** 400), sync.value_shape(12), sync.value_shape(1.5)],
                         ["unknown", "unknown", "number", "number"])
        raw = catalog_of(20)
        for r in raw[:2]:
            r["sessionInstanceId"] = 10 ** 400
        self.assertIn("`sessionInstanceId` has an unrecognised shape in 2 of 20", sync.shape_problem(sync.field_shapes(raw)))

    @unittest.skipUnless(JS_RUNNER, "needs node or jsc")
    def test_should_agree_with_the_browser_on_numbers_too_large_for_it(self):
        # Written as JSON text: Python's json module would otherwise emit Infinity, which is not JSON.
        recs = ['{"sessionId":"s%d","sessionInstanceId":%s,"title":"T","location":"R"}' % (i, "1e400" if i == 0 else "1" + "0" * 400 if i == 1 else "7" if i == 2 else "7.5")
                for i in range(20)]
        path = os.path.join(self.tmp, "big.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("[" + ",".join(recs) + "]")
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        shapes = sync.field_shapes(raw)
        # The expected result first (rule 7), then that the browser agrees with it.
        self.assertEqual(shapes["sessionInstanceId"], {"records": 20, "unknown": 2, "example": "Infinity"})
        self.assertEqual(sync.shape_problem(shapes),
                         "feed format changed: `sessionInstanceId` has an unrecognised shape in 2 of 20 sessions (e.g. Infinity); keeping last good data")
        self.assertEqual(js_run("shapes_cli.js", path), {"shapes": shapes, "problem": sync.shape_problem(shapes)})

    @unittest.skipUnless(JS_RUNNER, "needs node or jsc")
    def test_should_print_a_whole_number_example_the_way_the_browser_does(self):
        # JSON 1.0 is a float here and prints as 1.0; JSON.stringify prints 1. Same for one inside an object.
        recs = ['{"sessionId":"s%d","sessionInstanceId":"s%d","title":"T","location":%s,"startDateTime":%s}'
                % (i, i, '{"x":2.0}' if i < 2 else '"R"', "1.0" if i < 2 else '"2026-11-17T17:00:00Z"') for i in range(20)]
        path = os.path.join(self.tmp, "floats.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("[" + ",".join(recs) + "]")
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        shapes = sync.field_shapes(raw)
        self.assertEqual([shapes["startDateTime"]["example"], shapes["location"]["example"]], ["1", '{"x":2}'])
        self.assertEqual(sync.shape_problem(shapes),
                         "feed format changed: `location` has an unrecognised shape in 2 of 20 sessions (e.g. {\"x\":2}); keeping last good data")
        self.assertEqual(js_run("shapes_cli.js", path), {"shapes": shapes, "problem": sync.shape_problem(shapes)})

    def test_should_print_numbers_as_javascript_does(self):
        # Expected strings are what Number.prototype.toString / JSON.stringify print in a browser.
        cases = [(1.0, "1"), (100.0, "100"), (0.5, "0.5"), (1234.5, "1234.5"), (0.001, "0.001"), (0.000001, "0.000001"),
                 (1e-7, "1e-7"), (1e21, "1e+21"), (-1e21, "-1e+21"), (1.5e300, "1.5e+300"), (123456789012345680000.0, "123456789012345680000"),
                 (12345678901234567890, "12345678901234567000"), (10 ** 22, "1e+22"), (-0.25, "-0.25"), (0.0, "0"), (7, "7")]
        self.assertEqual([sync.js_number(v) for v, _ in cases], [want for _, want in cases])
        self.assertEqual(sync.js_json({"a": [1.0, -2.5, None, True, "é\"x"], "b": {"c": 1e21}}), '{"a":[1,-2.5,null,true,"é\\"x"],"b":{"c":1e+21}}')
        self.assertEqual(sync.js_json({"x": float("inf")}), '{"x":null}', "a number the browser cannot hold is null inside a value, as JSON.stringify prints it")

    @unittest.skipUnless(JS_RUNNER, "needs node or jsc")
    def test_should_agree_with_the_browser_on_every_number_format_in_an_example(self):
        # Each case: the JSON text of an unknown `location` value and the example the browser prints for it.
        cases = [('{"x":1e21}', '{"x":1e+21}'), ('{"x":-1e21}', '{"x":-1e+21}'), ('{"x":1e-7}', '{"x":1e-7}'), ('{"x":0.000001}', '{"x":0.000001}'),
                 ('{"x":123456789012345680000}', '{"x":123456789012345680000}'), ('{"x":12345678901234567890}', '{"x":12345678901234567000}'),
                 ('{"x":-0.25}', '{"x":-0.25}'), ('{"x":1e400}', '{"x":null}'), ('[7.0,"a",{"y":2.50}]', '[7,"a",{"y":2.5}]')]
        for text, want in cases:
            with self.subTest(text=text):
                recs = ['{"sessionId":"s%d","sessionInstanceId":"s%d","title":"T","location":%s}' % (i, i, text if i < 2 else '"R"') for i in range(20)]
                path = os.path.join(self.tmp, "num.json")
                with open(path, "w", encoding="utf-8") as f:
                    f.write("[" + ",".join(recs) + "]")
                with open(path, encoding="utf-8") as f:
                    shapes = sync.field_shapes(json.load(f))
                self.assertEqual(shapes["location"]["example"], want)
                self.assertEqual(sync.shape_problem(shapes),
                                 "feed format changed: `location` has an unrecognised shape in 2 of 20 sessions (e.g. %s); keeping last good data" % want)
                self.assertEqual(js_run("shapes_cli.js", path), {"shapes": shapes, "problem": sync.shape_problem(shapes)})

    def test_should_keep_the_last_good_catalog_and_say_why(self):
        self.run_sync(catalog_of(60))
        before = self.data("sessions.json")
        self.assertEqual(self.run_sync(self.odd_rooms(60, 60)), (3, False))
        self.assertEqual(self.data("sessions.json"), before)
        self.assertEqual(self.data("meta.json")["ok"], False)
        self.assertIn("`location`", self.data("meta.json")["error"])

    @unittest.skipUnless(JS_RUNNER, "needs node or jsc")
    def test_should_agree_with_the_browser_on_shapes_and_the_refusal(self):
        for raw in (load("raw_2026_sample.json"), self.odd_rooms(20, 2), self.odd_rooms(20, 1)):
            shapes = sync.field_shapes(raw)
            self.assertEqual(js_run("shapes_cli.js", raw), {"shapes": shapes, "problem": sync.shape_problem(shapes)})
        self.assertIn("2 of 20", sync.shape_problem(sync.field_shapes(self.odd_rooms(20, 2))))


# The top-level fields of catalog_of()'s records: a 2025 sample record without its repeat links.
CATALOG_FIELDS = ["TimeSlot", "audienceTypes", "deliveryTypes", "description", "durationInMinutes", "endDateTime",
                  "isPopular", "lastUpdate", "location", "sessionCode", "sessionId", "sessionInstanceId", "sessionLevel",
                  "sessionType", "speakerIds", "speakerNames", "startDateTime", "startDateTimeNullGroup", "tags", "title",
                  "topic", "viewingOptions"]
# CATALOG_FIELDS without TimeSlot, with roomCapacity (sorted as Python sorts: capitals first).
MOVED_FIELDS = ["audienceTypes", "deliveryTypes", "description", "durationInMinutes", "endDateTime",
                "isPopular", "lastUpdate", "location", "roomCapacity", "sessionCode", "sessionId", "sessionInstanceId",
                "sessionLevel", "sessionType", "speakerIds", "speakerNames", "startDateTime", "startDateTimeNullGroup",
                "tags", "title", "topic", "viewingOptions"]
FIELDS_HEADING = "### ⚠️ The Ignite feed's fields changed"


class FeedFieldsTests(SyncDir, unittest.TestCase):
    """The feed's top-level field list is recorded on every run, and a field that appears or vanishes
    is announced in the next change summary (ignite-catalog-sync.feature, "A field that appears in or
    vanishes from the feed is announced")."""

    def summary(self):
        """This run's summary file, or None; removed once read so the next run's is its own."""
        path = os.path.join(self.tmp, "summary.md")
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            text = f.read()
        os.remove(path)
        return text

    def feed(self, n, add=(), drop=()):
        return [dict({k: v for k, v in r.items() if k not in drop}, **{k: 12 for k in add}) for r in catalog_of(n)]

    def run_quietly(self, raw):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = self.run_sync(raw)
        return result, out.getvalue()

    def test_should_record_the_fields_and_announce_nothing_on_the_first_run(self):
        self.assertEqual(self.run_sync(catalog_of(60)), (0, False))
        self.assertEqual((self.data("meta.json")["feedFields"], self.data("sessions.json")["feedFields"], self.summary()),
                         (CATALOG_FIELDS, CATALOG_FIELDS, None))

    def test_should_announce_a_new_and_a_vanished_field_when_no_session_changed(self):
        self.run_sync(catalog_of(60))
        self.summary()
        result, printed = self.run_quietly(self.feed(60, add=["roomCapacity"], drop=["TimeSlot"]))
        self.assertEqual((result, self.summary(), self.data("changes.json")["batches"]),
                         ((0, True), FIELDS_HEADING + "\n- New: `roomCapacity`\n- Gone: `TimeSlot`\n", []))
        self.assertEqual((self.data("sessions.json")["feedFields"], self.data("meta.json")["feedFields"]), (MOVED_FIELDS, MOVED_FIELDS))
        self.assertTrue(printed.rstrip("\n").endswith(" | feed fields: 1 new, 1 gone"), printed)

    def test_should_announce_fields_alongside_session_changes(self):
        self.run_sync(catalog_of(60))
        self.summary()
        raw = self.feed(60, add=["roomCapacity"])
        raw[3]["title"] = "A new title"
        self.assertEqual(self.run_sync(raw), (0, True))
        md = self.summary()
        self.assertEqual(md.split("\n")[:3], [FIELDS_HEADING, "- New: `roomCapacity`", "Added 0 · removed 0 · changed 1"])
        self.assertIn("- `BRK003` A new title — title:", md)
        self.assertEqual([x["code"] for x in self.data("changes.json")["batches"][0]["changed"]], ["BRK003"])

    def test_should_announce_a_field_change_once(self):
        self.run_sync(catalog_of(60))
        self.assertEqual(self.run_sync(self.feed(60, add=["roomCapacity"])), (0, True))
        self.assertIsNotNone(self.summary())
        self.assertEqual((self.run_sync(self.feed(60, add=["roomCapacity"])), self.summary(), self.data("sessions.json")["feedFields"]),
                         ((0, False), None, sorted(CATALOG_FIELDS + ["roomCapacity"])))

    def test_should_hold_a_refused_feeds_new_field_for_the_next_good_run(self):
        self.run_sync(catalog_of(200))
        self.assertEqual(self.run_sync(self.feed(90, add=["roomCapacity"])), (3, False))   # partial: refused
        self.assertEqual((self.summary(), self.data("sessions.json")["feedFields"], self.data("meta.json")["feedFields"]),
                         (None, CATALOG_FIELDS, sorted(CATALOG_FIELDS + ["roomCapacity"])))
        self.assertEqual((self.run_sync(self.feed(200, add=["roomCapacity"])), self.summary()),
                         ((0, True), FIELDS_HEADING + "\n- New: `roomCapacity`\n"))

    def test_should_only_record_the_fields_when_the_catalog_has_no_usable_list(self):
        # A catalog written before fields were recorded, or a hand-edited list, is no baseline:
        # announcing every field as new would be noise. The run records the list instead.
        for recorded in ("missing", None, "junk", [], [1, 2], {"title": 1}):
            with self.subTest(recorded=recorded):
                try:
                    self.run_sync(catalog_of(60))
                    path = os.path.join(self.tmp, "data", "sessions.json")
                    doc = self.data("sessions.json")
                    if recorded == "missing":
                        doc.pop("feedFields")
                    else:
                        doc["feedFields"] = recorded
                    with open(path, "w", encoding="utf-8") as f:
                        json.dump(doc, f)
                    self.assertEqual((self.run_sync(self.feed(60, add=["roomCapacity"])), self.summary(), self.data("sessions.json")["feedFields"]),
                                     ((0, False), None, sorted(CATALOG_FIELDS + ["roomCapacity"])))
                finally:   # each case starts from an empty data folder, even after a failure
                    shutil.rmtree(os.path.join(self.tmp, "data"), ignore_errors=True)
                    self.summary()

    def test_should_take_fields_only_from_session_records(self):
        # Two junk entries in 62 pass the malformed-entry guard (5%); their keys are not feed fields.
        self.run_sync(catalog_of(60))
        raw = catalog_of(60) + [{"debug": 1}, {"sessionId": "", "x_internal": 2}]
        self.assertEqual((self.run_sync(raw), self.summary(), self.data("meta.json")["feedFields"], self.data("sessions.json")["feedFields"]),
                         ((0, False), None, CATALOG_FIELDS, CATALOG_FIELDS))

    def test_should_show_field_names_as_code_spans_and_shorten_a_long_list(self):
        self.assertEqual(sync.fields_markdown({"new": ["a`b\nc"], "gone": []}), [FIELDS_HEADING, "- New: `a'b c`"])
        sixty = ["f%02d" % i for i in range(60)]
        self.assertEqual(sync.fields_markdown({"new": [], "gone": sixty})[1], "- Gone: " + ", ".join("`%s`" % f for f in sixty))
        self.assertEqual(sync.fields_markdown({"new": sixty + ["g"], "gone": []})[1],
                         "- New: " + ", ".join("`%s`" % f for f in sixty) + " …and 1 more")
        # A name of up to 60 characters is shown whole; a longer one is cut to 59 and an ellipsis.
        self.assertEqual(sync.fields_markdown({"new": ["a" * 60, "b" * 61, "c" * 70000], "gone": []})[1],
                         "- New: `%s`, `%s…`, `%s…`" % ("a" * 60, "b" * 59, "c" * 59))


def placeholder_runs(n, start=0):
    """n placeholder sessions: a zTest room and no time, as Ignite published before rooms were out."""
    recs = catalog_of(n + start)[start:]
    for r in recs:
        r["location"] = "zTest%d" % start
        r["startDateTime"] = r["endDateTime"] = None
    return recs


class RefusalTests(SyncDir, unittest.TestCase):
    """A refused catalog is diagnosed, not just refused (specs/features/ignite-catalog-sync.feature,
    "A refusal explains itself"): the guard, the counts, examples, and whether only placeholders went."""

    def refusal_md(self):
        with open(os.path.join(self.tmp, "refusal.md"), encoding="utf-8") as f:
            return f.read()

    def test_should_diagnose_a_partial_catalog_with_counts_and_examples(self):
        self.run_sync(catalog_of(200))
        code, changed = self.run_sync(catalog_of(90), refusal_out=os.path.join(self.tmp, "refusal.md"))
        self.assertEqual((code, changed), (3, False))
        r = self.data("meta.json")["refusal"]
        self.assertEqual((r["guard"], r["before"], r["after"], r["missing"], r["emptied"], r["allPlaceholders"], len(r["examples"])),
                         ("partial", {"sessions": 200, "runs": 200}, {"sessions": 90, "runs": 90}, 110, 0, False, 10))
        self.assertEqual(r["examples"][0], {"code": "BRK090", "title": catalog_of(91)[90]["title"], "room": sync.text(sync.one(catalog_of(91)[90]["location"]))})
        self.assertEqual(r["message"], self.data("meta.json")["error"])
        md = self.refusal_md()
        self.assertIn("### Catalog refused: partial catalog", md)
        self.assertIn("Sessions: 200 → 90 (runs 200 → 90)", md)
        self.assertIn("Missing sessions: 110", md)
        self.assertIn("`BRK090`", md)
        self.assertIn("…and 100 more", md)
        self.assertIn("Was every missing session a placeholder: no", md)
        self.assertIn("`accept: partial`", md)

    def test_should_say_when_only_placeholders_went_missing(self):
        self.run_sync(catalog_of(100) + placeholder_runs(100, 100))
        self.assertEqual(self.run_sync(catalog_of(100))[0], 3)   # 100 of 200 sessions: refused
        r = self.data("meta.json")["refusal"]
        self.assertEqual((r["missing"], r["allPlaceholders"], r["examples"][0]["room"]), (100, True, "zTest100"))
        self.assertIn("Was every missing session a placeholder: yes", sync.refusal_markdown(r))

    def test_should_diagnose_withdrawn_rooms_with_the_sessions_that_lost_them(self):
        self.run_sync(catalog_of(100))
        bare = catalog_of(100)
        for r in bare:
            r["location"] = ""
        self.assertEqual(self.run_sync(bare)[0], 3)
        r = self.data("meta.json")["refusal"]
        self.assertEqual((r["guard"], r["missing"], r["emptied"], len(r["examples"]), r["examples"][0]["code"], r["allPlaceholders"]),
                         ("withdrawal", 0, 100, 10, "BRK000", None))
        self.assertIn("### Catalog refused: dates or rooms withdrawn", sync.refusal_markdown(r))
        self.assertIn("lost a room or time: 100", sync.refusal_markdown(r))
        self.assertIn("`accept: withdrawal`", sync.refusal_markdown(r))

    def test_should_diagnose_a_feed_whose_shape_changed(self):
        self.run_sync(catalog_of(60))
        odd = catalog_of(60)
        for r in odd:
            r["location"] = {"id": 7}
        self.assertEqual(self.run_sync(odd)[0], 3)
        r = self.data("meta.json")["refusal"]
        self.assertEqual((r["guard"], r["before"]["sessions"], r["after"]), ("shape", 60, None))
        self.assertIn("### Catalog refused: feed format changed", sync.refusal_markdown(r))
        self.assertNotIn("accept:", sync.refusal_markdown(r), "a format change needs code, not acceptance")

    def test_should_clear_the_refusal_when_the_next_run_succeeds(self):
        self.run_sync(catalog_of(200))
        self.run_sync(catalog_of(90))
        self.assertIn("refusal", self.data("meta.json"))
        self.run_sync(catalog_of(200))
        self.assertEqual((self.data("meta.json")["ok"], "refusal" in self.data("meta.json")), (True, False))


class AcceptTests(SyncDir, unittest.TestCase):
    """The owner accepts a refused catalog for one run (specs/features/ignite-catalog-sync.feature,
    "A refused catalog can be accepted from a phone")."""

    def test_should_accept_a_partial_catalog_and_record_who_did(self):
        self.run_sync(catalog_of(200))
        self.assertEqual(self.run_sync(catalog_of(90))[0], 3)
        code, changed = self.run_sync(catalog_of(90), accept=["partial"], accepted_by="minesh")
        self.assertEqual((code, changed), (0, True))
        self.assertEqual(len(self.data("sessions.json")["sessions"]), 90)
        batch = self.data("changes.json")["batches"][0]
        self.assertEqual((batch["accepted"]["guard"], batch["accepted"]["by"], batch["accepted"]["at"]),
                         ("partial", "minesh", batch["at"]))
        self.assertIn("catalog returned 90 sessions (previously 200)", batch["accepted"]["reason"])
        self.assertEqual(self.data("meta.json")["accepted"], batch["accepted"])
        with open(os.path.join(self.tmp, "summary.md"), encoding="utf-8") as f:
            self.assertIn("Catalog accepted by hand (minesh): catalog returned 90 sessions (previously 200)", f.read())

    def test_should_accept_for_one_run_only(self):
        self.run_sync(catalog_of(200))
        self.run_sync(catalog_of(90), accept=["partial"], accepted_by="minesh")
        self.assertEqual(self.run_sync(catalog_of(40)), (3, False))   # below the 50 floor too
        self.assertEqual(self.run_sync(catalog_of(52)), (3, False))   # 52 of 90: refused again without acceptance
        self.assertEqual(len(self.data("sessions.json")["sessions"]), 90)

    def test_should_keep_the_fifty_session_floor_even_when_accepting(self):
        self.run_sync(catalog_of(200))
        self.assertEqual(self.run_sync(catalog_of(40), accept=["partial"], accepted_by="minesh"), (3, False))
        self.assertEqual(len(self.data("sessions.json")["sessions"]), 200)

    def test_should_accept_withdrawn_rooms_the_same_way(self):
        self.run_sync(catalog_of(100))
        bare = catalog_of(100)
        for r in bare:
            r["location"] = ""
        self.assertEqual(self.run_sync(bare)[0], 3)
        self.assertEqual(self.run_sync(bare, accept=["withdrawal"], accepted_by="minesh")[0], 0)
        self.assertEqual(self.data("changes.json")["batches"][0]["accepted"]["guard"], "withdrawal")

    def test_should_not_let_one_acceptance_cover_the_other_guard(self):
        self.run_sync(catalog_of(200))
        self.assertEqual(self.run_sync(catalog_of(90), accept=["withdrawal"], accepted_by="minesh"), (3, False))
        self.assertEqual(self.data("meta.json")["refusal"]["guard"], "partial")

    def test_should_record_nothing_when_no_guard_tripped(self):
        self.run_sync(catalog_of(200))
        self.run_sync(catalog_of(201), accept=["partial"], accepted_by="minesh")   # nothing refused: one session added
        self.assertNotIn("accepted", self.data("changes.json")["batches"][0])
        self.assertNotIn("accepted", self.data("meta.json"))


class TelemetryTests(SyncDir, unittest.TestCase):
    """What a run tells Honeycomb (issue #140, specs/features/observability.feature).
    Every assertion here reads meta.json's "telemetry" field: the dict the workflow's
    send_sync_event.py later allow-lists and sends, not a helper's return value."""

    def test_a_successful_run_reports_fetch_counts_and_change_counts(self):
        self.run_sync(catalog_of(60))
        more = catalog_of(60)
        more.append(dict(more[-1], sessionId="extra-1", sessionInstanceId="extra-1", sessionCode="BRK999"))
        more = more[1:]   # drop one, add one, so added=1 removed=1
        code, changed = self.run_sync(more)
        self.assertEqual((code, changed), (0, True))
        t = self.data("meta.json")["telemetry"]
        self.assertEqual(t["conference"], "ignite2026")
        self.assertEqual(t["fetch_status"], "ok")
        self.assertEqual(t["records_fetched"], 60)
        self.assertEqual(t["records_accepted"], 60)
        self.assertEqual(t["records_skipped"], 0)
        self.assertFalse(t["guard_refused"])
        self.assertIsNone(t["guard"])
        self.assertEqual((t["added"], t["removed"], t["changed"]), (1, 1, 0))
        self.assertGreaterEqual(t["duration_ms"], 0)
        self.assertRegex(t["started_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_dropped_test_records_count_as_skipped_not_accepted(self):
        raw = catalog_of(60)
        raw.append(dict(raw[0], sessionId="t1", sessionInstanceId="t1", sessionCode="TEST1", title="Test"))
        self.run_sync(raw)
        t = self.data("meta.json")["telemetry"]
        self.assertEqual(t["records_fetched"], 61)
        self.assertEqual(t["records_accepted"], 60)
        self.assertEqual(t["records_skipped"], 1)

    def test_a_guard_refusal_is_reported_as_ok_fetch_but_a_refused_guard(self):
        self.run_sync(catalog_of(200))
        code, _ = self.run_sync(catalog_of(90))   # under 60% of 200: the partial guard refuses it
        self.assertEqual(code, 3)
        t = self.data("meta.json")["telemetry"]
        self.assertEqual(t["fetch_status"], "ok")   # the feed itself was read fine
        self.assertTrue(t["guard_refused"])
        self.assertEqual(t["guard"], "partial")
        self.assertEqual((t["added"], t["removed"], t["changed"]), (0, 0, 0))   # nothing was applied

    def test_a_withdrawal_refusal_names_the_withdrawal_guard(self):
        self.run_sync(catalog_of(100))
        bare = catalog_of(100)
        for r in bare:
            r["location"] = ""
        self.run_sync(bare)
        self.assertEqual(self.data("meta.json")["telemetry"]["guard"], "withdrawal")

    def test_an_unreadable_feed_is_a_failed_fetch_not_a_guard(self):
        path = self.write("raw.json", [None, 42])
        args = types.SimpleNamespace(from_file=path, speakers_file=None, settings_file=None,
                                     event_window="%s:%s" % W25, summary_out=None,
                                     data_dir=os.path.join(self.tmp, "data"))
        sync.run(args)
        t = self.data("meta.json")["telemetry"]
        self.assertEqual(t["fetch_status"], "failed")
        self.assertFalse(t["guard_refused"])
        self.assertIsNone(t["guard"])
        self.assertIsNone(t["records_accepted"])  # normalize() never ran

    def test_telemetry_never_carries_a_field_outside_honeycombs_allow_list(self):
        # No personal information is sent: an explicit allow-list per event type (CLAUDE.md test
        # rule 11), asserted against the actual dict every run produces, in both outcomes.
        self.run_sync(catalog_of(60))
        ok = self.data("meta.json")["telemetry"]
        self.assertTrue(set(ok) <= honeycomb.SYNC_RUN_FIELDS)
        self.run_sync(catalog_of(10))   # refused: under the 50-session floor
        refused = self.data("meta.json")["telemetry"]
        self.assertTrue(set(refused) <= honeycomb.SYNC_RUN_FIELDS)
        for forbidden in ("picks", "notes", "profile", "settings", "watchlist", "github_actor", "accepted_by"):
            self.assertNotIn(forbidden, ok)
            self.assertNotIn(forbidden, refused)


if __name__ == "__main__":
    unittest.main()
