"""The guide for AI assistants (llms.txt) is published with each copy of the site.

    python3 -m unittest tests.test_llms -v

specs/features/ai-assistant-guide.feature: "Gino's copy publishes a guide with Gino's address".
The deploy's "Publish copies for colleagues" step is run as written in the workflow, in a
scratch copy of the site, and the files it writes are checked.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "sync.yml")
SITE = "https://mannix77.github.io/2026Ignite/"
GINO = "https://mannix77.github.io/2026Ignite/gino/"


def workflow_step(name):
    """The shell script of the workflow step with this name (its `run: |` block, dedented)."""
    with open(WORKFLOW, encoding="utf-8") as f:
        lines = f.read().split("\n")
    at = next(i for i, l in enumerate(lines) if l.strip() == "- name: " + name)
    run = next(i for i in range(at + 1, len(lines)) if lines[i].strip() == "run: |")
    indent = len(lines[run]) - len(lines[run].lstrip()) + 2
    body = []
    for l in lines[run + 1:]:
        if l.strip() and len(l) - len(l.lstrip()) < indent:
            break
        body.append(l[indent:])
    return "\n".join(body)


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class PublishedGuideTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="llms-")
        site = cls.site = os.path.join(cls.tmp, "site")
        os.makedirs(os.path.join(site, "data", "ignite2026"))
        write(os.path.join(site, "data", "ignite2026", "sessions.json"), '{"sessions":[]}')
        for f in ("index.html", "manifest.webmanifest", "sw.js", "llms.txt"):
            shutil.copy(os.path.join(ROOT, f), site)
        for d in ("assets", "scripts"):
            shutil.copytree(os.path.join(ROOT, d), os.path.join(site, d))
        os.makedirs(os.path.join(site, "instances", "gino"))
        write(os.path.join(site, "instances", "gino", "conference"), "gartner2026\n")
        cls.published = subprocess.run(["bash", "-e", "-c", workflow_step("Publish copies for colleagues")],
                                       cwd=site, capture_output=True, text=True, timeout=60)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def read(self, path):
        with open(os.path.join(self.site, path), encoding="utf-8") as f:
            return f.read()

    def test_should_publish_the_copies_without_error(self):
        self.assertEqual((self.published.returncode, self.published.stderr), (0, ""))

    def test_should_give_links_under_ginos_copy_in_ginos_guide(self):
        guide = self.read("gino/llms.txt")
        self.assertEqual((GINO + "?conf=" in guide, guide.count(SITE), guide.count(GINO)),
                         (True, guide.count(GINO), self.read("llms.txt").count(SITE)))

    def test_should_keep_the_main_sites_links_in_the_main_sites_guide(self):
        guide = self.read("llms.txt")
        self.assertEqual((SITE + "?conf=" in guide, GINO in guide), (True, False))


class GuideCopyScriptTests(unittest.TestCase):
    """scripts/instance_llms.py, which the deploy calls for each copy."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="llms-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def copy(self, text, name):
        src, dest = os.path.join(self.tmp, "llms.txt"), os.path.join(self.tmp, "out.txt")
        write(src, text)
        res = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "instance_llms.py"), src, dest, name],
                             capture_output=True, text=True, timeout=30)
        if not os.path.exists(dest):
            return res.returncode, None
        with open(dest, encoding="utf-8") as f:
            return res.returncode, f.read()

    def test_should_rewrite_every_site_link_for_the_copy(self):
        self.assertEqual(self.copy(f"Open {SITE}?conf=x or {SITE}data/x.json\n", "gino"),
                         (0, f"Open {GINO}?conf=x or {GINO}data/x.json\n"))

    def test_should_refuse_a_guide_without_the_site_address(self):
        self.assertEqual(self.copy("Open https://example.org/\n", "gino"), (1, None))

    def test_should_refuse_a_copy_name_that_is_not_a_folder_name(self):
        self.assertEqual(self.copy(f"Open {SITE}\n", "../gino"), (1, None))


if __name__ == "__main__":
    unittest.main()
