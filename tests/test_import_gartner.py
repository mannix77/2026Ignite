"""Tests for scripts/import_gartner.py: one bad record in an export must not abort the import.

    python3 -m unittest discover -s tests -v
"""
import contextlib
import io
import os
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
