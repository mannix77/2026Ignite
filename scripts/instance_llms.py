"""Writes a colleague copy's llms.txt: the site's guide with every link pointing into the copy.

    python3 scripts/instance_llms.py llms.txt gino/llms.txt gino

The deploy's "Publish copies for colleagues" step calls it for each instances/<name>/.
Picks are saved per copy, so a link to the main site would import into the wrong copy.
"""
import re
import sys

SITE = "https://mannix77.github.io/2026Ignite/"


def main(argv):
    if len(argv) != 4:
        print("usage: instance_llms.py SRC DEST NAME", file=sys.stderr)
        return 2
    src, dest, name = argv[1:]
    if not re.fullmatch(r"[a-z0-9-]+", name):
        print("copy name '%s' must be lowercase letters, digits or -" % name, file=sys.stderr)
        return 1
    with open(src, encoding="utf-8") as f:
        text = f.read()
    if SITE not in text:
        print("%s has no link to %s; nothing to point at the copy" % (src, SITE), file=sys.stderr)
        return 1
    with open(dest, "w", encoding="utf-8") as f:
        f.write(text.replace(SITE, SITE + name + "/"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
