"""Tests for .github/workflows/sync.yml: the catalog sync must start from the latest main and
must not leave its checkout half-rebased when a push loses a race.

    python3 -m unittest tests.test_workflows -v
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "sync.yml")


def sync_job_text():
    text = open(WORKFLOW, encoding="utf-8").read()
    return text.split("\n  deploy:")[0]


def commit_step_script():
    """The shell of the 'Commit catalog changes' step, dedented."""
    m = re.search(r"- name: Commit catalog changes\n(?:\s+id:[^\n]*\n)?\s+run: \|\n((?:[ ]{10}.*\n|\n)+)", sync_job_text())
    assert m, "commit step not found"
    return "\n".join(line[10:] for line in m.group(1).splitlines())


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, timeout=30,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def git_out(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          timeout=30).stdout

class CheckoutTests(unittest.TestCase):
    def test_every_sync_job_checks_out_the_branch_not_the_trigger_commit(self):
        # A run that queued behind another would otherwise sync from a commit older than that
        # run's push, and its catalog commit would conflict on rebase.
        for name in ("sync.yml", "reinvent-sync.yml"):
            with self.subTest(workflow=name):
                text = open(os.path.join(ROOT, ".github", "workflows", name), encoding="utf-8").read()
                text = text.split("\n  deploy:")[0].split("\n  report:")[0]
                m = re.search(r"actions/checkout@\S+[^\n]*\n(?:\s+if:[^\n]*\n)?\s+with:\n(?:\s+#[^\n]*\n)*\s+ref: ([^\n]+)", text)
                self.assertIsNotNone(m, name + ": checkout must set ref")
                self.assertEqual(m.group(1), "${{ github.ref_name }}")


class RetryLoopTests(unittest.TestCase):
    def test_every_push_retry_loop_aborts_a_failed_rebase(self):
        # Covers the loops CommitStepTests does not execute (cleared summary, both re:Invent steps).
        expected = {"sync.yml": 2, "reinvent-sync.yml": 2}
        for name, count in expected.items():
            with self.subTest(workflow=name):
                lines = open(os.path.join(ROOT, ".github", "workflows", name), encoding="utf-8").read().splitlines()
                pulls = [i for i, l in enumerate(lines) if "git pull --rebase" in l]
                self.assertEqual(len(pulls), count)
                for i in pulls:
                    self.assertTrue(lines[i + 1].strip().startswith("git rebase --abort"), lines[i + 1])


class CommitStepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.remote = os.path.join(self.tmp, "remote.git")
        self.work = os.path.join(self.tmp, "work")
        self.other = os.path.join(self.tmp, "other")
        git(self.tmp, "init", "-q", "--bare", "-b", "main", self.remote)
        git(self.tmp, "clone", "-q", self.remote, self.work)
        d = os.path.join(self.work, "data", "ignite2026")
        os.makedirs(d)
        self.write(self.work, "sessions.json", "base\n")
        self.write(self.work, "changes.json", "base\n")
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "base")
        git(self.work, "push", "-q", "origin", "HEAD:main")
        git(self.tmp, "clone", "-q", self.remote, self.other)

    def write(self, repo, name, text):
        with open(os.path.join(repo, "data", "ignite2026", name), "w") as f:
            f.write(text)

    def remote_file(self, name):
        return git_out(self.remote, "show", "main:data/ignite2026/" + name)

    def run_step(self):
        shim = os.path.join(self.tmp, "bin")
        os.makedirs(shim, exist_ok=True)
        with open(os.path.join(shim, "sleep"), "w") as f:  # the real retry waits 10-30 s
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(shim, "sleep"), 0o755)
        return subprocess.run(["bash", "-e", "-c", commit_step_script()], cwd=self.work,
                              capture_output=True, text=True, timeout=60,
                              env={**os.environ, "PATH": shim + os.pathsep + os.environ["PATH"]})

    def test_a_new_catalog_commit_is_pushed(self):
        self.write(self.work, "sessions.json", "mine\n")
        r = self.run_step()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.remote_file("sessions.json"), "mine\n")

    def test_a_losing_conflict_fails_without_leaving_a_half_finished_rebase(self):
        self.write(self.other, "sessions.json", "theirs\n")
        git(self.other, "commit", "-q", "-am", "other run")
        git(self.other, "push", "-q", "origin", "HEAD:main")
        self.write(self.work, "sessions.json", "mine\n")
        r = self.run_step()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Could not push", r.stdout + r.stderr)
        # The retries must have aborted the rebase each time: with it left open, the later
        # attempts could only fail with "Pulling is not possible because you have unmerged files".
        self.assertNotIn("unmerged files", r.stderr)
        for state in ("rebase-merge", "rebase-apply"):
            self.assertFalse(os.path.isdir(os.path.join(self.work, ".git", state)), state)
        # abort (not quit) restores HEAD: the local catalog commit is still there to retry.
        self.assertTrue(git_out(self.work, "log", "-1", "--format=%s").startswith("Catalog update "))
        # And the other run's data on the remote ref is untouched.
        self.assertEqual(self.remote_file("sessions.json"), "theirs\n")


def active_lines(text):
    """The YAML lines that are in effect: comment-only lines dropped, so a commented-out mapping can't satisfy a test."""
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


def deploy_job_text():
    text = open(WORKFLOW, encoding="utf-8").read()
    return text.split("\n  deploy:")[1].split("\n  # One GitHub issue per production problem")[0]


def step_script(name, text=None):
    """The `run:` script of the named step in sync.yml, dedented."""
    text = text if text is not None else open(WORKFLOW, encoding="utf-8").read()
    m = re.search(r"- name: %s\n(?:\s+\S[^\n]*\n)*?\s+run: \|\n((?:[ ]{10}.*\n|\n)+)" % re.escape(name), text)
    assert m, name + " step not found"
    return "\n".join(line[10:] for line in m.group(1).splitlines())


class AcceptInputTests(unittest.TestCase):
    """The owner accepts a refused catalog from the GitHub app with one input, and the refusal's
    diagnosis travels to the production issue (specs/features/ignite-catalog-sync.feature,
    "A refused catalog can be accepted from a phone")."""

    def setUp(self):
        self.text = open(WORKFLOW, encoding="utf-8").read()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_the_workflow_offers_an_accept_choice(self):
        m = re.search(r"workflow_dispatch:\n\s+inputs:\n(?:\s+#.*\n)*\s+accept:\n((?:\s{8}.*\n)+)", self.text)
        self.assertIsNotNone(m, "workflow_dispatch needs an `accept` input")
        block = m.group(1)
        self.assertIn("type: choice", block)
        self.assertRegex(block, r"options: \[none, partial, withdrawal\]")
        self.assertIn("default: none", block)

    def run_sync_step(self, accept):
        """Runs the sync step's shell with a stub sync.py that records its arguments."""
        os.makedirs(os.path.join(self.tmp, "scripts"), exist_ok=True)
        stub = os.path.join(self.tmp, "scripts", "sync.py")
        with open(stub, "w", encoding="utf-8") as f:
            f.write("import sys\nopen(sys.argv[0] + '.args', 'w').write(' '.join(sys.argv[1:]))\n")
        env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": self.tmp}
        if accept is not None:
            env["ACCEPT"] = accept
        subprocess.run(["bash", "-e", "-c", step_script("Sync the catalog")], cwd=self.tmp, env=env, check=True, timeout=30, capture_output=True)
        return open(stub + ".args", encoding="utf-8").read()

    def test_the_sync_step_passes_accept_only_when_one_was_chosen(self):
        self.assertEqual(self.run_sync_step("partial"), "--summary-out %s/summary.md --refusal-out %s/refusal.md --accept partial" % (self.tmp, self.tmp))
        self.assertEqual(self.run_sync_step("withdrawal").endswith("--accept withdrawal"), True)
        for none in ("none", "", None):
            with self.subTest(accept=none):
                self.assertNotIn("--accept", self.run_sync_step(none))

    def test_the_sync_step_reads_the_choice_from_the_dispatch_input(self):
        m = re.search(r"- name: Sync the catalog\n(?:\s+\S[^\n]*\n)*?\s+env:\n\s+ACCEPT: \$\{\{ inputs.accept \}\}", self.text)
        self.assertIsNotNone(m, "the sync step must take ACCEPT from inputs.accept")

    def test_the_refusal_diagnosis_becomes_a_job_output_for_the_report(self):
        os.makedirs(os.path.join(self.tmp, "data", "ignite2026"))
        with open(os.path.join(self.tmp, "data", "ignite2026", "meta.json"), "w", encoding="utf-8") as f:
            f.write('{"error": "catalog returned 90 sessions (previously 200); keeping last good data"}')
        with open(os.path.join(self.tmp, "refusal.md"), "w", encoding="utf-8") as f:
            f.write("### Catalog refused: partial catalog\n- Sessions: 200 → 90\n")
        out = os.path.join(self.tmp, "out.txt")
        env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": self.tmp, "GITHUB_OUTPUT": out}
        subprocess.run(["bash", "-e", "-c", step_script("Read why the sync failed")], cwd=self.tmp, env=env, check=True, timeout=30, capture_output=True)
        text = open(out, encoding="utf-8").read()
        self.assertIn("error=catalog returned 90 sessions (previously 200); keeping last good data\n", text)
        self.assertRegex(text, r"details<<(\S+)\n### Catalog refused: partial catalog\n- Sessions: 200 → 90\n\n?\1\n")
        self.assertIn("details: ${{ steps.why.outputs.details }}", self.text)
        self.assertIn("DETAILS: ${{ needs.sync.outputs.details }}", self.text)

    def test_the_report_without_a_refusal_file_outputs_empty_details(self):
        os.makedirs(os.path.join(self.tmp, "data", "ignite2026"))
        with open(os.path.join(self.tmp, "data", "ignite2026", "meta.json"), "w", encoding="utf-8") as f:
            f.write('{"error": "boom"}')
        out = os.path.join(self.tmp, "out.txt")
        env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": self.tmp, "GITHUB_OUTPUT": out}
        subprocess.run(["bash", "-e", "-c", step_script("Read why the sync failed")], cwd=self.tmp, env=env, check=True, timeout=30, capture_output=True)
        text = open(out, encoding="utf-8").read()
        self.assertIn("error=boom\n", text)
        self.assertRegex(text, r"details<<(\S+)\n\n?\1\n")


class DeployRetryTests(unittest.TestCase):
    """A Pages API hiccup (HTTP 500 within ~3 s) is retried once after 60 s instead of failing the run."""

    def steps(self):
        body = deploy_job_text().split("\n    steps:\n")[1]
        body = active_lines(body)
        return [s.strip("\n") for s in re.split(r"\n(?=      - )", body.strip("\n"))]

    def test_failed_first_deploy_waits_60s_then_deploys_again(self):
        # Whole-line comparisons: a condition with something appended must not satisfy these.
        first, wait, retry = (s.splitlines() for s in self.steps())
        failed = "        if: steps.deployment.outcome == 'failure'"
        self.assertIn("      - id: deployment", first)
        self.assertIn("        continue-on-error: true", first)  # the retry decides whether the job fails
        # The first attempt must always run: a skipped first step is not a failure, so no retry would follow.
        self.assertFalse([l for l in first if l.strip().startswith("if:")])
        self.assertIn(failed, wait)
        self.assertIn("        run: sleep 60", wait)
        self.assertIn("      - id: deployment_retry", retry)
        self.assertIn(failed, retry)
        self.assertFalse([l for l in retry if l.strip().startswith("continue-on-error")])  # a second failure must fail the job
        # Both attempts use the same pinned action, so the retry can't drift from the first try.
        pin = re.compile(r"^        uses: actions/deploy-pages@([0-9a-f]{40}) # v[\d.]+$")
        pins = [[m.group(1) for m in map(pin.match, lines) if m] for lines in (first, retry)]
        self.assertEqual(len(pins[0]), 1)
        self.assertEqual(pins[0], pins[1])

    def test_the_environment_url_comes_from_whichever_attempt_deployed(self):
        environment = active_lines(deploy_job_text()).split("\n    environment:\n")[1].split("\n    steps:\n")[0]
        self.assertIn(
            "      url: ${{ steps.deployment.outputs.page_url || steps.deployment_retry.outputs.page_url }}",
            environment.splitlines())

    def test_the_report_job_still_sees_the_deploy_job_result(self):
        # A second failure fails the deploy job, which the report job turns into a production issue.
        # Scoped to the report job and the one step that files the issue, and to active lines only
        # (a commented-out mapping must not satisfy it).
        with open(WORKFLOW, encoding="utf-8") as f:
            report = active_lines(f.read().split("\n  report:\n")[1])
        head = report.split("\n    steps:\n")[0]
        self.assertIn("    needs: [sync, deploy]", head.splitlines())
        # Without this condition GitHub skips the report job when deploy fails, so no issue is filed.
        # The whole line is compared: appending e.g. "&& needs.deploy.result == 'success'" would
        # skip exactly the failed deploys.
        self.assertIn("    if: always() && needs.sync.result != 'cancelled'", head.splitlines())
        step = report.split("- name: Open, update or close the production issue\n")[1].split("\n      - name:")[0]
        env = step.split("        env:\n")[1].split("        run:")[0]
        self.assertIn("          DEPLOY: ${{ needs.deploy.result }}", env.splitlines())


if __name__ == "__main__":
    unittest.main()
