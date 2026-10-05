#!/usr/bin/env python3
"""Import a Gartner Conference Navigator export into data/gartner2026/ (same normalized
shape as the Ignite sync, so the app treats both conferences alike).

    python3 scripts/import_gartner.py ~/Downloads/gartner_sym2026_sessions.json \
        --workbook ~/Downloads/gartner_sym2026_sessions.xlsx

The JSON is the agenda export (one object per session: id, code, t, s, e, loc, srr, sp,
ex, f, mine, d). The optional workbook's "My Favorites" sheet supplies your ranking
(Score, Attend Mode, Plan, notes), which becomes:
    data/gartner2026/favorites.json   codes + tiers + scores (committed; no notes)
    ~/Downloads/gartner-2026-picks.json  the same plus your notes, for Settings -> Restore backup

Re-run it after a new export: differences are logged to data/gartner2026/changes.json
exactly like the Ignite sync does.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "gartner2026")
TZ = ZoneInfo("America/New_York")
PRIVATE = re.compile(r"^(SM|SAM)\d")                      # strategic-account meetings: not public sessions
RECORDED_TYPES = {"Keynote", "Signature Series", "Track Sessions"}   # replay assumed (unconfirmed); logistics: n/a
# Daily logistics that repeat by title but aren't "attend once" sessions.
NO_GROUP_TYPES = {"Operating Hours", "Meals", "Engagement Zones", "Exclusive Opportunities",
                  "Receptions and Special Event", "CIO Lunch", "Conference Orientation"}


def local(s):
    t = dt.datetime.strptime(s, "%m/%d/%Y %H:%M:%S").replace(tzinfo=TZ)
    return t


def normalize(raw):
    out, dropped = [], []
    for r in raw:
        code = sync.text(r.get("code"))
        if not code or not r.get("id") or PRIVATE.match(code):
            dropped.append(code or str(r.get("id")))
            continue
        f = r.get("f") or {}
        typ = (f.get("Session Type") or [""])[0]
        start, end = local(r["s"]), local(r["e"])
        loc = sync.text(r.get("loc"))
        live, remote = loc, ""
        if "|" in loc:
            live, remote = [sync.text(x) for x in loc.split("|", 1)]
        live = re.sub(r"^\s*Live:\s*", "", live)
        remote = re.sub(r"^\s*Remote:\s*", "", remote)
        desc = sync.text(r.get("d"))
        if remote:
            desc = (desc + "\n\nRemote viewing: " + remote).strip()
        vendors = [sync.text(v) for v in (r.get("ex") or []) if sync.text(v)]
        out.append({
            "id": str(r["id"]),
            "inst": str(r["id"]),
            "code": code,
            "title": sync.text(r.get("t")),
            "desc": desc,
            "type": typ,
            "level": None,
            "topics": [sync.text(x) for x in f.get("Topic", [])],
            "tags": [sync.text(x) for x in f.get("Tracks", [])] + vendors,
            "audience": [sync.text(x) for x in f.get("Tailored Programming", []) + f.get("Industries", [])],
            "delivery": ["In-person"],
            "recorded": True if typ in RECORDED_TYPES else (None if typ in NO_GROUP_TYPES else False),
            "speakers": [[sync.text(p[0]), sync.text(p[2] if len(p) > 2 else ""), sync.text(p[1] if len(p) > 1 else "")]
                         for p in (r.get("sp") or []) if p and sync.text(p[0])],
            "start": sync.iso(start.astimezone(dt.timezone.utc)),
            "end": sync.iso(end.astimezone(dt.timezone.utc)),
            "slot": "%s - %s" % (start.strftime("%H:%M"), end.strftime("%H:%M")),
            "dur": int((end - start).total_seconds() // 60),
            "room": live or None,
            "roomTbd": not live,
            "popular": False,
            "related": [],
            "rsvp": bool(r.get("srr")),
            "remote": bool(r.get("rv")),
            "vendors": vendors,
            "speakerType": (f.get("Speaker Type") or [""])[0],
        })
    # Repeats: the same title and type under different codes (e.g. the contract
    # negotiation clinics run several times). Attend at most one.
    members = {}
    for rec in out:
        key = (re.sub(r"\s+", " ", rec["title"]).lower(), rec["type"]) if rec["type"] not in NO_GROUP_TYPES else (rec["code"],)
        members.setdefault(key, []).append(rec)
    for recs in members.values():
        recs.sort(key=lambda x: x["start"])
        group = recs[0]["code"]
        for rec in recs:
            rec["group"] = group
            rec["repeats"] = sorted(x["code"] for x in recs if x is not rec)
    out.sort(key=lambda x: (x["start"], x["code"]))
    return out, dropped


def read_sheet(path, name):
    z = zipfile.ZipFile(path)
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % ns["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}

    def col(ref):
        n = 0
        for ch in re.match(r"[A-Z]+", ref).group(0):
            n = n * 26 + ord(ch) - 64
        return n - 1

    for sh in wb.find("m:sheets", ns):
        if sh.get("name") != name:
            continue
        target = rels[sh.get("{%s}id" % ns["r"])].lstrip("/")
        root = ET.fromstring(z.read(target if target.startswith("xl/") else "xl/" + target))
        rows = []
        for r in root.iter("{%s}row" % ns["m"]):
            vals = {}
            for c in r.findall("m:c", ns):
                v = c.find("m:v", ns)
                t = c.get("t")
                if t == "inlineStr":
                    txt = "".join(x.text or "" for x in c.iter("{%s}t" % ns["m"]))
                elif v is None:
                    continue
                elif t == "s":
                    txt = shared[int(v.text)]
                else:
                    txt = v.text
                vals[col(c.get("r"))] = txt
            if vals:
                rows.append([vals.get(i, "") for i in range(max(vals) + 1)])
        head = rows[0]
        return [dict(zip(head, r + [""] * (len(head) - len(r)))) for r in rows[1:]]
    raise SystemExit("sheet %r not found in %s" % (name, path))


# Attend mode -> rating tier. "Replay later" stays a Maybe: attended when free, otherwise
# it's on the recording list. The workbook's Plan column marks explicit watch-later picks.
MODE = {
    "MUST ATTEND (live only)": 3,
    "Attend if no live-only clash, else replay": 2,
    "Attend if free": 2,
    "Optional": 1,
    "Replay later": 1,
}


def favorites(rows, sessions, now_ms):
    by_code = {s["code"]: s for s in sessions}
    picks, local_picks, missing = {}, {}, []
    for r in rows:
        s = by_code.get(sync.text(r.get("Session Code")))
        if not s:
            missing.append(r.get("Session Code"))
            continue
        mode = sync.text(r.get("Attend Mode"))
        plan = sync.text(r.get("Plan"))
        p = MODE.get(mode, 2 if plan == "Attend" else 1)
        try:
            score = float(r.get("Score") or 0)
        except ValueError:
            score = 0
        rec = {"p": p, "lock": None, "note": "", "at": now_ms, "g": s["group"], "code": s["code"], "score": score}
        if plan == "Watch later":
            rec["mode"] = "watch"
        picks[s["id"]] = rec
        parts = ["Workbook rank #%s · score %s · %s%s" % (r.get("Rank"), r.get("Score"), mode, (" · plan: " + plan) if plan else "")]
        for k, label in (("My Notes", "Note"), ("Why it matters", "Why it matters"), ("Vendor-consolidation angle", "Vendor-consolidation angle")):
            if sync.text(r.get(k)):
                parts.append("%s: %s" % (label, sync.text(r.get(k))))
        local_picks[s["id"]] = dict(rec, note="\n".join(parts))
    return picks, local_picks, missing


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("export_json")
    ap.add_argument("--workbook", help="xlsx with a 'My Favorites' sheet")
    ap.add_argument("--data-dir", default=DATA)
    ap.add_argument("--backup-dir", default=os.path.expanduser("~/Downloads"))
    args = ap.parse_args()
    now = sync.utcnow()
    raw = sync.load(args.export_json, None)
    if not isinstance(raw, list):
        raise SystemExit("expected a JSON array of sessions")
    cur, dropped = normalize(raw)
    data = os.path.abspath(args.data_dir)
    os.makedirs(data, exist_ok=True)
    spath, cpath, mpath = (os.path.join(data, n) for n in ("sessions.json", "changes.json", "meta.json"))
    prev_doc = sync.load(spath, None)
    prev = prev_doc["sessions"] if prev_doc else []
    seen = {r["inst"]: r.get("firstSeen") for r in prev}
    for r in cur:
        r["firstSeen"] = seen[r["inst"]] if r["inst"] in seen else (sync.iso(now) if prev else None)
    added, removed, changed = sync.diff(prev, cur) if prev else ([], [], [])
    cs = sync.stats(cur)
    changes = sync.load(cpath, {"batches": []})
    changed_at = (prev_doc or {}).get("changedAt")
    if (not prev_doc) or prev != cur:
        changed_at = sync.iso(now) if (not prev_doc or added or removed or changed) else changed_at or sync.iso(now)
        sync.dump(spath, {"generatedAt": sync.iso(now), "changedAt": changed_at, "source": os.path.basename(args.export_json),
                          "dropped": dropped, "stats": cs, "sessions": cur}, compact=True)
    if added or removed or changed:
        changes["batches"].insert(0, {"at": sync.iso(now), "milestones": [], "added": added, "removed": removed, "changed": changed})
        sync.dump(cpath, changes)
    elif not os.path.exists(cpath):
        sync.dump(cpath, changes)
    sync.dump(mpath, {"lastChecked": sync.iso(now), "lastChanged": changed_at, "ok": True, "error": None, "stats": cs,
                      "source": "Conference Navigator export"})
    print("gartner: sessions=%d (dropped %d private) | added=%d removed=%d changed=%d"
          % (len(cur), len(dropped), len(added), len(removed), len(changed)))

    if args.workbook:
        rows = read_sheet(args.workbook, "My Favorites")
        now_ms = int(time.time() * 1000)
        picks, local_picks, missing = favorites(rows, cur, now_ms)
        version = "%s-%d" % (now.strftime("%Y%m%d"), len(picks))
        sync.dump(os.path.join(data, "favorites.json"), {
            "app": "ignite26-planner", "v": 1, "conference": "gartner2026", "version": version,
            "source": "Conference Navigator favorites + workbook ranking", "picks": picks})
        os.makedirs(args.backup_dir, exist_ok=True)
        bpath = os.path.join(args.backup_dir, "gartner-2026-picks.json")
        sync.dump(bpath, {"app": "ignite26-planner", "v": 1, "conference": "gartner2026", "exportedAt": sync.iso(now),
                          "picks": local_picks, "settings": {}})
        print("favorites: %d (missing from export: %s) -> favorites.json; backup with notes -> %s" % (len(picks), missing or "none", bpath))


if __name__ == "__main__":
    main()
