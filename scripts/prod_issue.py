#!/usr/bin/env python3
"""One GitHub issue per production problem in the scheduled workflows.

A failure the code can't fix by itself (a refused catalog, failing tests, a failed deploy)
opens an issue labelled `production`, so it can be dealt with later. The same problem
again updates that issue's "last seen / occurrences" lines (an edit, which sends no email)
instead of opening another. A successful run closes the workflow's open issues.

    prod_issue.py report  --workflow NAME --kind KIND --title T --message-file F --run-url U
    prod_issue.py resolve --workflow NAME --run-url U

`report` prints "opened" or "updated" (and writes result=… to $GITHUB_OUTPUT when set), so
the workflow can fail the run only the first time a problem appears.

Spec: specs/features/production-issues.feature
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys

LABEL = "production"
GH_TIMEOUT = 60  # seconds per GitHub CLI call


def problem_key(kind, message):
    """Same kind and wording means the same problem, even when the counts in it differ."""
    norm = re.sub(r"\d+", "#", " ".join(str(message).lower().split()))[:300]
    return "%s:%s" % (kind, hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12])


def marker(workflow, key):
    return '<!-- production-issue workflow="%s" key="%s" -->' % (workflow.replace('"', "'"), key)


def workflow_marker(workflow):
    return '<!-- production-issue workflow="%s" ' % workflow.replace('"', "'")


def body_for(workflow, kind, message, run_url, now, key):
    return "\n".join([
        marker(workflow, key),
        "**Workflow:** %s · **Problem:** `%s`" % (workflow, kind),
        "",
        "```",
        str(message).strip()[:4000],
        "```",
        "",
        "**First seen:** %s ([run](%s))" % (now, run_url),
        "**Last seen:** %s ([run](%s))" % (now, run_url),
        "**Occurrences:** 1",
        "",
        "Opened by the workflow. Repeats of this problem update the lines above; the issue "
        "closes itself when the workflow next succeeds.",
    ]) + "\n"


def report_problem(gh, workflow, kind, title, message, run_url, now):
    """Open an issue for a new problem, or update the open one for the same problem."""
    key = problem_key(kind, message)
    for issue in gh.list_open(LABEL):
        body = issue.get("body") or ""
        if marker(workflow, key) not in body:
            continue
        m = re.search(r"\*\*Occurrences:\*\* (\d+)", body)
        n = int(m.group(1)) + 1 if m else 2
        body = re.sub(r"\*\*Occurrences:\*\* \d+", "**Occurrences:** %d" % n, body)
        body = re.sub(r"\*\*Last seen:\*\* .*", lambda _: "**Last seen:** %s ([run](%s))" % (now, run_url), body)
        gh.edit_body(issue["number"], body)
        return "updated"
    gh.create("[%s] %s" % (workflow, title), body_for(workflow, kind, message, run_url, now, key), LABEL)
    return "opened"


def resolve(gh, workflow, run_url, now):
    """Close this workflow's open production issues; returns the numbers closed."""
    closed = []
    for issue in gh.list_open(LABEL):
        if workflow_marker(workflow) not in (issue.get("body") or ""):
            continue
        gh.comment(issue["number"], "Resolved: the workflow succeeded at %s ([run](%s))." % (now, run_url))
        gh.close(issue["number"])
        closed.append(issue["number"])
    return closed


class GitHubCli:
    """The `gh` command line, with a timeout on every call."""

    def __init__(self, repo, runner=None):
        self.repo = repo
        self.runner = runner or self._run

    @staticmethod
    def _run(args, timeout):
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout

    def gh(self, *args):
        return self.runner(["gh", *args, "-R", self.repo], timeout=GH_TIMEOUT)

    def list_open(self, label):
        out = self.gh("issue", "list", "--label", label, "--state", "open", "--limit", "100", "--json", "number,title,body")
        return json.loads(out or "[]")

    def create(self, title, body, label):
        try:
            self.gh("label", "create", label, "--color", "b60205", "--description", "A problem seen in a scheduled sync or deploy")
        except subprocess.CalledProcessError:
            pass  # already exists
        return self.gh("issue", "create", "--title", title, "--body", body, "--label", label)

    def edit_body(self, number, body):
        self.gh("issue", "edit", str(number), "--body", body)

    def comment(self, number, body):
        self.gh("issue", "comment", str(number), "--body", body)

    def close(self, number):
        self.gh("issue", "close", str(number))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("action", choices=["report", "resolve"])
    ap.add_argument("--workflow", required=True)
    ap.add_argument("--run-url", required=True)
    ap.add_argument("--kind", default="failed")
    ap.add_argument("--title", default="Workflow failed")
    ap.add_argument("--message", default="")
    ap.add_argument("--message-file")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", "mannix77/2026Ignite"))
    args = ap.parse_args(argv)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    gh = GitHubCli(args.repo)
    if args.action == "resolve":
        closed = resolve(gh, args.workflow, args.run_url, now)
        print("closed %s" % (", ".join("#%d" % n for n in closed) or "nothing"))
        return 0
    message = args.message
    if args.message_file and os.path.exists(args.message_file):
        with open(args.message_file, encoding="utf-8") as f:
            message = f.read() or message
    result = report_problem(gh, args.workflow, args.kind, args.title, message or "(no details)", args.run_url, now)
    print(result)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write("result=%s\n" % result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
