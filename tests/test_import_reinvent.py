"""Tests for scripts/import_reinvent.py (AWS re:Invent 2026 catalog importer).

    python3 -m unittest tests.test_import_reinvent -v

Mirrors specs/features/reinvent-catalog.feature; edge cases live here as unit tests.
"""
import contextlib
import copy
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
import import_reinvent as ri  # noqa: E402


def load(name):
    with open(os.path.join(HERE, "data", name), encoding="utf-8") as f:
        return json.load(f)


def by_code(recs):
    return {r["code"]: r for r in recs}


SNAP = load("reinvent_sample.json")


def sample():
    return copy.deepcopy(SNAP["sessions"])


def imported():
    return by_code(ri.normalize(sample())[0])


def distinct(field):
    """Every distinct value of one field across the imported sample (lists as tuples)."""
    return {tuple(v) if isinstance(v, list) else v for v in (r[field] for r in imported().values())}


def codes(recs):
    return [r["code"] for r in recs]


class RepeatRunTests(unittest.TestCase):
    """Rule: repeat runs of a session are one choice."""

    def test_should_group_bare_r_and_r1_runs_under_the_base_code(self):
        c = imported()
        self.assertEqual([c["ANT319-R"]["group"], c["ANT319-R1"]["group"]], ["ANT319", "ANT319"])

    def test_should_list_the_sibling_runs_as_repeats(self):
        self.assertEqual(imported()["ANT319-R"]["repeats"], ["ANT319-R1"])

    def test_should_group_a_base_code_with_its_r1_run(self):
        self.assertEqual(imported()["SEC309-R1"]["group"], "SEC309")

    def test_should_group_sponsored_repeats_by_their_sponsored_code(self):
        self.assertEqual(imported()["INV002-S-R1"]["group"], "INV002-S")

    def test_should_strip_the_repeat_marker_from_titles(self):
        self.assertEqual(imported()["ANT319-R1"]["title"], "10 tips for querying Apache Iceberg data with Amazon Redshift")


class SponsoredTests(unittest.TestCase):
    """Rule: sponsored sessions name their sponsor as a vendor."""

    def test_should_take_the_vendor_from_the_sponsor_speakers_company(self):
        self.assertEqual(imported()["DVT212-S"]["vendors"], ["CodeRabbit Inc."])

    def test_should_mark_a_sponsored_code_without_the_appendix_as_sponsored(self):
        self.assertTrue(imported()["INV003-S"]["sponsored"])

    def test_should_not_mark_an_aws_session_as_sponsored(self):
        self.assertFalse(imported()["ANT319-R"]["sponsored"])

    def test_should_put_vendors_in_tags_so_browse_can_filter_on_them(self):
        self.assertIn("CodeRabbit Inc.", imported()["DVT212-S"]["tags"])


class SelfPacedTests(unittest.TestCase):
    """Rule: self-paced sessions stay in the catalog without a slot."""

    def test_should_keep_a_session_with_no_time(self):
        self.assertIn("GHJ205-R", imported())

    def test_should_leave_an_untimed_session_unscheduled(self):
        r = imported()["GHJ205-R"]
        self.assertEqual([r["start"], r["end"], r["slot"], r["room"], r["roomTbd"]], [None, None, None, None, True])

    def test_should_not_require_a_seat_for_an_untimed_session(self):
        self.assertFalse(imported()["GHJ205-R"]["rsvp"])


class ScheduledSessionTests(unittest.TestCase):
    """Rule: every scheduled in-person session needs a reserved seat; times in UTC + Pacific slot."""

    def test_should_require_a_seat_for_a_scheduled_session(self):
        self.assertTrue(imported()["DVT212-S"]["rsvp"])

    def test_should_say_when_seat_reservations_open(self):
        self.assertEqual(imported()["DVT212-S"]["rsvpOpens"], "2026-10-06T16:00:00Z")

    def test_should_not_give_an_untimed_session_a_reservation_date(self):
        self.assertNotIn("rsvpOpens", imported()["GHJ205-R"])

    def test_should_convert_the_utc_start_to_iso(self):
        self.assertEqual(imported()["DVT212-S"]["start"], "2026-12-01T00:30:00Z")

    def test_should_convert_the_utc_end_to_iso(self):
        self.assertEqual(imported()["DVT212-S"]["end"], "2026-12-01T01:30:00Z")

    def test_should_keep_the_pacific_slot(self):
        self.assertEqual(imported()["DVT212-S"]["slot"], "16:30 - 17:30")

    def test_should_take_duration_from_the_time_slot(self):
        self.assertEqual(imported()["DVT212-S"]["dur"], 60)

    def test_should_keep_the_full_room_string(self):
        self.assertEqual(imported()["AIM105-S"]["room"], "Caesars Forum | Level 1 | Forum 120 | Content Hub | Red Theater")

    def test_should_mark_a_published_room_as_known(self):
        self.assertFalse(imported()["DVT212-S"]["roomTbd"])

    def test_should_keep_room_capacity_as_a_number(self):
        self.assertEqual(imported()["DVT212-S"]["capacity"], 212)


class FieldMappingTests(unittest.TestCase):
    """Normalized record shape shared with the Ignite and Gartner catalogs."""

    def test_should_use_the_session_id_as_id_and_instance(self):
        r = imported()["DVT212-S"]
        self.assertEqual([r["id"], r["inst"]], ["1780441485206001GC7l"] * 2)

    def test_should_keep_aws_session_type_names(self):
        self.assertEqual(imported()["SEC309"]["type"], "Builders' session")

    def test_should_parse_the_level_as_an_integer(self):
        self.assertEqual(imported()["DVT212-S"]["level"], 200)

    def test_should_map_no_level_to_none(self):
        self.assertIsNone(imported()["INV003-S"]["level"])

    def test_should_order_speakers_as_name_company_title(self):
        self.assertEqual(imported()["DVT212-S"]["speakers"], [["David Loker", "CodeRabbit Inc.", "VP of AI"]])

    def test_should_keep_every_speaker_of_a_multi_speaker_session(self):
        self.assertEqual(len(imported()["AIM344"]["speakers"]), 5)

    def test_should_take_topics_from_the_topic_facet(self):
        raw = sample()
        rec = by_code(raw)["DVT212-S"]
        self.assertEqual(imported()["DVT212-S"]["topics"], rec["attributes"].get("Topic", []))

    def test_should_take_tags_from_areas_of_interest_then_services(self):
        rec = by_code(sample())["AIM344"]
        want = rec["attributes"].get("AreaofInterest", []) + rec["attributes"].get("Services", [])
        self.assertEqual(imported()["AIM344"]["tags"], want)

    def test_should_take_audience_from_roles_then_industries(self):
        rec = by_code(sample())["SEC205"]
        want = rec["attributes"].get("Role", []) + rec["attributes"].get("Industry", [])
        self.assertEqual(imported()["SEC205"]["audience"], want)

    def test_should_deliver_every_session_in_person(self):
        self.assertEqual(distinct("delivery"), {("In-person",)})

    def test_should_assume_breakouts_are_recorded(self):
        self.assertTrue(imported()["DVT212-S"]["recorded"])

    def test_should_assume_other_types_are_not_recorded(self):
        self.assertFalse(imported()["ANT319-R"]["recorded"])

    def test_should_flag_a_laptop_required_session(self):
        self.assertTrue(imported()["AIM222-S"]["laptop"])

    def test_should_not_flag_a_session_without_the_laptop_appendix(self):
        self.assertFalse(imported()["DVT212-S"]["laptop"])

    def test_should_never_mark_sessions_popular(self):
        self.assertEqual(distinct("popular"), {False})


class ExclusionTests(unittest.TestCase):
    def test_should_drop_test_records(self):
        raw = sample()
        raw[0]["testRecord"] = True
        self.assertNotIn(raw[0]["code"], by_code(ri.normalize(raw)[0]))

    def test_should_drop_sessions_that_are_not_accepted(self):
        raw = sample()
        raw[0]["status"] = "Cancelled"
        self.assertNotIn(raw[0]["code"], by_code(ri.normalize(raw)[0]))

    def test_should_drop_unpublished_sessions(self):
        raw = sample()
        raw[0]["published"] = 0
        self.assertNotIn(raw[0]["code"], by_code(ri.normalize(raw)[0]))

    def test_should_count_each_kind_of_exclusion(self):
        raw = sample()
        raw[0]["testRecord"] = True
        raw[1]["status"] = "Cancelled"
        raw[2]["published"] = 0
        self.assertEqual(ri.normalize(raw)[1], {"test": 1, "notAccepted": 1, "unpublished": 1, "malformed": 0, "extraRuns": 0})


class FetchTests(unittest.TestCase):
    """--fetch: page through the public API and slim records to the snapshot shape."""

    def setUp(self):
        self.pages = load("reinvent_raw_pages.json")
        self.calls = []

    def post(self, offset):
        self.calls.append(offset)
        return self.pages[offset // ri.PAGE_SIZE]

    def test_should_page_in_steps_of_fifty_until_an_empty_page(self):
        ri.fetch_catalog(self.post)
        self.assertEqual(self.calls, [0, 50, 100])

    def test_should_skip_a_page_item_that_is_not_a_session(self):
        self.pages[1]["items"] = [None, "junk"] + self.pages[1]["items"]
        self.assertEqual(codes(ri.fetch_catalog(self.post)), ["DVT212-S", "ANT319-R", "ANT203-S"])

    def test_should_skip_a_page_item_with_an_unusable_session_id(self):
        self.pages[1]["items"] = [{"sessionID": ["x"], "code": "BAD1"}] + self.pages[1]["items"]
        self.assertEqual(codes(ri.fetch_catalog(self.post)), ["DVT212-S", "ANT319-R", "ANT203-S"])

    def test_should_keep_a_session_listed_on_two_pages_once(self):
        self.pages[1]["items"] = self.pages[1]["items"] + self.pages[0]["sectionList"][0]["items"][:1]
        self.assertEqual(codes(ri.fetch_catalog(self.post)), ["DVT212-S", "ANT319-R", "ANT203-S"])

    def test_should_refuse_a_page_that_reports_an_error(self):
        self.pages[1] = {"responseCode": "500", "responseMessage": "Internal error"}
        with self.assertRaisesRegex(RuntimeError, "Internal error"):
            ri.fetch_catalog(self.post)

    def test_should_refuse_paging_that_ends_short_of_the_reported_total(self):
        self.pages[1]["items"] = []
        with self.assertRaisesRegex(RuntimeError, "2 of 3"):
            ri.fetch_catalog(self.post)

    def test_should_refuse_paging_when_a_later_page_reports_a_different_total(self):
        self.pages[1]["total"] = 2
        with self.assertRaisesRegex(RuntimeError, "3, then 2"):
            ri.fetch_catalog(self.post)

    def test_should_hold_paging_to_a_total_given_as_text(self):
        self.pages[0]["sectionList"][0]["total"] = "3"
        self.pages[1]["total"], self.pages[1]["items"] = "3", []
        with self.assertRaisesRegex(RuntimeError, "2 of 3"):
            ri.fetch_catalog(self.post)

    def test_should_not_read_a_true_flag_as_a_total(self):
        self.pages[0]["sectionList"][0]["total"] = True  # read as 1, the later pages' 3 would look like a change
        self.assertEqual(codes(ri.fetch_catalog(self.post)), ["DVT212-S", "ANT319-R", "ANT203-S"])

    def test_should_collect_items_from_the_first_and_later_page_shapes(self):
        self.assertEqual(codes(ri.fetch_catalog(self.post)), ["DVT212-S", "ANT319-R", "ANT203-S"])

    def test_should_slim_a_raw_record_to_the_snapshot_shape(self):
        got = ri.fetch_catalog(self.post)[0]
        want = by_code(SNAP["sessions"])["DVT212-S"]
        self.assertEqual(got, want)

    def test_should_fall_back_to_the_global_profile_when_company_and_title_are_blank(self):
        raw = copy.deepcopy(self.pages[0]["sectionList"][0]["items"][0])
        p = raw["participants"][0]
        p.update(companyName="", jobTitle="", globalCompany="Caylent", globalJobtitle="Sr Innovation Architect")
        spk = ri.slim(raw)["speakers"][0]
        self.assertEqual([spk["company"], spk["title"]], ["Caylent", "Sr Innovation Architect"])


class ImportDir:
    """A temporary data directory with a snapshot to import from."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.snap = os.path.join(self.dir, "snap.json")
        self.write_snapshot(sample())

    def write_snapshot(self, sessions):
        doc = dict(SNAP, count=len(sessions), sessions=sessions)
        with open(self.snap, "w", encoding="utf-8") as f:
            json.dump(doc, f)

    def run_import(self):
        args = types.SimpleNamespace(snapshot=self.snap, fetch=False, data_dir=self.dir, summary_out=None,
                                     snapshot_out=None)
        return ri.run(args)

    def data(self, name):
        return load_path(os.path.join(self.dir, name))


class ImportRunTests(ImportDir, unittest.TestCase):
    """End to end over a temporary data directory."""

    def test_should_write_the_catalog_on_first_import(self):
        self.run_import()
        self.assertEqual(len(self.data("sessions.json")["sessions"]), len(SNAP["sessions"]))

    def test_should_record_a_baseline_entry_in_the_changelog(self):
        self.run_import()
        with open(os.path.join(self.dir, "changelog.md"), encoding="utf-8") as f:
            self.assertIn("Baseline import: %d sessions" % len(SNAP["sessions"]), f.read())

    def test_should_refuse_a_refresh_with_under_90_percent_of_sessions(self):
        self.run_import()
        self.write_snapshot(sample()[:15])
        self.run_import()
        self.assertEqual(len(self.data("sessions.json")["sessions"]), len(SNAP["sessions"]))

    def test_should_exit_non_zero_when_a_refresh_is_refused(self):
        self.run_import()
        self.write_snapshot(sample()[:15])
        self.assertEqual(self.run_import()[0], 3)

    def test_should_log_a_room_move_in_changes_json(self):
        self.run_import()
        moved = sample()
        by_code(moved)["ANT319-R"]["times"][0]["room"] = "MGM Grand | Level 3 | Room 301"
        self.write_snapshot(moved)
        self.run_import()
        change = self.data("changes.json")["batches"][0]["changed"][0]
        self.assertEqual([change["code"], change["f"]["room"][1]], ["ANT319-R", "MGM Grand | Level 3 | Room 301"])

    def test_should_log_a_room_move_in_the_changelog(self):
        self.run_import()
        moved = sample()
        by_code(moved)["ANT319-R"]["times"][0]["room"] = "MGM Grand | Level 3 | Room 301"
        self.write_snapshot(moved)
        self.run_import()
        with open(os.path.join(self.dir, "changelog.md"), encoding="utf-8") as f:
            self.assertIn("room: MGM Grand | Level 3 | Premier 311 → MGM Grand | Level 3 | Room 301", f.read())

    def test_should_report_no_change_when_the_catalog_is_unchanged(self):
        self.run_import()
        self.assertEqual(self.run_import(), (0, False))

    def test_should_stamp_first_seen_on_a_session_added_later(self):
        self.write_snapshot(sample()[1:])
        self.run_import()
        self.write_snapshot(sample())
        self.run_import()
        self.assertIsNotNone(by_code(self.data("sessions.json")["sessions"])["ANT319-R"]["firstSeen"])


class MalformedRecordTests(ImportDir, unittest.TestCase):
    """One broken entry in the AWS feed must not fail every later import."""

    def test_should_import_every_session_when_the_feed_holds_an_empty_record(self):
        self.assertEqual(len(ri.normalize([None] + sample())[0]), len(ri.normalize(sample())[0]))

    def test_should_skip_a_record_without_a_session_id(self):
        raw = sample()
        del raw[0]["sessionID"]
        self.assertNotIn(raw[0]["code"], by_code(ri.normalize(raw)[0]))

    def test_should_count_skipped_records_as_malformed(self):
        raw = sample()
        del raw[0]["sessionID"]
        self.assertEqual(ri.normalize([None, "junk"] + raw)[1]["malformed"], 3)

    def test_should_count_blank_or_non_text_session_ids_as_malformed(self):
        raw = sample()[:3]
        raw[0]["sessionID"], raw[1]["sessionID"], raw[2]["sessionID"] = "   ", ["x"], {"id": 1}
        self.assertEqual(ri.normalize(raw)[1]["malformed"], 3)

    def test_should_use_the_trimmed_session_id(self):
        raw = sample()[:1]
        raw[0]["sessionID"] = "  %s\n" % raw[0]["sessionID"]
        self.assertEqual(ri.normalize(raw)[0][0]["id"], raw[0]["sessionID"].strip())

    def test_should_keep_a_session_whose_speaker_entry_is_garbled(self):
        raw = sample()
        raw[0]["speakers"] = ["garbled", None] + raw[0]["speakers"]
        self.assertEqual(by_code(ri.normalize(raw)[0])[raw[0]["code"]]["speakers"], by_code(ri.normalize(sample())[0])[raw[0]["code"]]["speakers"])

    def test_should_keep_a_session_whose_time_entry_is_garbled_unscheduled(self):
        raw = sample()
        raw[0]["times"] = ["garbled"]
        self.assertIsNone(by_code(ri.normalize(raw)[0])[raw[0]["code"]]["start"])

    def test_should_complete_an_import_from_a_feed_with_an_empty_record(self):
        self.write_snapshot([None] + sample())
        self.assertEqual(self.run_import()[0], 0)


class ExtraRunTests(unittest.TestCase):
    """AWS lists repeats as separate sessions; a second time on one record has never been seen."""

    def two_times(self):
        raw = sample()
        rec = by_code(raw)["ANT319-R"]
        second = dict(rec["times"][0], sessionTimeID="T2", utcStartTime="2026/12/03 18:00:00", utcEndTime="2026/12/03 19:00:00")
        rec["times"].append(second)
        return raw

    def test_should_import_the_first_time_of_a_session_with_two(self):
        with contextlib.redirect_stderr(io.StringIO()):
            recs = by_code(ri.normalize(self.two_times())[0])
        self.assertEqual(recs["ANT319-R"]["start"], by_code(ri.normalize(sample())[0])["ANT319-R"]["start"])

    def test_should_count_the_extra_run(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(ri.normalize(self.two_times())[1]["extraRuns"], 1)

    def test_should_warn_which_session_has_an_extra_run(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            ri.normalize(self.two_times())
        self.assertIn("ANT319-R", err.getvalue())


class CiSignalTests(ImportDir, unittest.TestCase):
    """The workflow posts to the change issue only when the script reports changed=true."""

    def cli(self):
        """Runs the importer as the workflow does; -> what it wrote to GITHUB_OUTPUT."""
        out = os.path.join(self.dir, "github_output")
        open(out, "w").close()
        subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "import_reinvent.py"), self.snap, "--data-dir", self.dir],
                       env=dict(os.environ, GITHUB_OUTPUT=out), check=True, capture_output=True, timeout=120)
        with open(out, encoding="utf-8") as f:
            return f.read()

    def test_should_report_a_change_to_the_workflow(self):
        self.cli()
        moved = sample()
        by_code(moved)["ANT319-R"]["times"][0]["room"] = "MGM Grand | Level 3 | Room 301"
        self.write_snapshot(moved)
        self.assertEqual(self.cli(), "changed=true\n")

    def test_should_report_no_change_to_the_workflow(self):
        self.cli()
        self.assertEqual(self.cli(), "changed=false\n")


class FetchRefusedTests(ImportDir, unittest.TestCase):
    """A refused --fetch keeps the last good catalog (the scheduled workflow's path)."""

    def test_should_keep_the_saved_catalog_when_a_page_reports_an_error(self):
        self.run_import()
        before = self.data("sessions.json")
        pages = load("reinvent_raw_pages.json")
        pages[1] = {"responseCode": "500", "responseMessage": "Internal error"}
        fetch = ri.fetch_catalog
        args = types.SimpleNamespace(snapshot=None, fetch=True, data_dir=self.dir, summary_out=None, snapshot_out=None)
        with mock.patch.object(ri, "fetch_catalog", lambda: fetch(lambda offset: pages[offset // ri.PAGE_SIZE])), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual((ri.run(args), self.data("sessions.json")), ((3, False), before))


def renamed(sessions, old, new):
    """The same sessions, with one field of every scheduled time renamed (a feed format change)."""
    for r in sessions:
        for t in r.get("times") or []:
            if old in t:
                t[new] = t.pop(old)
    return sessions


class WithdrawalGuardTests(ImportDir, unittest.TestCase):
    """A renamed time or room field keeps every session but empties those fields."""

    def setUp(self):
        super().setUp()
        self.run_import()
        self.before = self.data("sessions.json")

    def refresh(self, old, new, allow=False):
        self.write_snapshot(renamed(sample(), old, new))
        args = types.SimpleNamespace(snapshot=self.snap, fetch=False, data_dir=self.dir, summary_out=None,
                                     snapshot_out=None, allow_withdrawal=allow)
        return ri.run(args)

    def test_should_refuse_a_refresh_whose_times_vanished(self):
        self.assertEqual(self.refresh("utcStartTime", "startUtc"), (3, False))

    def test_should_keep_last_good_times_when_they_vanish(self):
        self.refresh("utcStartTime", "startUtc")
        self.assertEqual(self.data("sessions.json"), self.before)

    def test_should_record_why_the_refresh_was_refused(self):
        self.refresh("utcStartTime", "startUtc")
        self.assertIn("sessions with dates fell", self.data("meta.json")["error"])

    def test_should_refuse_a_refresh_whose_rooms_vanished(self):
        self.assertEqual(self.refresh("room", "roomName"), (3, False))

    def test_should_accept_a_withdrawal_when_explicitly_allowed(self):
        self.refresh("utcStartTime", "startUtc", allow=True)
        self.assertEqual(self.data("sessions.json")["stats"]["withDates"], 0)

    def test_should_accept_a_withdrawal_flag_on_the_command_line(self):
        self.write_snapshot(renamed(sample(), "utcStartTime", "startUtc"))
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "import_reinvent.py"), self.snap,
                               "--data-dir", self.dir, "--allow-withdrawal"], capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)


KEYNOTE = {"code": "KEY001", "title": "CEO keynote", "start": "2026-12-01T16:00:00Z", "end": "2026-12-01T18:30:00Z",
           "room": "Venetian | Level 2 | Hall D", "speakers": [["A. Speaker", "AWS", "CEO"]]}


class KeynoteTests(unittest.TestCase):
    """Keynotes aren't in the AWS catalog; data/reinvent2026/keynotes.json adds them by hand."""

    def keynotes(self, entries):
        return by_code(ri.keynote_records({"keynotes": entries}))

    def test_should_add_a_hand_entered_keynote_as_a_keynote_session(self):
        self.assertEqual(self.keynotes([KEYNOTE])["KEY001"]["type"], "Keynote")

    def test_should_keep_the_keynote_time(self):
        self.assertEqual(self.keynotes([KEYNOTE])["KEY001"]["dur"], 150)

    def test_should_give_a_keynote_a_stable_id(self):
        self.assertEqual(self.keynotes([KEYNOTE])["KEY001"]["id"], "keynote-KEY001")

    def test_should_skip_a_keynote_without_a_valid_time(self):
        self.assertEqual(self.keynotes([dict(KEYNOTE, start="TBA")]), {})

    def test_should_keep_only_the_first_keynote_with_a_repeated_code(self):
        self.assertEqual(self.keynotes([KEYNOTE, dict(KEYNOTE, title="Copy")])["KEY001"]["title"], "CEO keynote")

    def test_should_add_nothing_for_the_empty_placeholder(self):
        self.assertEqual(ri.keynote_records({"keynotes": []}), [])

    def test_should_merge_keynotes_into_the_imported_catalog(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        with open(os.path.join(d, "keynotes.json"), "w", encoding="utf-8") as f:
            json.dump({"keynotes": [KEYNOTE]}, f)
        snap = os.path.join(d, "snap.json")
        with open(snap, "w", encoding="utf-8") as f:
            json.dump(SNAP, f)
        ri.run(types.SimpleNamespace(snapshot=snap, fetch=False, data_dir=d, summary_out=None, snapshot_out=None))
        self.assertIn("KEY001", by_code(load_path(os.path.join(d, "sessions.json"))["sessions"]))


def load_path(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


if __name__ == "__main__":
    unittest.main()
