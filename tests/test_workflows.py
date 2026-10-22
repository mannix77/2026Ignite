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
    m = re.search(r"- name: Commit catalog changes\n\s+run: \|\n((?:[ ]{10}.*\n|\n)+)", sync_job_text())
    assert m, "commit step not found"
    return "\n".join(line[10:] for line in m.group(1).splitlines())


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, timeout=30,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


class CheckoutTests(unittest.TestCase):
    def test_sync_job_checks_out_the_branch_not_the_trigger_commit(self):
        # A run that queued behind another would otherwise sync from a commit older than that
        # run's push, and its catalog commit would conflict on rebase.
        m = re.search(r"actions/checkout@\S+[^\n]*\n\s+with:\n(?:\s+#[^\n]*\n)*\s+ref: ([^\n]+)", sync_job_text())
        self.assertIsNotNone(m, "the sync job's checkout must set ref")
        self.assertEqual(m.group(1), "${{ github.ref_name }}")


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
        git(self.other, "pull", "-q")
        self.assertEqual(open(os.path.join(self.other, "data", "ignite2026", "sessions.json")).read(), "mine\n")

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
        self.assertFalse(os.path.isdir(os.path.join(self.work, ".git", "rebase-merge")))
        # And the other run's data on the remote is untouched.
        git(self.other, "pull", "-q")
        self.assertEqual(open(os.path.join(self.other, "data", "ignite2026", "sessions.json")).read(), "theirs\n")


if __name__ == "__main__":
    unittest.main()
