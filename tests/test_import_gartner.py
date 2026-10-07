"""Tests for scripts/import_gartner.py: one bad record in an export must not abort the import.

    python3 -m unittest discover -s tests -v
"""
import contextlib
import datetime as dt
import io
import json
import operator
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
import import_gartner as g  # noqa: E402

OK = {"id": 1, "code": "T1", "t": "Talk", "s": "10/19/2026 10:00:00", "e": "10/19/2026 10:45:00",
      "loc": "Lark 1, WDW Swan Hotel", "f": {"Session Type": ["Track Sessions"]}}


def normalize(*extra):
    """normalize() with OK plus extra records, warnings swallowed; -> {code: record}."""
    with contextlib.redirect_stderr(io.StringIO()):
        out, _, _ = g.normalize([OK] + list(extra))
    return {r["code"]: r for r in out}


def warnings_for(*extra):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        g.normalize([OK] + list(extra))
    return err.getvalue()


class ImportRobustnessTests(unittest.TestCase):
    def test_should_keep_a_session_without_times_unscheduled(self):
        got = normalize(dict(OK, id=2, code="T2", s=None, e=None))
        self.assertEqual((got["T2"]["start"], got["T2"]["end"], got["T2"]["dur"]), (None, None, None))

    def test_should_keep_a_session_whose_end_key_is_missing(self):
        rec = dict(OK, id=3, code="T3")
        del rec["e"]
        self.assertEqual(normalize(rec)["T3"]["start"], "2026-10-19T14:00:00Z")

    def test_should_keep_a_session_with_unparseable_times_unscheduled(self):
        self.assertIsNone(normalize(dict(OK, id=7, code="T7", s="TBD", e="TBD"))["T7"]["start"])

    def test_should_treat_a_null_facet_as_empty(self):
        got = normalize(dict(OK, id=4, code="T4", f={"Tailored Programming": None, "Topic": None}))
        self.assertEqual((got["T4"]["audience"], got["T4"]["topics"]), ([], []))

    def test_should_never_give_a_negative_duration(self):
        self.assertIsNone(normalize(dict(OK, id=5, code="T5", e="10/19/2026 09:00:00"))["T5"]["dur"])

    def test_should_give_repeated_ids_distinct_instance_keys(self):
        got = normalize(dict(OK, code="T6"))
        self.assertNotEqual(got["T1"]["inst"], got["T6"]["inst"])

    def test_should_keep_instance_keys_when_repeated_ids_change_order(self):
        a, b = dict(OK, id=9, code="R1"), dict(OK, id=9, code="R2", t="Other talk")
        keys = lambda recs: {r["code"]: r["inst"] for r in g.normalize(recs)[0]}
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(keys([a, b]), keys([b, a]))

    def test_should_skip_a_malformed_speaker_entry(self):
        got = normalize(dict(OK, id=8, code="T8", sp=[7, ["Ann Lee", "Analyst", "Gartner"]]))
        self.assertEqual([p[0] for p in got["T8"]["speakers"]], ["Ann Lee"])

    def test_should_drop_an_exact_duplicate_record(self):
        with contextlib.redirect_stderr(io.StringIO()):
            out, _, _ = g.normalize([OK, dict(OK)])
        self.assertEqual(len(out), 1)

    def test_should_skip_a_null_record(self):
        self.assertEqual(sorted(normalize(None)), ["T1"])

    def test_should_report_how_many_records_needed_repair(self):
        self.assertIn("2 record(s)", warnings_for(dict(OK, id=2, code="T2", s=None, e=None),
                                                  dict(OK, id=5, code="T5", e="10/19/2026 09:00:00")))

    def test_should_stay_quiet_for_a_clean_export(self):
        self.assertEqual(warnings_for(), "")


def rec(code, title="Talk", **facets):
    return dict(OK, id=code, code=code, t=title, f=dict({"Session Type": ["Track Sessions"]}, **facets))


class PrivacyTests(unittest.TestCase):
    """The Gartner catalog is published on a public site: private meetings and personal notes stay out."""

    def test_should_leave_a_strategic_account_meeting_out_of_the_catalog(self):
        self.assertNotIn("SM101", normalize(rec("SM101")))

    def test_should_leave_a_sam_meeting_out_of_the_catalog(self):
        self.assertNotIn("SAM12", normalize(rec("SAM12")))

    def test_should_keep_a_public_session_whose_code_starts_with_sm(self):
        self.assertIn("SMB10", normalize(rec("SMB10")))

    def test_should_leave_a_cio_circle_session_out_by_its_audience(self):
        self.assertNotIn("CC1", normalize(rec("CC1", **{"Tailored Programming": ["CIO Circle Program"]})))

    def test_should_leave_a_cio_circle_session_out_by_its_title(self):
        self.assertNotIn("CC2", normalize(rec("CC2", title="CIO Circle Breakfast")))

    def test_should_publish_only_public_sessions_in_the_catalog_file(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        export = os.path.join(tmp, "export.json")
        with open(export, "w", encoding="utf-8") as f:
            json.dump([OK, rec("SM101"), rec("CC1", title="CIO Circle Breakfast")], f)
        subprocess.run([sys.executable, os.path.join(os.path.dirname(HERE), "scripts", "import_gartner.py"), export,
                        "--data-dir", tmp], check=True, capture_output=True, timeout=120)
        with open(os.path.join(tmp, "sessions.json"), encoding="utf-8") as f:
            self.assertEqual(list(map(operator.itemgetter("code"), json.load(f)["sessions"])), ["T1"])

    def test_should_report_excluded_program_sessions(self):
        with contextlib.redirect_stderr(io.StringIO()):
            _, _, excluded = g.normalize([OK, rec("CC1", title="CIO Circle Breakfast")])
        self.assertEqual(excluded, ["CC1"])


class FavoritesTests(unittest.TestCase):
    """favorites.json is committed to the repo; the backup with notes stays on the laptop."""

    ROW = {"Session Code": "T1", "Rank": 3, "Score": "8.5", "Attend Mode": "Must", "Plan": "Attend",
           "My Notes": "ask about our renewal", "Why it matters": "budget cycle",
           "Vendor-consolidation angle": "reduce duplicate spend"}

    def written(self):
        """Runs write_favorites with the workbook row; -> (committed file, local backup file)."""
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        with contextlib.redirect_stderr(io.StringIO()):
            sessions, _, _ = g.normalize([OK])
        args = types.SimpleNamespace(workbook="unused.xlsx", favorites_out=None, data_dir=os.path.join(tmp, "repo"),
                                     backup_dir=os.path.join(tmp, "laptop"))
        with mock.patch.object(g, "read_sheet", return_value=[self.ROW]), contextlib.redirect_stdout(io.StringIO()):
            g.write_favorites(args, sessions, dt.datetime(2026, 10, 7, tzinfo=dt.timezone.utc))
        files = []
        for path in (os.path.join(tmp, "repo", "favorites.json"), os.path.join(tmp, "laptop", "gartner-2026-picks.json")):
            with open(path, encoding="utf-8") as f:
                files.append(json.load(f))
        return files

    def test_should_commit_favorites_without_personal_notes(self):
        committed, _ = self.written()
        self.assertEqual(next(iter(committed["picks"].values()))["note"], "")

    def test_should_keep_personal_notes_in_the_local_backup(self):
        _, backup = self.written()
        note = next(iter(backup["picks"].values()))["note"]
        self.assertEqual(note.split("\n")[1:], ["Note: ask about our renewal", "Why it matters: budget cycle",
                                                "Vendor-consolidation angle: reduce duplicate spend"])


if __name__ == "__main__":
    unittest.main()
