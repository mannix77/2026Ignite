#!/usr/bin/env python3
"""Import the AWS re:Invent 2026 session catalog into data/reinvent2026/ (same normalized
shape as the Ignite sync, so the app treats every conference alike).

Stdlib only (runs on the macOS system Python 3.9 and in GitHub Actions).

    python3 scripts/import_reinvent.py data/reinvent2026/source/reinvent2026_sessions.json
    python3 scripts/import_reinvent.py --fetch      # pull the live catalog, save a fresh snapshot, import it

The snapshot is the public catalog (https://catalog.awsevents.com/api/sessions) reduced to
one slim record per session run: sessionID, code, title, abstract, type, length, status,
published, modified, testRecord, attributes {facet: [values]}, speakers, times (0 or 1).

Outputs (relative to the repo root, under data/reinvent2026/):
    sessions.json  normalized catalog the app reads (committed)
    changes.json   newest-first log of change batches the app reads (committed)
    changelog.md   the same log as readable markdown, newest first, from the baseline on (committed)
    meta.json      last check time and status for the app (regenerated every run, not committed)

Input kept by hand: keynotes.json (keynotes aren't in the AWS catalog; see keynote_records).
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "reinvent2026")
SNAPSHOT = os.path.join(DATA, "source", "reinvent2026_sessions.json")
EVENT = "reinvent2026"
PACIFIC = ZoneInfo("America/Los_Angeles")

# Public widget config embedded in the catalog page (no login). If these stop working,
# watch the catalog page's request to /api/sessions for the new values.
API = "https://catalog.awsevents.com/api/sessions"
HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "rfWidgetId": "nbNFIlUhukEGI22KvPEwpPdWgK6FoPsi",
    "rfApiProfileId": "mSEPBdEOSHwzxJwd7H8MfSWVylSYQsS4",
    "User-Agent": "conference-planner/1.0 (+https://github.com/mannix77)",
}
PAGE_SIZE = 50          # fixed by the API
MAX_PAGES = 200         # 10,000 sessions: a runaway-loop stop, not a real limit
# Guard: an outage or partial index must not look like hundreds of cancellations.
MIN_KEEP = 0.9

SKIP_ATTRS = {"Day", "DayTime"}     # derivable from times[]
TIME_KEYS = ["sessionTimeID", "date", "startTime", "endTime", "utcStartTime", "utcEndTime", "length", "room",
             "roomId", "capacity", "inPersonTime", "virtualTime", "replayable"]
# ANT319-R, ANT319-R1 ... are runs of ANT319; a bare -R counts (sync.REPEAT_SUFFIX needs a digit).
REPEAT = re.compile(r"-R\d*$", re.I)
SPONSORED_CODE = re.compile(r"-S(-R\d*)?$", re.I)
REPEAT_MARK = re.compile(r"\s*\[REPEAT\]\s*", re.I)
SPONSORED_BY = re.compile(r"\(sponsored by ([^)]+)\)", re.I)
# Assumption (unconfirmed): AWS posts breakouts to YouTube after the event; chalk talks,
# workshops, builders' sessions and the other interactive formats aren't recorded.
RECORDED_TYPES = {"Breakout session"}
# Reserved seating opened 2026-10-06 09:00 PT; the app shows this until it passes.
RSVP_OPENS = "2026-10-06T16:00:00Z"


def num(v):
    """Whole floats from the API (60.0) -> int, numeric strings ("212") -> int; else unchanged/None."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str) and v.strip().isdigit():
        return int(v)
    return v


# ---------------------------------------------------------------- fetch

def post_page(offset, attempts=3):
    body = urllib.parse.urlencode({"type": "session", "browserTimezone": "America/Los_Angeles",
                                   "catalogDisplay": "list", "from": offset}).encode()
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(API, data=body, headers=HEADERS, method="POST")
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.load(res)
        except (urllib.error.URLError, OSError, ValueError) as e:
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError("catalog page from=%d failed: %s" % (offset, last))


def page_items(page):
    """The first page nests items under sectionList[0]; later pages (from > 0) have them at the top."""
    if not isinstance(page, dict):
        raise RuntimeError("unexpected catalog page (not an object)")
    if "items" in page:
        return page["items"] or []
    sections = page.get("sectionList") or [{}]
    return sections[0].get("items") or []


def session_id(v):
    """A usable session id: non-blank text, trimmed; anything else (blank, a list, an object) is None."""
    return v.strip() or None if isinstance(v, str) else None


def slim(r):
    """Raw API record (~10 KB) -> the snapshot shape (one run, its facets, speakers and slot)."""
    attrs = {}
    for a in r.get("attributevalues") or []:
        if not isinstance(a, dict):
            continue
        k = a.get("attribute_id")
        if k and k not in SKIP_ATTRS:
            attrs.setdefault(k, []).append(a.get("value"))
    return {
        "sessionID": session_id(r.get("sessionID")),
        "code": r.get("code"),
        "title": r.get("title"),
        "abstract": r.get("abstract"),
        "type": r.get("type"),
        "length": num(r.get("length")),
        "status": r.get("status"),
        "published": num(r.get("published")),
        "modified": r.get("modified"),
        "testRecord": r.get("testRecord"),
        "attributes": attrs,
        # Some speakers only fill in the global profile (company/title blank on the event record).
        "speakers": [{"name": p.get("fullName"), "title": p.get("jobTitle") or p.get("globalJobtitle") or "",
                      "company": p.get("companyName") or p.get("globalCompany") or "",
                      "role": p.get("roles")} for p in r.get("participants") or [] if isinstance(p, dict)],
        "times": [{k: num(t.get(k)) if k == "length" else t.get(k) for k in TIME_KEYS}
                  for t in r.get("times") or [] if isinstance(t, dict)],
    }


def fetch_catalog(post=post_page):
    """Page through the catalog until an empty page; slim and de-duplicate by sessionID."""
    out, seen = [], set()
    for n in range(MAX_PAGES):
        items = page_items(post(n * PAGE_SIZE))
        if not items:
            return out
        for r in items:
            if not isinstance(r, dict):
                continue  # not a session: nothing to keep
            s = slim(r)
            if s["sessionID"] and s["sessionID"] not in seen:
                seen.add(s["sessionID"])
                out.append(s)
    raise RuntimeError("catalog still paging after %d pages" % MAX_PAGES)


# ---------------------------------------------------------------- normalize

def utc(s):
    """'2026/12/01 00:30:00' (UTC) -> aware datetime, else None."""
    try:
        return dt.datetime.strptime(sync.text(s), "%Y/%m/%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError):
        return None


def level(values):
    for v in values:
        m = re.match(r"^\s*(\d{3})\b", v or "")
        if m:
            return int(m.group(1))
    return None


def strs(attrs, name):
    return [sync.text(x) for x in attrs.get(name) or [] if isinstance(x, str) and sync.text(x)]


def vendors_of(r, title):
    names = [sync.text(p.get("company")) for p in r.get("speakers") or []
             if p.get("role") == "Sponsor Speaker" and sync.text(p.get("company"))]
    if not names:
        m = SPONSORED_BY.search(title)
        if m:
            names = [sync.text(m.group(1))]
    return list(dict.fromkeys(names))


def normalize(raw):
    """-> (records, {"test", "notAccepted", "unpublished", "malformed", "extraRuns": counts}).
    A broken record (not an object, or no session id) is skipped and counted, never fatal.
    AWS lists repeat runs as separate sessions; a second time on one record has never been
    seen (0 of 2,190 on 2026-10-07), so only the first is imported and the rest are reported."""
    out = []
    dropped = {"test": 0, "notAccepted": 0, "unpublished": 0, "malformed": 0, "extraRuns": 0}
    for r in raw:
        sid = session_id(r.get("sessionID")) if isinstance(r, dict) else None
        if not sid:
            dropped["malformed"] += 1
            continue
        if r.get("testRecord"):
            dropped["test"] += 1
            continue
        if r.get("status") != "Accepted":
            dropped["notAccepted"] += 1
            continue
        if not r.get("published"):
            dropped["unpublished"] += 1
            continue
        code = sync.text(r.get("code"))
        attrs = r.get("attributes") if isinstance(r.get("attributes"), dict) else {}
        title = REPEAT_MARK.sub(" ", sync.text(r.get("title"))).strip()
        appendices = strs(attrs, "SessionAppendices")
        sponsored = bool(SPONSORED_CODE.search(code)) or "Sponsored" in appendices
        vendors = vendors_of(r, title) if sponsored else []
        times = [x for x in r.get("times") or [] if isinstance(x, dict)]
        t = times[0] if times else {}
        if len(times) > 1:
            dropped["extraRuns"] += len(times) - 1
            print("warning: %s lists %d times; only the first is imported" % (code, len(times)), file=sys.stderr)
        start, end = utc(t.get("utcStartTime")), utc(t.get("utcEndTime"))
        if start and end and end < start:
            end = None
        room = sync.text(t.get("room")) or None
        scheduled = bool(start)
        dur = num(t.get("length") or r.get("length"))
        if end and start:
            dur = int((end - start).total_seconds() // 60)
        out.append({
            "id": sid,
            "inst": sid,
            "code": code,
            "title": title,
            "desc": sync.text(r.get("abstract")),
            "type": sync.text(r.get("type")),
            "level": level(attrs.get("Level") or []),
            "topics": strs(attrs, "Topic"),
            "tags": strs(attrs, "AreaofInterest") + strs(attrs, "Services") + vendors,
            "audience": strs(attrs, "Role") + strs(attrs, "Industry"),
            "delivery": ["In-person"],
            "recorded": sync.text(r.get("type")) in RECORDED_TYPES,
            "speakers": [[sync.text(p.get("name")), sync.text(p.get("company")), sync.text(p.get("title"))]
                         for p in r.get("speakers") or [] if isinstance(p, dict) and sync.text(p.get("name"))],
            "start": sync.iso(start) if start else None,
            "end": sync.iso(end) if end else None,
            "slot": "%s - %s" % (t["startTime"], t["endTime"]) if scheduled and t.get("startTime") and t.get("endTime") else None,
            "dur": dur if isinstance(dur, int) else None,
            "room": room,
            "roomTbd": not room,
            "popular": False,
            "related": [],
            # re:Invent seats are reserved per session (opened 2026-10-06 09:00 PT).
            "rsvp": scheduled and t.get("inPersonTime") is not False,
            "vendors": vendors,
            "sponsored": sponsored,
            "laptop": "Laptop required" in appendices,
            "capacity": num(t.get("capacity")) if isinstance(num(t.get("capacity")), int) else None,
            "features": strs(attrs, "Features"),
        })
        if out[-1]["rsvp"]:
            out[-1]["rsvpOpens"] = RSVP_OPENS
    members = {}
    for rec in out:
        members.setdefault(REPEAT.sub("", rec["code"]) or rec["code"], []).append(rec)
    for group, recs in members.items():
        for rec in recs:
            rec["group"] = group
            rec["repeats"] = sorted(x["code"] for x in recs if x is not rec)
    out.sort(key=lambda x: (x["start"] is None, x["start"] or "", x["code"]))
    return out, dropped


def keynote_records(doc):
    """Keynotes aren't in the AWS catalog. data/reinvent2026/keynotes.json lists them by hand once
    AWS publishes them: {"keynotes": [{code, title, start, end (ISO UTC), room?, speakers?, desc?}]}.
    Entries without a valid start and end are skipped (never guess a keynote time); a repeated
    code keeps the first entry, since the code becomes the session id."""
    out, seen = [], set()
    for k in (doc or {}).get("keynotes") or []:
        code = sync.text(k.get("code"))
        start, end = sync.parse_iso(k.get("start")), sync.parse_iso(k.get("end"))
        if not code or not start or not end or end <= start:
            print("warning: keynote %r skipped (needs code, start and end)" % (code or k.get("title")), file=sys.stderr)
            continue
        if code in seen:
            print("warning: keynote %r skipped (duplicate code)" % code, file=sys.stderr)
            continue
        seen.add(code)
        room = sync.text(k.get("room")) or None
        out.append({
            "id": "keynote-" + code, "inst": "keynote-" + code, "code": code, "title": sync.text(k.get("title")),
            "desc": sync.text(k.get("desc")), "type": "Keynote", "level": None, "topics": [], "tags": [], "audience": [],
            "delivery": ["In-person"], "recorded": True,
            "speakers": [[sync.text(x) for x in (p + ["", "", ""])[:3]] for p in k.get("speakers") or [] if p],
            "start": sync.iso(start), "end": sync.iso(end),
            "slot": "%s - %s" % tuple(t.astimezone(PACIFIC).strftime("%H:%M") for t in (start, end)),
            "dur": int((end - start).total_seconds() // 60), "room": room, "roomTbd": not room,
            "popular": False, "related": [], "rsvp": False, "vendors": [], "group": code, "repeats": [],
        })
    return out


# ---------------------------------------------------------------- run

def summary_stats(recs):
    """For the PR / issue: sessions, runs, groups, by type and by venue."""
    by_type, by_venue = {}, {}
    for r in recs:
        by_type[r["type"]] = by_type.get(r["type"], 0) + 1
        v = (r["room"] or "Unscheduled").split(" | ")[0]
        by_venue[v] = by_venue.get(v, 0) + 1
    return {"sessions": len(recs), "scheduled": sum(1 for r in recs if r["start"]),
            "groups": len({r["group"] for r in recs}), "repeatRuns": sum(1 for r in recs if r["repeats"]),
            "byType": dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
            "byVenue": dict(sorted(by_venue.items(), key=lambda kv: -kv[1]))}


CHANGELOG_HEAD = ("# re:Invent 2026 catalog changes\n\n"
                  "Newest first. Written by `scripts/import_reinvent.py` on every import that changes the catalog;\n"
                  "the same batches are in `changes.json`, which the app reads.\n")


def log_markdown(path, at, source, body):
    old = ""
    try:
        with open(path, encoding="utf-8") as f:
            old = f.read()
    except OSError:
        pass
    old = old[len(CHANGELOG_HEAD):] if old.startswith(CHANGELOG_HEAD) else old
    entry = "\n## %s · %s\n\n%s" % (at, source, body)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(CHANGELOG_HEAD + entry + old)
    os.replace(tmp, path)


def save_snapshot(path, sessions, now):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sync.dump(path, {"source": API, "event": EVENT, "fetchedAt": sync.iso(now), "count": len(sessions),
                     "sessions": sessions})


def run(args):
    now = sync.utcnow()
    data = os.path.abspath(args.data_dir or DATA)
    os.makedirs(data, exist_ok=True)
    spath, cpath, mpath, lpath = (os.path.join(data, n) for n in
                                  ("sessions.json", "changes.json", "meta.json", "changelog.md"))
    prev_doc = sync.load(spath, None)
    prev = prev_doc["sessions"] if prev_doc else []
    meta = sync.load(mpath, {})
    meta["lastChecked"] = sync.iso(now)
    try:
        if args.fetch:
            raw, source = fetch_catalog(), API
        else:
            doc = sync.load(args.snapshot, None)
            if not isinstance(doc, dict) or not isinstance(doc.get("sessions"), list):
                raise RuntimeError("%s: not a re:Invent snapshot (no sessions list)" % args.snapshot)
            raw, source = doc["sessions"], os.path.basename(args.snapshot)
        cur, dropped = normalize(raw)
        cur += keynote_records(sync.load(os.path.join(data, "keynotes.json"), None))
        if not cur or (prev and len(cur) < MIN_KEEP * len(prev)):
            raise RuntimeError("catalog returned %d sessions (previously %d); keeping last good data"
                               % (len(cur), len(prev)))
        # Same guard as the Ignite sync: a renamed time or room field keeps the session count
        # but empties those fields, which must not be published as hundreds of changes.
        why = sync.withdrawal(sync.stats(prev), sync.stats(cur)) if prev and not getattr(args, "allow_withdrawal", False) else None
        if why:
            raise RuntimeError(why)
    except RuntimeError as e:
        meta.update({"ok": False, "error": str(e)})
        sync.dump(mpath, meta)
        print("reinvent import failed:", e, file=sys.stderr)
        return 3, False
    if args.fetch:
        save_snapshot(os.path.abspath(args.snapshot_out or os.path.join(data, "source", "reinvent2026_sessions.json")),
                      raw, now)

    seen = {r["inst"]: r.get("firstSeen") for r in prev}
    for r in cur:
        r["firstSeen"] = seen[r["inst"]] if r["inst"] in seen else (sync.iso(now) if prev else None)
    added, removed, changed = sync.diff(prev, cur) if prev else ([], [], [])
    cs = sync.stats(cur)
    changed_at = (prev_doc or {}).get("changedAt")
    if not prev_doc or added or removed or changed:
        changed_at = sync.iso(now)
    if not prev_doc or prev != cur or prev_doc.get("dropped") != dropped:
        sync.dump(spath, {"generatedAt": sync.iso(now), "changedAt": changed_at, "source": source, "dropped": dropped,
                          "stats": cs, "sessions": cur}, compact=True)
    changes = sync.load(cpath, {"batches": []})
    batch = None
    if added or removed or changed:
        batch = {"at": sync.iso(now), "milestones": [], "added": added, "removed": removed, "changed": changed}
        changes["batches"].insert(0, batch)
        del changes["batches"][sync.MAX_BATCHES:]
        sync.dump(cpath, changes)
        log_markdown(lpath, sync.iso(now), source, sync.summary_markdown(batch, set()))
    elif not prev_doc:
        sync.dump(cpath, changes)
        st = summary_stats(cur)
        log_markdown(lpath, sync.iso(now), source,
                     "Baseline import: %d sessions (%d scheduled) in %d groups.\n" % (st["sessions"], st["scheduled"], st["groups"]))
    meta.update({"ok": True, "error": None, "lastChanged": changed_at, "stats": cs, "source": source,
                 "lastLogged": changes["batches"][0]["at"] if changes["batches"] else None})
    sync.dump(mpath, meta)
    if batch and args.summary_out:
        with open(args.summary_out, "w", encoding="utf-8") as f:
            f.write(sync.summary_markdown(batch, set()))
    print("reinvent: sessions=%d dates=%d rooms=%d (dropped %d test, %d not accepted, %d unpublished, %d malformed,"
          " %d extra runs) | added=%d removed=%d changed=%d"
          % (cs["sessions"], cs["withDates"], cs["withRooms"], dropped["test"], dropped["notAccepted"],
             dropped["unpublished"], dropped["malformed"], dropped["extraRuns"], len(added), len(removed), len(changed)))
    return 0, bool(batch)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("snapshot", nargs="?", help="a saved snapshot (default with --fetch: none)")
    ap.add_argument("--fetch", action="store_true", help="pull the live catalog and save a fresh snapshot first")
    ap.add_argument("--snapshot-out", help="where --fetch saves the snapshot (default: <data-dir>/source/)")
    ap.add_argument("--data-dir", help="output directory (default: data/reinvent2026/ in the repo)")
    ap.add_argument("--summary-out", help="write a markdown change summary here when something changed")
    ap.add_argument("--allow-withdrawal", action="store_true",
                    help="accept a refresh that loses most session times or rooms (only when that is real)")
    ap.add_argument("--stats", action="store_true", help="print sessions/groups/type/venue counts as JSON and exit")
    args = ap.parse_args()
    if not args.fetch and not args.snapshot:
        ap.error("give a snapshot file or --fetch")
    if args.stats:
        print(json.dumps(summary_stats(normalize(sync.load(args.snapshot, {}).get("sessions", []))[0]), indent=1))
        return
    try:
        code, changed = run(args)
    except Exception as e:  # never leave CI green-but-silent on an unexpected payload
        code, changed = 3, False
        mpath = os.path.join(os.path.abspath(args.data_dir or DATA), "meta.json")
        meta = sync.load(mpath, {})
        meta.update({"ok": False, "error": "%s: %s" % (type(e).__name__, e), "lastChecked": sync.iso(sync.utcnow())})
        os.makedirs(os.path.dirname(mpath), exist_ok=True)
        sync.dump(mpath, meta)
        import traceback
        traceback.print_exc()
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write("changed=%s\n" % ("true" if changed else "false"))
    sys.exit(code)


if __name__ == "__main__":
    main()
