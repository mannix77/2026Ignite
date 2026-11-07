#!/usr/bin/env python3
"""Capture Ignite's live room occupancy into data/ignite2026/occupancy.json.

The official indoor map (wayfinding.event.microsoft.com) publishes a room-occupancy feed,
{"success": true, "enabled": true, "occupancy": {<room label>: <reading>}}, with no CORS
headers, so the app cannot read it directly; .github/workflows/occupancy.yml runs this every
10 minutes during the event and the app reads the committed file. The feed is empty until
the event starts and the per-room reading shape is not published, so readings are kept as
they come (the app decides what it can read); only the envelope is checked here.

    python3 scripts/occupancy.py                      # fetch the feed, write data/ignite2026/occupancy.json
    python3 scripts/occupancy.py --from-file x.json   # use a saved response instead of the network

Exit 0 when the file was written, 3 when the feed was unusable (the last file is kept).
"""
import argparse
import os
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync  # noqa: E402

URL = "https://wayfinding.event.microsoft.com/home/GetOccupancyList"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "ignite2026")
OUT = "occupancy.json"
CONFERENCE = "ignite2026"


def read_feed(doc):
    """(rooms, enabled, junk) from a feed response, or RuntimeError when it is not a usable feed.
    A room needs a usable label (a non-blank string) and a reading that is a number, a string or
    an object; anything else is skipped and counted, never fatal."""
    if not isinstance(doc, dict) or doc.get("success") is not True:
        raise RuntimeError("the occupancy feed did not report success")
    table = doc.get("occupancy")
    if not isinstance(table, dict):
        raise RuntimeError("the occupancy feed holds no room table")
    enabled = doc.get("enabled") is True
    rooms, junk = {}, 0
    for label, reading in table.items():
        key = sync.text(label) if isinstance(label, str) else ""
        usable = isinstance(reading, (dict, str)) or (isinstance(reading, (int, float)) and not isinstance(reading, bool))
        if not key or not usable:
            junk += 1
            continue
        rooms[key] = reading
    return rooms, enabled, junk


def run(args, get=sync.fetch_json, now=None):
    now = now or sync.utcnow()
    data = os.path.abspath(args.data_dir or DATA)
    path = os.path.join(data, OUT)
    try:
        doc = sync.load(args.from_file, None) if args.from_file else get(URL)
        rooms, enabled, junk = read_feed(doc)
    except (RuntimeError, OSError, ValueError, urllib.error.URLError) as e:
        print("occupancy: keeping the last file:", e, file=sys.stderr)
        return 3
    os.makedirs(data, exist_ok=True)
    sync.dump(path, {"app": "ignite26-planner", "kind": "occupancy", "conference": CONFERENCE,
                     "fetchedAt": sync.iso(now), "enabled": enabled, "source": URL,
                     "note": "Room occupancy from the official map's feed, as it came; refreshed by .github/workflows/occupancy.yml during the event.",
                     "rooms": rooms})
    print("occupancy: enabled=%s rooms=%d junk=%d" % (enabled, len(rooms), junk))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from-file", help="read the feed response from a file instead of the network")
    ap.add_argument("--data-dir", help="output directory (default: data/ignite2026/ in the repo)")
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
