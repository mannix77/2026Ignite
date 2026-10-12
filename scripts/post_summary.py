#!/usr/bin/env python3
"""Queue and post catalog-change summaries to a tracking issue, after the catalog is pushed.

Used by the two sync workflows in this order (specs/features/change-notices.feature):

    stage   put this run's summary in the pending file          (before the catalog is committed)
    commit and push the catalog together with the pending file  (a failed push stops here: nothing posted)
    post    post every pending summary that isn't on the issue yet, then clear the file
    commit and push the cleared file

Every summary in the pending file is a chunk that starts with a marker line
`<!-- summary:ID -->`. The marker travels into the issue comment, so a summary that was posted
but whose clearing never reached the repo is recognised on the issue and not posted again; one
that failed to post stays in the file and is retried by the next run.

    python3 scripts/post_summary.py stage --pending FILE --new FILE --id ID
    python3 scripts/post_summary.py post --pending FILE --current ID --label L --color HEX \
        --description D --title T --issue-body B [--footer FILE]
"""
import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile

GH_TIMEOUT = 60
MARKER = re.compile(r"^<!-- summary:([A-Za-z0-9._-]+) -->[ \t]*$", re.M)


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def chunks(text):
    """[(id, body)] from a pending file. Text before the first marker (written before markers
    existed) is one chunk whose id comes from its content, so it is still posted once."""
    found = list(MARKER.finditer(text))
    out = []
    head = text[: found[0].start()] if found else text
    if head.strip():
        out.append(("legacy-" + hashlib.sha256(head.strip().encode()).hexdigest()[:12], head.strip()))
    for i, m in enumerate(found):
        end = found[i + 1].start() if i + 1 < len(found) else len(text)
        body = text[m.end():end].strip()
        if body:
            out.append((m.group(1), body))
    return out


def render(items):
    return "".join("<!-- summary:%s -->\n%s\n\n" % (cid, body) for cid, body in items)


def stage(pending, new, run_id):
    summary = read(new).strip()
    if not summary:
        return 0
    items = [c for c in chunks(read(pending)) if c[0] != run_id] + [(run_id, summary)]
    with open(pending, "w", encoding="utf-8") as f:
        f.write(render(items))
    return 0


def gh(*args):
    return subprocess.run(["gh", *args], capture_output=True, text=True, timeout=GH_TIMEOUT, check=False)


def find_or_create_issue(a):
    gh("label", "create", a.label, "--color", a.color, "--description", a.description)  # exists already: fine
    r = gh("issue", "list", "--label", a.label, "--state", "open", "--limit", "1",
           "--json", "number", "--jq", ".[0].number // empty")
    if r.returncode != 0:
        raise RuntimeError("could not list issues: " + r.stderr.strip())
    num = r.stdout.strip()
    if num:
        return num
    r = gh("issue", "create", "--label", a.label, "--title", a.title, "--body", a.issue_body)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError("could not create the tracking issue: " + r.stderr.strip())
    return r.stdout.strip().rstrip("/").rsplit("/", 1)[-1]


def comments_text(num):
    r = gh("api", "--paginate", "repos/{owner}/{repo}/issues/%s/comments" % num, "--jq", ".[].body")
    if r.returncode != 0:
        raise RuntimeError("could not read the issue's comments: " + r.stderr.strip())
    return r.stdout


def post(a):
    items = chunks(read(a.pending))
    if not items:
        if os.path.exists(a.pending):
            os.remove(a.pending)
        return 0
    footer = read(a.footer).strip() if a.footer else ""
    try:
        num = find_or_create_issue(a)
        posted = comments_text(num)
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        print("::error::" + str(e))
        return 1
    fd, tmp = tempfile.mkstemp(suffix=".md")  # not next to the pending file: that folder is committed
    os.close(fd)
    try:
        return post_all(a, items, num, posted, footer, tmp)
    finally:
        os.remove(tmp)


def post_all(a, items, num, posted, footer, tmp):
    for i, (cid, body) in enumerate(items):
        if "<!-- summary:%s -->" % cid not in posted:
            text = ("_Delayed summary from an earlier sync:_\n\n" if cid != a.current else "") + body
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("<!-- summary:%s -->\n%s\n%s" % (cid, text, ("\n" + footer + "\n") if footer else ""))
            try:
                r = gh("issue", "comment", num, "--body-file", tmp)
            except subprocess.TimeoutExpired:
                r = None
            if r is None or r.returncode != 0:
                print("::error::could not post summary %s: %s" % (cid, r.stderr.strip() if r else "timed out"))
                keep(a.pending, items[i:])
                return 1
        keep(a.pending, items[i + 1:])  # posted now or already on the issue: no longer pending
    return 0


def keep(pending, items):
    if items:
        with open(pending, "w", encoding="utf-8") as f:
            f.write(render(items))
    elif os.path.exists(pending):
        os.remove(pending)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stage")
    s.add_argument("--pending", required=True)
    s.add_argument("--new", required=True)
    s.add_argument("--id", required=True)
    p = sub.add_parser("post")
    p.add_argument("--pending", required=True)
    p.add_argument("--current", required=True, help="id of this run's summary; others are labelled delayed")
    p.add_argument("--label", required=True)
    p.add_argument("--color", required=True)
    p.add_argument("--description", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--issue-body", required=True)
    p.add_argument("--footer", help="file whose text is appended to every comment")
    a = ap.parse_args(argv)
    if a.cmd == "stage":
        return stage(a.pending, a.new, a.id)
    return post(a)


if __name__ == "__main__":
    sys.exit(main())
