"""The AI guide's example codes stay valid (specs/features/ai-guide-examples.feature):
scripts/check_llms.py reads every import link in llms.txt and looks its codes up in the
conference's catalog; a stale example is reported through the production-issue script
without ever failing the run.

    python3 -m unittest tests.test_llms_examples -v
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import check_llms  # noqa: E402

GUIDE = """# Guide
A link: https://mannix77.github.io/2026Ignite/?conf=reinvent2026#/import/AIM314-R.3!AIM314-R1~AIM326-R.2s87.5~BIZ333-R.1w~CMP323-R.0
Another: https://mannix77.github.io/2026Ignite/?conf=ignite2026#/import/BRK101.3~LAB654.2*LAB654
Not a conference we have: https://mannix77.github.io/2026Ignite/?conf=gartner2026#/import/CNC17.3
"""


class ParseTests(unittest.TestCase):
    def test_should_read_every_code_in_every_link_including_locked_runs(self):
        self.assertEqual(check_llms.example_links(GUIDE), [
            ("reinvent2026", ["AIM314-R", "AIM314-R1", "AIM326-R", "BIZ333-R", "CMP323-R"]),
            ("ignite2026", ["BRK101", "LAB654", "LAB654"]),
            ("gartner2026", ["CNC17"]),
        ])

    def test_should_read_nothing_from_text_without_links(self):
        self.assertEqual(check_llms.example_links("no links here\n#/import/ alone is not a link"), [])


class CheckTests(unittest.TestCase):
    CATALOGS = {"reinvent2026": {"AIM314-R", "AIM314-R1", "AIM326-R", "BIZ333-R", "CMP323-R"},
                "ignite2026": {"BRK101", "LAB654"}, "gartner2026": None}

    def test_should_find_every_example_in_its_catalog(self):
        r = check_llms.check(GUIDE, self.CATALOGS)
        self.assertEqual((r["stale"], r["unverifiable"], r["checked"]), ([], ["gartner2026"], 8))

    def test_should_name_a_code_the_catalog_no_longer_lists_with_its_conference(self):
        cats = dict(self.CATALOGS, reinvent2026=self.CATALOGS["reinvent2026"] - {"BIZ333-R"})
        r = check_llms.check(GUIDE, cats)
        self.assertEqual(r["stale"], [("reinvent2026", "BIZ333-R")])
        self.assertIn("reinvent2026: `BIZ333-R` is no longer in the catalog", check_llms.problem_text(r))

    def test_should_report_a_missing_catalog_as_unverifiable_not_stale(self):
        r = check_llms.check(GUIDE, {"reinvent2026": None, "ignite2026": None, "gartner2026": None})
        self.assertEqual((r["stale"], sorted(r["unverifiable"])), ([], ["gartner2026", "ignite2026", "reinvent2026"]))


class CatalogTests(unittest.TestCase):
    def test_should_load_the_codes_of_a_catalog_and_none_for_a_missing_one(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        os.makedirs(os.path.join(tmp, "reinvent2026"))
        with open(os.path.join(tmp, "reinvent2026", "sessions.json"), "w", encoding="utf-8") as f:
            json.dump({"sessions": [{"code": "A1"}, {"code": "B2"}, {"id": "no-code"}]}, f)
        self.assertEqual(check_llms.load_catalog(tmp, "reinvent2026"), {"A1", "B2"})
        self.assertIsNone(check_llms.load_catalog(tmp, "gartner2026"))

    def test_should_treat_an_unreadable_catalog_as_unverifiable(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        for conf, text in (("truncated", '{"sessions": [{"code": "A1"'), ("a-list", '[{"code": "A1"}]'), ("no-list", '{"sessions": "A1"}'), ("ok", '{"sessions": [{"code": "A1"}]}')):
            os.makedirs(os.path.join(tmp, conf))
            with open(os.path.join(tmp, conf, "sessions.json"), "w", encoding="utf-8") as f:
                f.write(text)
        self.assertEqual([check_llms.load_catalog(tmp, c) for c in ("truncated", "a-list", "no-list", "ok")], [None, None, None, {"A1"}])
        guide = "https://x/?conf=truncated#/import/A1.3 and https://x/?conf=ok#/import/A1.3"
        r = check_llms.check(guide, {c: check_llms.load_catalog(tmp, c) for c in ("truncated", "ok")})
        self.assertEqual((r["stale"], r["unverifiable"], r["checked"]), ([], ["truncated"], 1))


class LiveGuideTests(unittest.TestCase):
    """The committed guide against the committed catalogs: a stale example fails this test."""

    def test_the_committed_examples_are_all_in_their_catalogs(self):
        with open(os.path.join(ROOT, "llms.txt"), encoding="utf-8") as f:
            text = f.read()
        links = check_llms.example_links(text)
        self.assertTrue(links, "the guide has a worked example")
        cats = {conf: check_llms.load_catalog(os.path.join(ROOT, "data"), conf) for conf, _ in links}
        r = check_llms.check(text, cats)
        self.assertEqual(r["stale"], [])


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        os.makedirs(os.path.join(self.tmp, "data", "reinvent2026"))
        with open(os.path.join(self.tmp, "data", "reinvent2026", "sessions.json"), "w", encoding="utf-8") as f:
            json.dump({"sessions": [{"code": "AIM314-R"}, {"code": "AIM314-R1"}, {"code": "AIM326-R"}, {"code": "CMP323-R"}]}, f)
        with open(os.path.join(self.tmp, "llms.txt"), "w", encoding="utf-8") as f:
            f.write(GUIDE.split("Another:")[0])

    def run_check(self):
        out = os.path.join(self.tmp, "out.txt")
        env = dict(os.environ, GITHUB_OUTPUT=out)
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "check_llms.py"), "--guide", os.path.join(self.tmp, "llms.txt"),
                               "--data", os.path.join(self.tmp, "data"), "--problem-out", os.path.join(self.tmp, "problem.md"),
                               "--verified-out", os.path.join(self.tmp, "verified")],
                              capture_output=True, text=True, timeout=60, env=env)
        outputs = open(out, encoding="utf-8").read() if os.path.exists(out) else ""
        problem = open(os.path.join(self.tmp, "problem.md"), encoding="utf-8").read() if os.path.exists(os.path.join(self.tmp, "problem.md")) else None
        self.verified = os.path.exists(os.path.join(self.tmp, "verified"))
        return proc, outputs, problem

    def test_should_exit_zero_and_write_the_problem_when_an_example_is_stale(self):
        proc, outputs, problem = self.run_check()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("stale=true", outputs)
        self.assertIn("reinvent2026: `BIZ333-R` is no longer in the catalog", problem)
        self.assertIn("BIZ333-R", proc.stdout)
        self.assertFalse(self.verified, "a stale example is not verified")

    def test_should_name_an_unreadable_catalog_next_to_a_stale_code(self):
        os.makedirs(os.path.join(self.tmp, "data", "ignite2026"))
        with open(os.path.join(self.tmp, "data", "ignite2026", "sessions.json"), "w", encoding="utf-8") as f:
            f.write('{"sessions": [{"code": "BRK1')
        with open(os.path.join(self.tmp, "llms.txt"), "a", encoding="utf-8") as f:
            f.write("https://x/?conf=ignite2026#/import/BRK101.3\n")
        proc, outputs, problem = self.run_check()
        self.assertEqual((proc.returncode, "stale=true" in outputs, self.verified), (0, True, False), proc.stderr)
        self.assertIn("reinvent2026: `BIZ333-R` is no longer in the catalog", problem)
        self.assertIn("Could not check ignite2026 (catalog missing or unreadable)", problem)
        self.assertIn("BIZ333-R", proc.stdout)
        self.assertIn("could not check ignite2026", proc.stdout)

    def test_should_exit_zero_and_write_no_problem_when_every_example_is_current(self):
        with open(os.path.join(self.tmp, "data", "reinvent2026", "sessions.json"), "w", encoding="utf-8") as f:
            json.dump({"sessions": [{"code": c} for c in ("AIM314-R", "AIM314-R1", "AIM326-R", "BIZ333-R", "CMP323-R")]}, f)
        proc, outputs, problem = self.run_check()
        self.assertEqual((proc.returncode, "stale=false" in outputs, problem, self.verified), (0, True, None, True))


class WorkflowTests(unittest.TestCase):
    """The sync runs the check after the catalog sync, reports through prod_issue.py under its
    own workflow name, and never fails the run for it."""

    def setUp(self):
        with open(os.path.join(ROOT, ".github", "workflows", "sync.yml"), encoding="utf-8") as f:
            self.text = f.read()

    def step(self):
        m = re.search(r"- name: Check the AI guide's example codes\n((?:\s{8}.*\n)+)", self.text)
        self.assertIsNotNone(m, "the sync job needs the check step")
        return m.group(1)

    def test_the_check_runs_after_the_sync_and_never_fails_the_job(self):
        body = self.step()
        self.assertIn("continue-on-error: true", body)
        self.assertIn("python3 scripts/check_llms.py", body)
        self.assertLess(self.text.index("- name: Sync the catalog"), self.text.index("- name: Check the AI guide's example codes"))
        self.assertLess(self.text.index("- name: Check the AI guide's example codes"), self.text.index("- name: Commit catalog changes"))

    def test_a_stale_example_opens_its_own_issue_and_a_fixed_one_closes_it(self):
        body = self.step()
        self.assertIn('--workflow "AI guide examples"', body)
        self.assertIn("--kind stale-example", body)
        self.assertIsNotNone(re.search(r"prod_issue\.py report.*?--message-file", body, re.S), "the problem text reaches the issue")
        self.assertIn("prod_issue.py resolve", body)
        self.assertNotIn("exit 1", body, "the guide never holds up the deploy")


class StepRunTests(unittest.TestCase):
    """Runs the workflow step's own script, with prod_issue.py replaced by a stub that logs what
    it was asked to do: an open issue is closed only when every example could be checked."""

    def setUp(self):
        with open(os.path.join(ROOT, ".github", "workflows", "sync.yml"), encoding="utf-8") as f:
            text = f.read()
        m = re.search(r"- name: Check the AI guide's example codes\n(?:\s{8}.*\n)*?\s{8}run: \|\n((?:\s{10}.*\n|\n)+)", text)
        self.assertIsNotNone(m, "the sync job needs the check step")
        self.script = "\n".join(line[10:] for line in m.group(1).splitlines()) + "\n"
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        os.makedirs(os.path.join(self.tmp, "scripts"))
        shutil.copy(os.path.join(ROOT, "scripts", "check_llms.py"), os.path.join(self.tmp, "scripts"))
        with open(os.path.join(self.tmp, "scripts", "prod_issue.py"), "w", encoding="utf-8") as f:
            f.write("import shutil, sys\n"
                    "open('issue-calls.log', 'a').write(sys.argv[1] + '\\n')\n"
                    "if '--message-file' in sys.argv:\n"
                    "    shutil.copy(sys.argv[sys.argv.index('--message-file') + 1], 'issue-message.md')\n")
        os.makedirs(os.path.join(self.tmp, "data", "reinvent2026"))
        with open(os.path.join(self.tmp, "llms.txt"), "w", encoding="utf-8") as f:
            f.write("https://x/?conf=reinvent2026#/import/AIM314-R.3\n")
        os.makedirs(os.path.join(self.tmp, "runner"))

    def run_step(self, catalog_text):
        with open(os.path.join(self.tmp, "data", "reinvent2026", "sessions.json"), "w", encoding="utf-8") as f:
            f.write(catalog_text)
        env = dict(os.environ, RUNNER_TEMP=os.path.join(self.tmp, "runner"), RUN_URL="https://run", GH_TOKEN="")
        env.pop("GITHUB_OUTPUT", None)
        proc = subprocess.run(["bash", "-e", "-c", self.script], cwd=self.tmp, capture_output=True, text=True, timeout=60, env=env)
        log = os.path.join(self.tmp, "issue-calls.log")
        calls = open(log, encoding="utf-8").read().split() if os.path.exists(log) else []
        return proc, calls

    def test_should_close_the_issue_when_every_example_is_found(self):
        proc, calls = self.run_step('{"sessions": [{"code": "AIM314-R"}]}')
        self.assertEqual((proc.returncode, calls), (0, ["resolve"]), proc.stderr)

    def test_should_report_when_an_example_is_missing(self):
        proc, calls = self.run_step('{"sessions": [{"code": "OTHER"}]}')
        self.assertEqual((proc.returncode, calls), (0, ["report"]), proc.stderr)
        with open(os.path.join(self.tmp, "issue-message.md"), encoding="utf-8") as f:
            self.assertIn("reinvent2026: `AIM314-R` is no longer in the catalog", f.read())

    def test_should_leave_the_issue_open_when_the_catalog_cannot_be_read(self):
        proc, calls = self.run_step('{"sessions": [{"code": "AIM3')
        self.assertEqual((proc.returncode, calls), (0, []), proc.stderr)
        self.assertIn("could not check reinvent2026", proc.stdout)


if __name__ == "__main__":
    unittest.main()
