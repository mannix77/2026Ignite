#!/usr/bin/env python3
"""Are the AI guide's example session codes still in their catalogs?

The guide (llms.txt) shows worked import links with real codes; catalogs change with every
sync, so a code can vanish and an assistant would copy an example that no longer imports
cleanly. This reads every import link in the guide, looks each code up in the catalog of the
conference the link names, and reports the stale ones. It never fails: the workflow turns a
stale example into a production issue under its own workflow name, and the deploy goes ahead.

    check_llms.py --guide llms.txt --data data [--problem-out FILE]

Prints one line; writes stale=true|false to $GITHUB_OUTPUT when set; writes the problem text
to --problem-out only when something is stale. Spec: specs/features/ai-guide-examples.feature
"""
import argparse
import json
import os
import re
import sys

LINK = re.compile(r"[?&]conf=([a-z0-9]+)#/import/([^\s)\"'<>]+)")
# A token's code and, after ! or *, the locked run's code (the same grammar as store.js TOKEN).
TOKEN = re.compile(r"^([A-Za-z0-9_-]+)\.\d(?:s[\d.]+)?w?(?:[!*]([A-Za-z0-9_-]+))?$")


def example_links(text):
    """[(conference id, [codes in the link, in order, repeats kept])] for every import link."""
    out = []
    for conf, tokens in LINK.findall(text or ""):
        codes = []
        for tok in tokens.split("~"):
            m = TOKEN.match(tok)
            if not m:
                continue
            codes.append(m.group(1))
            if m.group(2):
                codes.append(m.group(2))
        out.append((conf, codes))
    return out


def load_catalog(data_dir, conf):
    """The set of session codes in data/<conf>/sessions.json, or None when there is no catalog."""
    path = os.path.join(data_dir, conf, "sessions.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    return {r["code"] for r in doc.get("sessions", []) if isinstance(r, dict) and isinstance(r.get("code"), str)}


def check(text, catalogs):
    """{stale: [(conf, code)], unverifiable: [conf], checked: n}; catalogs: conf -> set | None."""
    stale, unverifiable, checked = [], [], 0
    for conf, codes in example_links(text):
        cat = catalogs.get(conf)
        if cat is None:
            if conf not in unverifiable:
                unverifiable.append(conf)
            continue
        for code in codes:
            checked += 1
            if code not in cat and (conf, code) not in stale:
                stale.append((conf, code))
    return {"stale": stale, "unverifiable": unverifiable, "checked": checked}


def problem_text(result):
    lines = ["The AI guide (llms.txt) uses example session codes the catalog no longer lists:"]
    lines += ["- %s: `%s` is no longer in the catalog" % (conf, code) for conf, code in result["stale"]]
    lines.append("Pick a current code for the worked example (the import still works; assistants would copy a code that imports nothing).")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--guide", default="llms.txt")
    ap.add_argument("--data", default="data")
    ap.add_argument("--problem-out", help="write the problem text here when an example is stale")
    args = ap.parse_args(argv)
    with open(args.guide, encoding="utf-8") as f:
        text = f.read()
    links = example_links(text)
    catalogs = {conf: load_catalog(args.data, conf) for conf, _ in links}
    result = check(text, catalogs)
    if result["stale"]:
        print("stale examples in %s: %s" % (args.guide, ", ".join("%s %s" % (c, code) for c, code in result["stale"])))
        if args.problem_out:
            with open(args.problem_out, "w", encoding="utf-8") as f:
                f.write(problem_text(result))
    else:
        print("guide examples: %d codes checked, all in their catalogs%s" % (
            result["checked"], "; no catalog for %s" % ", ".join(result["unverifiable"]) if result["unverifiable"] else ""))
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write("stale=%s\n" % ("true" if result["stale"] else "false"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
