"""Tests for scripts/venues.py and the unknown-building notice in the change summaries.

    python3 -m unittest tests.test_venues -v

Mirrors specs/features/venue-model.feature. The browser side of the venue model (floors,
walking minutes, the Settings matrix) is tested in tests/catalog.test.js; here the Python
mirror is checked against it room by room, and the sync and importers are run end to end.
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, HERE)
import sync  # noqa: E402
import venues  # noqa: E402
import test_import_reinvent  # noqa: E402
import test_sync  # noqa: E402

NODE = shutil.which("node")
NEW_ROOM = "Sponsor Pavilion, Stage 2"


def load(name):
    with open(os.path.join(HERE, "data", name), encoding="utf-8") as f:
        return json.load(f)


def recs(*rooms):
    return [{"code": "S%d" % i, "room": r} for i, r in enumerate(rooms)]


class PlacementTests(unittest.TestCase):
    """Rule: the Metreon is a building of its own (the Python mirror of assets/js/venue.js)."""

    def test_should_place_an_amc_theater_in_the_metreon(self):
        self.assertEqual(venues.building("moscone", "AMC Metreon | Level 3, Theater 9"), "E")

    def test_should_place_the_aviary_in_the_metreon(self):
        self.assertEqual(venues.building("moscone", "The Aviary, Labs"), "E")

    def test_should_keep_the_other_off_site_hotels_apart_from_the_metreon(self):
        self.assertEqual(venues.building("moscone", "InterContinental, Grand Ballroom"), "H")

    def test_should_not_know_a_sponsor_pavilion(self):
        self.assertIsNone(venues.building("moscone", NEW_ROOM))

    def test_should_treat_placeholders_and_blanks_as_no_room(self):
        self.assertEqual([venues.building("moscone", r) for r in ("zTest12", "TBD", "tba", "", None)], [None] * 5)


@unittest.skipUnless(NODE, "needs node")
class ParityTests(unittest.TestCase):
    """scripts/venues.py must place every room where assets/js/venue.js does."""

    # Literal rooms with the building both sides must report (None = unknown).
    CASES = {
        "ignite2026": {"AMC Metreon | Level 3, Theater 9": "E", "The Aviary, Labs": "E",
                       "Moscone West | Level 2, Room 2006": "W", "Moscone South | Level 2, Room 201": "S",
                       "Marriott Marquis | Lower B2, Yerba Buena Salon 8": "M", "Chase Center": "C",
                       "Online": "O", NEW_ROOM: None},
        "gartner2026": {"Lark 1, WDW Swan Hotel": "S", "Stage 1, IT Xpo, Atlantic Hall, WDW Dolphin Hotel": "D",
                        "Grand Harbor Salon 1, Disney's Yacht & Beach Resort": "Y", "Somewhere new": None},
        "reinvent2026": {"MGM Grand | Level 3 | Premier 311": "M", "Caesars Forum | Level 1 | Forum 120": "F",
                         "Caesars Palace | Promenade Level | Roman I": "C", "Resorts World | Level 1 | Hall A": None},
    }

    def js(self, conf, rooms):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        rooms_path, out = os.path.join(tmp, "rooms.json"), os.path.join(tmp, "out.json")
        with open(rooms_path, "w", encoding="utf-8") as f:
            json.dump(rooms, f)
        subprocess.run([NODE, os.path.join(HERE, "venue_cli.js"), conf, rooms_path, out],
                       check=True, cwd=ROOT, timeout=120)
        with open(out, encoding="utf-8") as f:
            return {r: (v["building"] if v["known"] else None) for r, v in json.load(f).items()}

    def rooms(self, conf):
        """Every published room of the conference plus the literal cases: the committed catalog, the
        test snapshot of real rooms, and CASES."""
        catalog = sync.load(os.path.join(ROOT, "data", conf, "sessions.json"), {}).get("sessions", [])
        snapshot = load("real_rooms.json")["rooms"].get(conf, [])
        return sorted({r["room"] for r in catalog if r.get("room")} | set(snapshot) | set(self.CASES[conf]))

    def test_should_place_every_published_room_where_the_browser_does(self):
        for conf, venue_id in venues.CONFERENCE_VENUES.items():
            rooms = self.rooms(conf)
            self.assertGreater(len(rooms), len(self.CASES[conf]), conf)   # the catalogs were read
            self.assertEqual({r: venues.building(venue_id, r) for r in rooms}, self.js(conf, rooms), conf)

    def test_should_place_the_literal_rooms_where_expected(self):
        for conf, cases in self.CASES.items():
            self.assertEqual({r: venues.building(venues.CONFERENCE_VENUES[conf], r) for r in cases}, cases, conf)
            self.assertEqual(self.js(conf, sorted(cases)), cases, conf)


class UnknownRoomTests(unittest.TestCase):
    """Rule: a room in an unknown building is announced the first time it appears."""

    def test_should_name_a_new_room_in_an_unknown_building_once(self):
        cur = recs(NEW_ROOM, NEW_ROOM, NEW_ROOM, "Moscone West | Level 2, Room 2006")
        self.assertEqual(venues.unknown_rooms("moscone", cur, []), [NEW_ROOM])

    def test_should_not_repeat_a_room_the_last_catalog_already_had(self):
        cur = recs(NEW_ROOM, "Moscone West | Level 2, Room 2006")
        self.assertEqual(venues.unknown_rooms("moscone", cur, recs(NEW_ROOM)), [])

    def test_should_ignore_placeholders_and_blanks(self):
        self.assertEqual(venues.unknown_rooms("moscone", recs("zTest12", "TBD", "", None), []), [])

    def test_should_list_several_rooms_in_label_order(self):
        cur = recs("Zephyr Hall, Stage 1", NEW_ROOM, "Zephyr Hall, Stage 1")
        self.assertEqual(venues.unknown_rooms("moscone", cur, []), [NEW_ROOM, "Zephyr Hall, Stage 1"])

    def test_should_use_the_venue_of_the_conference(self):
        self.assertEqual(venues.unknown_rooms("las-vegas", recs("Moscone West | Level 2, Room 2006"), []),
                         ["Moscone West | Level 2, Room 2006"])


class NoticeTests(unittest.TestCase):
    """The change summary and the run log name the unknown rooms."""

    def batch(self, rooms=None):
        b = {"milestones": [], "added": [], "removed": [], "changed": []}
        if rooms is not None:
            b["unknownRooms"] = rooms
        return b

    def test_should_name_one_unknown_room(self):
        self.assertIn("**1 room in an unknown building:** " + NEW_ROOM, sync.summary_markdown(self.batch([NEW_ROOM]), set()))

    def test_should_count_several_unknown_rooms(self):
        self.assertIn("**2 rooms in an unknown building:** %s, Zephyr Hall" % NEW_ROOM,
                      sync.summary_markdown(self.batch([NEW_ROOM, "Zephyr Hall"]), set()))

    def test_should_say_nothing_when_every_room_is_known(self):
        text = sync.summary_markdown(self.batch([]), set())
        self.assertEqual(("unknown building" in text, "Added 0 · removed 0 · changed 0" in text), (False, True))

    def test_should_read_a_batch_logged_before_the_notice_existed(self):
        text = sync.summary_markdown(self.batch(), set())
        self.assertEqual(("unknown building" in text, "Added 0 · removed 0 · changed 0" in text), (False, True))

    def test_should_put_the_notice_in_the_run_log_line(self):
        stats = {"sessions": 1, "withDates": 1, "withRooms": 1}
        line = sync.console_summary(stats, 0, [], [], [], [], unknown=[NEW_ROOM, "Zephyr Hall"])
        self.assertIn("| 2 rooms in an unknown building", line)
        self.assertNotIn("unknown building", sync.console_summary(stats, 0, [], [], [], []))


def moved_to(raw, room, n):
    """The first n sessions of a raw Ignite catalog moved to room."""
    out = copy.deepcopy(raw)
    for s in out[:n]:
        s["location"] = {"displayValue": room, "logicalValue": room}
    return out


class SyncNoticeTests(test_sync.SyncDir, unittest.TestCase):
    """The Ignite sync, end to end over a temporary data directory."""

    def setUp(self):
        super().setUp()
        self.raw = load("raw_2025_sample.json")
        self.run_sync(self.raw)   # baseline

    def summary(self):
        with open(os.path.join(self.tmp, "summary.md"), encoding="utf-8") as f:
            return f.read()

    def test_should_announce_a_new_room_in_an_unknown_building_once(self):
        moved = moved_to(self.raw, NEW_ROOM, 3)
        self.assertEqual(self.run_sync(moved), (0, True))
        self.assertEqual(self.data("changes.json")["batches"][0]["unknownRooms"], [NEW_ROOM])
        self.assertIn("**1 room in an unknown building:** " + NEW_ROOM, self.summary())

        again = copy.deepcopy(moved)
        again[-1]["title"] = again[-1]["title"] + " (updated)"
        self.assertEqual(self.run_sync(again), (0, True))
        self.assertEqual(self.data("changes.json")["batches"][0]["unknownRooms"], [])
        self.assertEqual(("unknown building" in self.summary(), "changed 1" in self.summary()), (False, True))

    def test_should_not_announce_a_placeholder_room(self):
        self.assertEqual(self.run_sync(moved_to(self.raw, "zTest12", 3)), (0, True))
        batch = self.data("changes.json")["batches"][0]
        self.assertEqual((batch["unknownRooms"], len(batch["changed"])), ([], 3))


class ReinventNoticeTests(test_import_reinvent.ImportDir, unittest.TestCase):
    """The re:Invent importer records the notice in its batch and changelog."""

    def test_should_record_a_new_unknown_room(self):
        self.run_import()   # baseline
        sessions = test_import_reinvent.sample()
        sessions[0]["times"][0]["room"] = "Resorts World | Level 1 | Hall A"
        self.write_snapshot(sessions)
        self.assertEqual(self.run_import(), (0, True))
        self.assertEqual(self.data("changes.json")["batches"][0]["unknownRooms"], ["Resorts World | Level 1 | Hall A"])
        with open(os.path.join(self.dir, "changelog.md"), encoding="utf-8") as f:
            self.assertIn("**1 room in an unknown building:** Resorts World | Level 1 | Hall A", f.read())


class GartnerNoticeTests(unittest.TestCase):
    """The Gartner importer records the notice in its batch."""

    OK = {"id": 1, "code": "T1", "t": "Talk", "s": "10/19/2026 10:00:00", "e": "10/19/2026 10:45:00",
          "loc": "Lark 1, WDW Swan Hotel", "f": {"Session Type": ["Track Sessions"]}}

    def import_export(self, tmp, records):
        export = os.path.join(tmp, "export.json")
        with open(export, "w", encoding="utf-8") as f:
            json.dump(records, f)
        subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "import_gartner.py"), export, "--data-dir", tmp],
                       check=True, capture_output=True, timeout=120)

    def test_should_record_a_new_unknown_room(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        self.import_export(tmp, [self.OK])   # baseline
        self.import_export(tmp, [dict(self.OK, loc="Somewhere new")])
        with open(os.path.join(tmp, "changes.json"), encoding="utf-8") as f:
            batch = json.load(f)["batches"][0]
        self.assertEqual((batch["unknownRooms"], len(batch["changed"])), (["Somewhere new"], 1))


if __name__ == "__main__":
    unittest.main()
