#!/usr/bin/env python3
"""Check specs/features/*.feature for the shape this repo writes them in.

    python3 scripts/bdd_lint.py                 # every feature file under specs/
    python3 scripts/bdd_lint.py path.feature    # the files named

Prints `path:line: [code] reason` for each finding and exits 1 if there is any (2 if there was
nothing to check). The rules are the ones the existing feature files already follow; they are
described in specs/features/spec-lint.feature and tested in tests/test_bdd_lint.py, which also
runs this over every feature file, so `npm test` lints the specs.

    feature      one `Feature:` with a title, first in the file, and at least one scenario
    description  the feature says why it exists, in the lines under its title
    rule         every scenario sits under a titled `Rule:`, and every rule has a scenario
    title        every scenario has a title, and no two in a file share one
    steps        Given, When, Then at most once each and in that order (And/But for more);
                 every scenario has a Then; steps only inside a scenario or background; a
                 Background comes once, before the scenarios of its Feature or Rule
    brief        at most MAX_STEPS steps in a scenario
    outline      a Scenario Outline has Examples, every Examples table has a row and a
                 column for each <placeholder>, and nothing else has Examples
    text         a line that is not Gherkin this repo uses (a misspelled step, a tag, a doc
                 string, free text anywhere but under a Feature or Rule title)
    layout       indentation by block, no tabs, no trailing spaces, one newline at the end,
                 plain newlines and no byte order mark
    file         the file could not be read as UTF-8 text
"""
import os
import re
import sys

MAX_STEPS = 6          # the longest scenario in the repository when the rules were written

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BLOCK = re.compile(r"^(Feature|Rule|Background|Scenario Outline|Scenario|Examples|Example):(.*)$")
STEP = re.compile(r"^(Given|When|Then|And|But) \S")
PLACEHOLDER = re.compile(r"<(\S(?:[^<>]*\S)?)>")     # <name>, not the signs in "a < 5 and b > 2"
CELL_BREAK = re.compile(r"(?<!\\)\|")                 # a | that is not escaped as \|
ORDER = ("Given", "When", "Then")


def cells(row):
    return [c.strip() for c in CELL_BREAK.split(row.strip())[1:-1]]


def lint_text(text):
    """Every finding in one feature file's text, as [(line, code, reason)] in line order."""
    out = []

    def report(line, code, reason):
        out.append((line, code, reason))

    if text.startswith("\ufeff"):
        report(1, "layout", "the file starts with a byte order mark; save it as plain UTF-8")
        text = text[1:]
    if "\r" in text:
        report(1, "layout", "the file has Windows or old Mac line endings; use plain newlines")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    if text and not text.endswith("\n"):
        report(len(lines), "layout", "the file does not end with a newline")
    else:
        lines.pop()                                  # the empty piece after the final newline
        while lines and not lines[-1].strip():
            report(len(lines), "layout", "blank line at the end of the file")
            lines.pop()

    features = []        # line numbers of Feature: lines
    described = False    # the first feature has a description line
    rule = None          # {"line", "scenarios"} of the rule being read
    rules = 0
    scenarios = 0
    titles = set()
    cur = None           # the scenario or background being read
    scope = {}           # what the current Feature or Rule has held so far: background, scenarios
    where = "start"      # start | feature | rule | block: what free text here would be

    def indent(n, raw, want, what):
        if "\t" in raw[:len(raw) - len(raw.lstrip())]:
            return                                   # already reported as a tab
        have = len(raw) - len(raw.lstrip(" "))
        if have != want:
            report(n, "layout", "%s should be indented %d spaces, has %d" % (what, want, have))

    def close_rule():
        if rule is not None and not rule["scenarios"]:
            report(rule["line"], "rule", "the rule has no scenario")

    def close_block():
        if cur is None:
            return
        kind, line, steps = cur["kind"], cur["line"], cur["steps"]
        if not steps:
            report(line, "steps", "the %s has no steps" % ("background" if kind == "Background" else "scenario"))
        elif kind != "Background" and not any(k == "Then" for k, _ in steps):
            report(line, "steps", "the scenario has no Then: it states no outcome")
        if kind == "Scenario Outline":
            tables = cur["tables"]
            if not tables:
                report(line, "outline", "the outline has no Examples table")
            elif any(t["rows"] < 1 for t in tables):
                report(line, "outline", "an Examples table of the outline has no rows under its header")
            said = set()
            for use_line, names in cur["uses"]:
                for name in names:
                    missing = any(t["header"] is not None and name not in t["header"] for t in tables)
                    if missing and (use_line, name) not in said:
                        said.add((use_line, name))
                        report(use_line, "outline", "<%s> has no column in an Examples table" % name)

    for n, raw in enumerate(lines, 1):
        if "\t" in raw:
            report(n, "layout", "tab character; indent with spaces")
        if raw != raw.rstrip():
            report(n, "layout", "trailing whitespace")
        s = raw.strip()
        if not s or s.startswith("#"):
            continue

        block = BLOCK.match(s)
        if block:
            kind, title = block.group(1), block.group(2).strip()
            if kind == "Feature":
                close_block()
                cur = None
                features.append(n)
                if len(features) > 1:
                    report(n, "feature", "a second Feature in the file; one file is one feature")
                if not title:
                    report(n, "feature", "the feature has no title")
                indent(n, raw, 0, "Feature")
                where = "feature"
                scope = {"background": False, "scenarios": 0}
            elif kind == "Rule":
                close_block()
                cur = None
                close_rule()
                rule = {"line": n, "scenarios": 0}
                rules += 1
                if not title:
                    report(n, "rule", "the rule has no title")
                indent(n, raw, 2, "Rule")
                where = "rule"
                scope = {"background": False, "scenarios": 0}
            elif kind == "Examples":
                if cur is None or cur["kind"] != "Scenario Outline":
                    report(n, "outline", "Examples belong to a Scenario Outline; this is not one")
                    if cur is not None:
                        cur["examples"] = "ignored"
                else:
                    cur["examples"] = "table"
                    cur["tables"].append({"header": None, "rows": 0})
                    indent(n, raw, 6, "Examples")
            else:                                    # Background, Scenario, Scenario Outline, Example
                close_block()
                cur = {"kind": kind, "line": n, "steps": [], "examples": None, "tables": [], "last": -1,
                       "uses": [(n, PLACEHOLDER.findall(title))]}
                if kind == "Background":
                    indent(n, raw, 2 if rule is None else 4, "Background")
                    cur["step_indent"] = 4 if rule is None else 6
                    if scope.get("background"):
                        report(n, "steps", "a second Background; a Feature or Rule has one")
                    elif scope.get("scenarios"):
                        report(n, "steps", "the Background comes before the scenarios it applies to")
                    scope["background"] = True
                else:
                    scenarios += 1
                    scope["scenarios"] = scope.get("scenarios", 0) + 1
                    cur["step_indent"] = 6
                    if rule is None:
                        report(n, "rule", "the scenario is not under a Rule")
                    else:
                        rule["scenarios"] += 1
                        indent(n, raw, 4, kind)
                    if not title:
                        report(n, "title", "the scenario has no title")
                    elif title in titles:
                        report(n, "title", "another scenario in this file has the same title")
                    titles.add(title)
                where = "block"
            continue

        # Under a Feature or Rule title and before its first block, any line is description,
        # as it is to a Gherkin parser: "And so must notes." is prose there, not a step.
        if where == "block" and STEP.match(s):
            if cur["examples"] is not None:
                report(n, "steps", "a step outside a scenario or background")
                continue
            word = s.split(" ", 1)[0]
            steps = cur["steps"]
            indent(n, raw, cur["step_indent"], "a step")
            if word in ORDER:
                at = ORDER.index(word)
                if at == cur["last"]:
                    report(n, "steps", "a second %s; continue with And or But" % word)
                elif at < cur["last"]:
                    report(n, "steps", "%s after %s; the order is Given, When, Then" % (word, ORDER[cur["last"]]))
                cur["last"] = max(cur["last"], at)
            elif not steps:
                report(n, "steps", "a scenario cannot open with %s" % word)
            steps.append((word, n))
            if len(steps) == MAX_STEPS + 1 and cur["kind"] != "Background":
                report(n, "brief", "more than %d steps; split the scenario or say less" % MAX_STEPS)
            cur["uses"].append((n, PLACEHOLDER.findall(s)))
            continue

        if where == "block" and s.startswith("|"):
            if not (cur["steps"] or cur["examples"] is not None):
                report(n, "text", "a table row with no step or Examples above it")
            elif cur["examples"] == "ignored":
                pass                                 # already reported on its Examples line
            elif cur["examples"] is None:
                indent(n, raw, cur["step_indent"] + 2, "a step's table row")
                cur["uses"].append((n, PLACEHOLDER.findall(s)))
            else:
                indent(n, raw, 8, "an Examples row")
                row, table = cells(s), cur["tables"][-1]
                if table["header"] is None:
                    table["header"] = row
                else:
                    table["rows"] += 1
                    if len(row) != len(table["header"]):
                        report(n, "outline", "the row has %d cells, the header has %d" % (len(row), len(table["header"])))
            continue

        if s.startswith("@"):
            report(n, "text", "tags are not used in this repo's feature files: %s" % s)
        elif s.startswith('"""'):
            report(n, "text", "doc strings are not used in this repo's feature files")
        elif where == "feature":
            described = described or len(features) == 1
        elif where == "rule":
            pass                                     # a rule's description
        elif where == "start":
            report(n, "feature", "text before the Feature; a file starts with its Feature (or a # comment)")
            where = "text-before"
        elif where == "block":
            report(n, "text", "not a step (Given, When, Then, And, But): %s" % s)

    close_block()
    close_rule()
    if not features:
        if not any(code == "feature" for _, code, _ in out):
            report(1, "feature", "the file has no Feature")
    else:
        if not described:
            report(features[0], "description", "the feature has no description: say why it exists under its title")
        if not rules and not scenarios:
            report(features[0], "feature", "the feature has no scenario")
    return sorted(out, key=lambda f: f[0])


def lint_paths(paths):
    """[(path, line, code, reason)] for every finding in the files named; never raises on a bad file."""
    out = []
    for path in paths:
        try:
            with open(path, "rb") as f:
                text = f.read().decode("utf-8")
        except (OSError, UnicodeDecodeError) as e:
            out.append((path, 1, "file", "could not be read as UTF-8 text (%s)" % type(e).__name__))
            continue
        out += [(path, line, code, reason) for line, code, reason in lint_text(text)]
    return out


def default_paths(root=ROOT):
    """Every .feature file under <root>/specs, sorted."""
    out = []
    for folder, _, files in os.walk(os.path.join(root, "specs")):
        out += [os.path.join(folder, f) for f in files if f.endswith(".feature")]
    return sorted(out)


def main(argv, root=ROOT):
    paths = list(argv) or default_paths(root)
    if not paths:
        print("no feature files found under %s" % os.path.join(root, "specs"), file=sys.stderr)
        return 2
    findings = lint_paths(paths)
    for path, line, code, reason in findings:
        print("%s:%d: [%s] %s" % (path, line, code, reason))
    print("%d feature file%s checked, %s" % (
        len(paths), "" if len(paths) == 1 else "s",
        "%d finding%s" % (len(findings), "" if len(findings) == 1 else "s") if findings else "no findings"))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
