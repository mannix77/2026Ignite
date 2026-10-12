"""scripts/post_summary.py: change summaries are posted after the push, once each.
Spec: specs/features/change-notices.feature. `gh` is a fake on PATH that keeps its issue and
comments in a JSON file, so every check is on what ends up on the "issue" and in the file."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "post_summary.py")

FAKE_GH = '''#!%(py)s
import json, os, sys
st_path = os.environ["FAKE_GH_STATE"]
st = json.load(open(st_path))
a = sys.argv[1:]
def save(): json.dump(st, open(st_path, "w"))
if a[:2] == ["label", "create"]:
    st["labels"].append(a[2]); save(); sys.exit(0)
if a[:2] == ["issue", "list"]:
    print(st["issue"] or ""); sys.exit(0)
if a[:2] == ["issue", "create"]:
    st["issue"] = "7"; st["created"] = {"label": a[a.index("--label") + 1], "title": a[a.index("--title") + 1]}; save()
    print("https://github.com/o/r/issues/7"); sys.exit(0)
if a[:2] == ["issue", "comment"]:
    if st["fail_comments"] > 0 or len(st["comments"]) >= st.get("fail_at_count", 10**9):
        st["fail_comments"] = max(0, st["fail_comments"] - 1); save(); sys.stderr.write("HTTP 502\\n"); sys.exit(1)
    st["comments"].append(open(a[a.index("--body-file") + 1]).read()); save(); sys.exit(0)
if a[:1] == ["api"]:
    print("\\n".join(st["comments"])); sys.exit(0 if not st.get("fail_api") else 1)
sys.exit(2)
'''


class PostSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = self.tmp.name
        self.bin = os.path.join(d, "bin")
        os.mkdir(self.bin)
        gh = os.path.join(self.bin, "gh")
        with open(gh, "w") as f:
            f.write(FAKE_GH % {"py": sys.executable})
        os.chmod(gh, 0o755)
        self.state = os.path.join(d, "state.json")
        self.pending = os.path.join(d, "pending-summary.md")
        self.new = os.path.join(d, "summary.md")
        self.set_state(issue=None, comments=[], fail_comments=0, labels=[])

    def set_state(self, **kw):
        cur = self.load_state() if os.path.exists(self.state) else {}
        cur.update(kw)
        with open(self.state, "w") as f:
            json.dump(cur, f)

    def load_state(self):
        with open(self.state) as f:
            return json.load(f)

    def comments(self):
        return self.load_state()["comments"]

    def run_cmd(self, *args):
        env = {**os.environ, "PATH": self.bin + os.pathsep + os.environ["PATH"], "FAKE_GH_STATE": self.state}
        return subprocess.run([sys.executable, "-I", SCRIPT, *args], env=env, capture_output=True, text=True, timeout=60)

    def stage(self, text, run_id):
        with open(self.new, "w") as f:
            f.write(text)
        return self.run_cmd("stage", "--pending", self.pending, "--new", self.new, "--id", run_id)

    def post(self, current, footer=None):
        args = ["post", "--pending", self.pending, "--current", current, "--label", "ignite-changes", "--color", "0f766e",
                "--description", "Ignite catalog change log", "--title", "Ignite 2026 catalog changes", "--issue-body", "tracking"]
        if footer:
            args += ["--footer", footer]
        return self.run_cmd(*args)

    def pending_text(self):
        if not os.path.exists(self.pending):
            return None
        with open(self.pending) as f:
            return f.read()

    # ---- stage
    def test_stage_keeps_an_earlier_pending_summary_and_adds_this_runs(self):
        self.assertEqual(self.stage("Added 1", "run-1").returncode, 0)
        self.assertEqual(self.stage("Added 2", "run-2").returncode, 0)
        self.assertEqual(self.pending_text(), "<!-- summary:run-1 -->\nAdded 1\n\n<!-- summary:run-2 -->\nAdded 2\n\n")

    def test_stage_with_an_empty_summary_changes_nothing(self):
        self.stage("Added 1", "run-1")
        before = self.pending_text()
        self.assertEqual(self.stage("  \n", "run-2").returncode, 0)
        self.assertEqual(self.pending_text(), before)
        os.remove(self.pending)
        self.assertEqual(self.stage("", "run-3").returncode, 0)
        self.assertIsNone(self.pending_text())  # no file made for nothing

    def test_staging_the_same_run_twice_keeps_one_copy(self):
        self.stage("Added 1", "run-1")
        self.stage("Added 1 again", "run-1")
        self.assertEqual(self.pending_text(), "<!-- summary:run-1 -->\nAdded 1 again\n\n")

    # ---- post
    def test_posts_the_summary_once_with_its_marker_and_clears_the_file(self):
        self.stage("Added 1 · removed 0", "run-1")
        r = self.post("run-1")
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertEqual(self.comments(), ["<!-- summary:run-1 -->\nAdded 1 · removed 0\n"])
        self.assertIsNone(self.pending_text())

    def test_creates_the_tracking_issue_when_none_is_open(self):
        self.stage("Added 1", "run-1")
        self.post("run-1")
        st = self.load_state()
        self.assertEqual(st["created"], {"label": "ignite-changes", "title": "Ignite 2026 catalog changes"})
        self.assertEqual(len(st["comments"]), 1)

    def test_a_failed_post_leaves_the_summary_pending_and_the_next_run_posts_it_once(self):
        self.stage("Added 1", "run-1")
        before = self.pending_text()
        self.set_state(fail_comments=1)
        r = self.post("run-1")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.comments(), [])
        self.assertEqual(self.pending_text(), before)
        # next run: nothing new to say, the old summary goes out once, labelled as delayed
        r = self.post("run-2")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.comments(), ["<!-- summary:run-1 -->\n_Delayed summary from an earlier sync:_\n\nAdded 1\n"])
        self.assertIsNone(self.pending_text())
        self.post("run-3")
        self.assertEqual(len(self.comments()), 1)

    def test_a_summary_already_on_the_issue_is_not_posted_again_and_is_cleared(self):
        self.stage("Added 1", "run-1")
        first = self.post("run-1")
        self.assertEqual((first.returncode, len(self.comments())), (0, 1))
        self.stage("Added 1", "run-1")            # the clearing never reached the repo: run-1's text is back
        self.assertIsNotNone(self.pending_text())
        r = self.post("run-2")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.comments()), 1)
        self.assertIsNone(self.pending_text())

    def test_when_the_second_of_two_pending_summaries_fails_only_it_stays(self):
        self.stage("Added 1", "run-1")
        self.stage("Added 2", "run-2")
        self.set_state(fail_at_count=1)           # one comment goes through, the next fails
        r = self.post("run-2")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(len(self.comments()), 1)
        self.assertIn("Added 1", self.comments()[0])
        self.assertEqual(self.pending_text(), "<!-- summary:run-2 -->\nAdded 2\n\n")
        self.set_state(fail_at_count=10**9)
        r = self.post("run-3")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([("Added 1" in c, "Added 2" in c) for c in self.comments()], [(True, False), (False, True)])
        self.assertIsNone(self.pending_text())

    def test_a_summary_written_before_markers_existed_is_posted_once(self):
        with open(self.pending, "w") as f:
            f.write("Added 3 · removed 0\n")
        self.assertEqual(self.post("run-9").returncode, 0)
        self.assertEqual(len(self.comments()), 1)
        self.assertIn("Added 3 · removed 0", self.comments()[0])
        self.assertIn("_Delayed summary", self.comments()[0])
        self.assertIsNone(self.pending_text())

    def test_a_failure_to_read_the_issue_posts_nothing_and_keeps_the_summary(self):
        self.stage("Added 1", "run-1")
        before = self.pending_text()
        self.set_state(fail_api=True)
        self.assertNotEqual(self.post("run-1").returncode, 0)
        self.assertEqual(self.comments(), [])
        self.assertEqual(self.pending_text(), before)

    def test_the_footer_is_added_to_every_comment(self):
        footer = os.path.join(self.tmp.name, "footer.md")
        with open(footer, "w") as f:
            f.write("_Full history: [changelog.md](https://example.test/changelog.md)_\n")
        self.stage("Added 1", "run-1")
        self.assertEqual(self.post("run-1", footer=footer).returncode, 0)
        self.assertEqual(self.comments(), ["<!-- summary:run-1 -->\nAdded 1\n\n_Full history: [changelog.md](https://example.test/changelog.md)_\n"])

    def test_nothing_pending_posts_nothing(self):
        self.assertEqual(self.post("run-1").returncode, 0)
        self.assertEqual(self.comments(), [])
        self.assertIsNone(self.load_state()["issue"])


if __name__ == "__main__":
    unittest.main()
