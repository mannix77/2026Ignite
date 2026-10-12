"""Tests for scripts/prod_issue.py: one GitHub issue per production problem.
Spec: specs/features/production-issues.feature

    python3 -m unittest discover -s tests -v
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
import prod_issue as p  # noqa: E402

IGNITE = "Sync Ignite catalog & deploy"
REINVENT = "Sync re:Invent catalog"
RUN1 = "https://github.com/mannix77/2026Ignite/actions/runs/1"
RUN2 = "https://github.com/mannix77/2026Ignite/actions/runs/2"
REFUSED = "catalog returned 953 sessions (previously 1817); keeping last good data"
REFUSED_AGAIN = "catalog returned 951 sessions (previously 1817); keeping last good data"


class FakeGitHub:
    """Open issues by number, with what the script did to them."""

    def __init__(self):
        self.issues, self.comments, self.next = {}, [], 100

    def list_open(self, label):
        return [dict(i, number=n) for n, i in self.issues.items() if i["open"] and label in i["labels"]]

    def create(self, title, body, label):
        self.next += 1
        self.issues[self.next] = {"title": title, "body": body, "labels": [label], "open": True}
        return self.next

    def edit_body(self, number, body):
        self.issues[number]["body"] = body

    def comment(self, number, body):
        self.comments.append((number, body))

    def close(self, number):
        self.issues[number]["open"] = False

    def comments_on(self, number):
        return [body for n, body in self.comments if n == number]


def report(gh, workflow=IGNITE, kind="sync-refused", message=REFUSED, run=RUN1):
    return p.report_problem(gh, workflow, kind, "The catalog sync was refused", message, run, "2026-10-12T14:40Z")


class ReportProblemTests(unittest.TestCase):
    def test_should_open_a_production_issue_for_a_new_problem(self):
        gh = FakeGitHub()
        result = report(gh)
        (issue,) = gh.issues.values()
        self.assertEqual((result, issue["labels"], REFUSED in issue["body"], RUN1 in issue["body"]),
                         ("opened", ["production"], True, True))

    def test_should_update_the_issue_when_the_same_problem_repeats_with_other_counts(self):
        gh = FakeGitHub()
        report(gh)
        result = report(gh, message=REFUSED_AGAIN, run=RUN2)
        (issue,) = gh.issues.values()
        self.assertEqual((result, "**Occurrences:** 2" in issue["body"], RUN2 in issue["body"]), ("updated", True, True))

    def test_should_not_comment_on_a_repeat(self):
        gh = FakeGitHub()
        report(gh)
        report(gh, message=REFUSED_AGAIN, run=RUN2)
        self.assertEqual(gh.comments, [])

    def test_should_open_a_separate_issue_for_a_different_kind_of_problem(self):
        gh = FakeGitHub()
        report(gh)
        result = report(gh, kind="deploy-failed", message="Deploy to GitHub Pages failed")
        self.assertEqual((result, len(gh.list_open("production"))), ("opened", 2))

    def test_should_not_reuse_another_workflows_issue_for_the_same_message(self):
        gh = FakeGitHub()
        report(gh, workflow=REINVENT)
        result = report(gh, workflow=IGNITE)
        self.assertEqual((result, len(gh.list_open("production"))), ("opened", 2))


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub()
        report(self.gh, workflow=IGNITE)
        self.ignite = self.gh.next
        report(self.gh, workflow=REINVENT)
        self.reinvent = self.gh.next
        self.closed = p.resolve(self.gh, IGNITE, RUN2, "2026-10-12T16:00Z")

    def test_should_close_the_recovered_workflows_issue_with_a_link_to_the_run(self):
        comments = self.gh.comments_on(self.ignite)
        self.assertEqual((self.closed, self.gh.issues[self.ignite]["open"], len(comments), RUN2 in comments[0]), ([self.ignite], False, 1, True))

    def test_should_leave_the_other_workflows_issue_open(self):
        self.assertEqual((self.ignite != self.reinvent, self.gh.issues[self.reinvent]["open"]), (True, True))


class ProblemKeyTests(unittest.TestCase):
    def test_should_treat_messages_that_differ_only_in_numbers_as_one_problem(self):
        self.assertEqual(p.problem_key("sync-refused", REFUSED), p.problem_key("sync-refused", REFUSED_AGAIN))

    def test_should_tell_different_messages_apart(self):
        self.assertNotEqual(p.problem_key("sync-refused", REFUSED), p.problem_key("sync-refused", "4 of 62 catalog entries are malformed"))


class GitHubCliTests(unittest.TestCase):
    def test_should_call_the_github_cli_with_a_timeout(self):
        calls = []
        gh = p.GitHubCli("mannix77/2026Ignite", runner=lambda args, **kw: calls.append(kw) or "[]")
        gh.list_open("production")
        self.assertEqual(calls, [{"timeout": 60}])


if __name__ == "__main__":
    unittest.main()


ROOT = os.path.dirname(HERE)
STUB = '''import sys
args = sys.argv[1:]
with open(sys.argv[0] + ".calls", "a", encoding="utf-8") as f:
    msg = ""
    if "--message-file" in args:
        msg = open(args[args.index("--message-file") + 1], encoding="utf-8").read().strip()
    f.write(args[0] + " " + (args[args.index("--kind") + 1] if "--kind" in args else "-") + " | " + msg + "\\n")
print("opened" if args[0] == "report" else "closed nothing")
'''


def workflow_step(path, name):
    """The `run:` script of the named step, de-indented like YAML's block scalar."""
    lines = open(path, encoding="utf-8").read().split("\n")
    i = next(n for n, line in enumerate(lines) if line.strip() == "- name: " + name)
    i = next(n for n in range(i, len(lines)) if lines[n].strip() == "run: |")
    indent = len(lines[i + 1]) - len(lines[i + 1].lstrip())
    out = []
    for line in lines[i + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) < indent:
            break
        out.append(line[indent:])
    return "\n".join(out)


def kinds(calls):
    """'report sync-refused | message' -> 'report sync-refused'."""
    return [c.split(" |")[0] for c in calls]


class WorkflowWiringTests(unittest.TestCase):
    """Runs each workflow's real reporting step with a stub in place of prod_issue.py."""
    STEP = "Open, update or close the production issue"

    def run_step(self, workflow, **env):
        import shutil
        import subprocess
        import tempfile
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        os.makedirs(os.path.join(tmp, "scripts"))
        stub = os.path.join(tmp, "scripts", "prod_issue.py")
        with open(stub, "w", encoding="utf-8") as f:
            f.write(STUB)
        out = os.path.join(tmp, "out.txt")
        base = {"SYNC_JOB": "success", "SYNC": "success", "NOTIFY": "", "DEPLOY": "success", "ERROR": "",
                "WORKFLOW": "W", "RUN_URL": "https://example/run", "RUNNER_TEMP": tmp, "GITHUB_OUTPUT": out,
                "PATH": os.environ["PATH"]}
        base.update(env)
        script = workflow_step(os.path.join(ROOT, ".github", "workflows", workflow), self.STEP)
        subprocess.run(["bash", "-e", "-c", script], cwd=tmp, env=base, check=True, timeout=30, capture_output=True)
        calls = open(stub + ".calls", encoding="utf-8").read().strip().split("\n")
        return calls, open(out, encoding="utf-8").read().strip()

    def test_should_report_a_refused_ignite_sync_with_its_reason(self):
        calls, output = self.run_step("sync.yml", SYNC="failure", ERROR="catalog returned 953 sessions (previously 1817)")
        self.assertEqual((calls, output), (["report sync-refused | catalog returned 953 sessions (previously 1817) The site keeps the last good data."],
                                           "result=opened"))

    def test_should_report_a_failed_ignite_job_before_anything_else(self):
        calls, _ = self.run_step("sync.yml", SYNC_JOB="failure", SYNC="", DEPLOY="skipped")
        self.assertEqual(kinds(calls), ["report job-failed"])

    def test_should_report_a_failed_ignite_deploy(self):
        calls, _ = self.run_step("sync.yml", DEPLOY="failure")
        self.assertEqual(kinds(calls), ["report deploy-failed"])

    def test_should_close_ignite_issues_when_the_run_succeeds(self):
        calls, output = self.run_step("sync.yml")
        self.assertEqual((calls, output), (["resolve - |"], "result=closed nothing"))

    def test_should_report_a_refused_reinvent_sync_with_its_reason(self):
        calls, _ = self.run_step("reinvent-sync.yml", SYNC="failure", DEPLOY="skipped", ERROR="catalog returned 15 sessions")
        self.assertEqual(calls, ["report sync-refused | catalog returned 15 sessions The site keeps the last good data."])

    def test_should_close_reinvent_issues_when_the_run_succeeds(self):
        calls, _ = self.run_step("reinvent-sync.yml", DEPLOY="skipped")
        self.assertEqual(calls, ["resolve - |"])
