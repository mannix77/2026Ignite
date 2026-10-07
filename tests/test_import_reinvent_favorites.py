"""Tests for scripts/import_reinvent_favorites.py (specs/features/reinvent-favorites.feature).

    python3 -m unittest tests.test_import_reinvent_favorites -v
"""
import contextlib
import datetime as dt
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import import_reinvent_favorites as rf  # noqa: E402

NOW = dt.datetime(2026, 10, 7, 14, 0, 0, tzinfo=dt.timezone.utc)
NOW_MS = 1791381600000


def catalog_rec(code, sid, group=None):
    return {"id": sid, "inst": sid, "code": code, "group": group or code.split("-R")[0], "title": code}


def export_session(sid, code, favorite=True, reserved=False, availability="reserve_a_seat", few=False,
                   capacity=84, remaining=10):
    return {"id": sid, "code": code, "favorite": favorite, "reserved": reserved, "availability": availability,
            "few_seats_left": few,
            "times": [{"timeId": sid + "-t", "reserved": reserved, "capacity": capacity, "seatsRemaining": remaining}]}


CATALOG = [catalog_rec("PEX403-R1", "p1"), catalog_rec("SVS304-R", "s1"), catalog_rec("IND327-R", "i1"),
           catalog_rec("SVS350", "s2"), catalog_rec("COP357", "c1"), catalog_rec("ARC320-R", "a1"),
           catalog_rec("WRK200", "w1")]
EXPORT = {"exported_at": "2026-10-07T13:53:05.967Z", "sessions": [
    export_session("p1", "PEX403-R1", reserved=True, availability="reserved"),
    export_session("s1", "SVS304-R"),
    export_session("i1", "IND327-R", availability="session_full", remaining=0),
    export_session("s2", "SVS350", few=True, remaining=3),
    export_session("c1", "COP357", favorite=False, reserved=True, availability="reserved"),
    export_session("a1", "ARC320-R", favorite=False, reserved=False),
    export_session("e1", "ESES26", reserved=True, availability="reserved"),
    export_session("w1", "WRK200", availability="walk_up_only"),
    {"id": "  ", "code": "JUNK1", "favorite": True},
    "not a session",
]}
JUNK = [
    dict(export_session("j1", "JUNK2"), times=7),                                   # times isn't a list
    dict(export_session("j2", "JUNK3"), availability=["session_full"]),              # availability isn't a string
    dict(export_session("j3", "JUNK4"), reserved="false"),                            # a string flag
    dict(export_session("j4", "JUNK5"), favorite="yes"),                              # a string flag
    {"id": "j5", "code": "JUNK6", "favorite": True, "times": [{"timeId": "x", "reserved": "no"}]},
]


class FavoritesTests(unittest.TestCase):
    def setUp(self):
        self.picks, self.seats, self.skipped = rf.favorites(EXPORT, CATALOG, NOW)

    def test_should_pin_a_reserved_seat_as_must_locked_to_that_run(self):
        self.assertEqual(self.picks["p1"], {"p": 3, "lock": "p1", "reserved": "p1", "note": "", "at": NOW_MS,
                                            "g": "PEX403", "code": "PEX403-R1"})

    def test_should_rate_a_favorite_with_open_seats_want(self):
        self.assertEqual((self.picks["s1"]["p"], self.picks["s1"]["lock"]), (2, None))
        self.assertNotIn("reserved", self.picks["s1"])

    def test_should_rate_a_full_favorite_maybe(self):
        self.assertEqual(self.picks["i1"]["p"], 1)

    def test_should_rate_a_walk_up_only_favorite_want(self):
        self.assertEqual(self.picks["w1"]["p"], 2)

    def test_should_treat_a_reserved_seat_that_is_not_a_favorite_as_a_commitment(self):
        self.assertEqual((self.picks["c1"]["p"], self.picks["c1"]["reserved"]), (3, "c1"))

    def test_should_record_seats_left_and_the_few_seats_warning(self):
        self.assertEqual(self.seats["s2"], {"availability": "reserve_a_seat", "fewSeatsLeft": True, "capacity": 84, "seatsRemaining": 3})
        self.assertEqual(self.seats["i1"], {"availability": "session_full", "fewSeatsLeft": False, "capacity": 84, "seatsRemaining": 0})
        self.assertEqual(self.seats["p1"]["availability"], "reserved")

    def test_should_skip_sessions_missing_from_the_catalog_and_count_them(self):
        self.assertNotIn("e1", self.picks)
        self.assertEqual(self.skipped["unknown"], ["ESES26"])

    def test_should_skip_sessions_neither_favorited_nor_reserved(self):
        self.assertNotIn("a1", self.picks)
        self.assertEqual(self.skipped["unmarked"], 1)

    def test_should_skip_junk_records_without_failing(self):
        self.assertEqual(self.skipped["junk"], 2)
        self.assertEqual(sorted(self.picks), ["c1", "i1", "p1", "s1", "s2", "w1"])

    def test_should_publish_no_personal_notes(self):
        self.assertEqual(len(self.picks), 6)
        self.assertTrue(all(pk["note"] == "" for pk in self.picks.values()))

    def test_should_count_malformed_fields_as_junk_without_aborting(self):
        catalog = CATALOG + [catalog_rec("JUNK%d" % n, "j%d" % n) for n in range(1, 6)]
        picks, seats, skipped = rf.favorites({"sessions": JUNK + [export_session("s1", "SVS304-R")]}, catalog, NOW)
        self.assertEqual((sorted(picks), skipped["junk"]), (["s1"], 5))

    def test_should_leave_out_seat_counts_that_are_not_whole_numbers(self):
        odd = export_session("s1", "SVS304-R")
        odd["times"][0].update(capacity=1e309, seatsRemaining=-2)
        picks, seats, _ = rf.favorites({"sessions": [odd]}, CATALOG, NOW)
        self.assertEqual((picks["s1"]["p"], seats["s1"]), (2, {"availability": "reserve_a_seat", "fewSeatsLeft": False}))

    def test_should_take_seat_counts_from_the_reserved_slot(self):
        two = export_session("p1", "PEX403-R1", reserved=True, availability="reserved", capacity=50, remaining=5)
        two["times"] = [{"timeId": "p1-a", "reserved": False, "capacity": 50, "seatsRemaining": 5},
                        {"timeId": "p1-b", "reserved": True, "capacity": 120, "seatsRemaining": 0}]
        picks, seats, _ = rf.favorites({"sessions": [two]}, CATALOG, NOW)
        self.assertEqual((picks["p1"]["reserved"], seats["p1"]["capacity"], seats["p1"]["seatsRemaining"]), ("p1", 120, 0))


class EntryPointTests(unittest.TestCase):
    """What the real entry point writes, on disk."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.data = os.path.join(self.tmp, "data")
        os.makedirs(self.data)
        with open(os.path.join(self.data, "sessions.json"), "w", encoding="utf-8") as f:
            json.dump({"generatedAt": "2026-10-07T13:00:04Z", "sessions": CATALOG}, f)
        self.export = os.path.join(self.tmp, "export.json")
        # The real entry point refuses an export that is mostly junk; keep the two junk records
        # for the function tests above and give the entry point the clean sessions only.
        clean = {"exported_at": EXPORT["exported_at"], "sessions": [x for x in EXPORT["sessions"] if isinstance(x, dict) and x.get("id", "").strip()]}
        with open(self.export, "w", encoding="utf-8") as f:
            json.dump(clean, f)
        self.backup = os.path.join(self.tmp, "backup")

    def run_main(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = rf.main([self.export, "--data-dir", self.data, "--backup-dir", self.backup, "--now", "2026-10-07T14:00:00Z", *extra])
        return result, out.getvalue()

    def read(self, *path):
        with open(os.path.join(*path), encoding="utf-8") as f:
            return json.load(f)

    def test_should_write_favorites_seats_and_a_backup(self):
        result, out = self.run_main()
        fav = self.read(self.data, "favorites.json")
        self.assertEqual((fav["conference"], fav["version"], fav["exportedAt"]), ("reinvent2026", "20261007-6", "2026-10-07T13:53:05.967Z"))
        self.assertEqual(fav["picks"]["p1"]["reserved"], "p1")
        self.assertEqual(sorted(fav["picks"]), ["c1", "i1", "p1", "s1", "s2", "w1"])
        seats = self.read(self.data, "seats.json")
        self.assertEqual((seats["kind"], seats["conference"], seats["seats"]["s2"]["seatsRemaining"]), ("seats", "reinvent2026", 3))
        backup = self.read(self.backup, "reinvent-2026-picks.json")
        self.assertEqual((backup["conference"], backup["exportedAt"], backup["picks"]), ("reinvent2026", "2026-10-07T14:00:00Z", fav["picks"]))
        self.assertEqual(result["skipped"]["unknown"], ["ESES26"])
        self.assertIn("6 picks (Must 2 incl. 2 reserved, Want 3, Maybe 1); skipped: 1 not in the catalog (ESES26), 1 not favorited, 0 junk", out)

    def test_should_refuse_a_mostly_junk_export_and_keep_the_existing_files(self):
        self.run_main()
        before = (self.read(self.data, "favorites.json"), self.read(self.data, "seats.json"), self.read(self.backup, "reinvent-2026-picks.json"))
        with open(self.export, "w", encoding="utf-8") as f:
            json.dump({"exported_at": "2026-10-08T09:00:00Z", "sessions": [export_session("s1", "SVS304-R")] + ["junk"] * 2}, f)
        with self.assertRaises(SystemExit) as cm:
            self.run_main()
        self.assertIn("2 of 3 records are junk", str(cm.exception))
        after = (self.read(self.data, "favorites.json"), self.read(self.data, "seats.json"), self.read(self.backup, "reinvent-2026-picks.json"))
        self.assertEqual(after, before)

    def test_should_accept_junk_just_inside_the_threshold(self):
        with open(self.export, "w", encoding="utf-8") as f:
            json.dump({"sessions": [export_session("s1", "SVS304-R")] * 9 + ["junk"]}, f)
        result, _ = self.run_main()
        self.assertEqual((result["picks"], result["skipped"]["junk"]), (1, 1))

    def test_should_refuse_an_empty_export(self):
        with open(self.export, "w", encoding="utf-8") as f:
            json.dump({"sessions": []}, f)
        with self.assertRaises(SystemExit):
            self.run_main()
        self.assertFalse(os.path.exists(os.path.join(self.data, "favorites.json")))

    def test_should_refuse_an_export_of_the_wrong_shape(self):
        with open(self.export, "w", encoding="utf-8") as f:
            json.dump([1, 2, 3], f)
        with self.assertRaises(SystemExit):
            self.run_main()
        self.assertFalse(os.path.exists(os.path.join(self.data, "favorites.json")))

    def test_should_refuse_to_run_without_an_imported_catalog(self):
        os.remove(os.path.join(self.data, "sessions.json"))
        with self.assertRaises(SystemExit):
            self.run_main()
        self.assertFalse(os.path.exists(os.path.join(self.data, "favorites.json")))


if __name__ == "__main__":
    unittest.main()
