#!/usr/bin/env python3
"""Import an AWS re:Invent "my sessions" export (favorites + schedule from the RainFocus
portal) into data/reinvent2026/, in the same normalized shape as the Ignite sync.

    python3 scripts/import_reinvent.py ~/Downloads/reinvent2026-my-sessions-v2.json

Writes:
    data/reinvent2026/sessions.json   the sessions in the export (your favorites + reservations)
    data/reinvent2026/changes.json    what changed since the last import (rooms, times, seats)
    data/reinvent2026/favorites.json  ratings: reserved seats -> Must (pinned to that run),
                                      open or walk-up favorites -> Want, full ones -> Maybe
    ~/Downloads/reinvent-2026-picks.json  the same picks as a restorable backup

The export only holds the sessions you favorited or reserved, so the plan is built from
those; re-export after changing favorites or reservations in the portal and re-run.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "reinvent2026")
REPEAT = re.compile(r"-R\d*$", re.I)
# Breakouts are recorded and published after the event; hands-on formats are not.
RECORDED = {"Breakout session": True, "Chalk talk": False, "Workshop": False, "Builders' session": False,
            "Code talk": False, "Gamified learning": False, "Bootcamp": False}
# Tier for a favorite by what the portal says about seats.
TIER = {"reserved": 3, "reserve_a_seat": 2, "walk_up_only": 2, "session_full": 1, "waitlist": 1}


def utc(s):
    """'2026/12/02 16:30:00' (UTC) -> '2026-12-02T16:30:00Z'."""
    t = dt.datetime.strptime(s, "%Y/%m/%d %H:%M:%S")
    return sync.iso(t)


def level_num(levels):
    for v in levels or []:
        m = re.match(r"\s*(\d{3})", v)
        if m:
            return int(m.group(1))
    return None


def normalize(export):
    out = []
    for s in export.get("sessions") or []:
        a = s.get("attributes") or {}
        code = sync.text(s.get("code"))
        for t in s.get("times") or []:
            room = ", ".join(sync.text(p) for p in (t.get("room") or "").split("|") if sync.text(p))
            typ = (a.get("Type") or [""])[0]
            appendices = [x for x in a.get("Session Appendices", []) if x != "Repeat"]
            out.append({
                "id": str(s["id"]),
                "inst": str(t.get("timeId") or s["id"]),
                "code": code,
                "title": sync.text(s.get("title")),
                "desc": sync.text(s.get("abstract")),
                "type": typ,
                "level": level_num(a.get("Level")),
                "topics": [sync.text(x) for x in a.get("Topic", []) + a.get("Area of Interest", [])],
                "tags": [sync.text(x) for x in a.get("Services", []) + a.get("Features", []) + appendices],
                "audience": [sync.text(x) for x in a.get("Role", [])],
                "delivery": ["In-person"],
                "recorded": RECORDED.get(typ),
                "speakers": [[sync.text(p.get("name")), sync.text(p.get("company")), sync.text(p.get("title"))]
                             for p in (s.get("speakers") or []) if sync.text(p.get("name"))],
                "start": utc(t["start_utc"]),
                "end": utc(t["end_utc"]),
                "slot": "%s - %s" % (t.get("start_local"), t.get("end_local")),
                "dur": int(t.get("length_min") or 0),
                "room": room or None,
                "roomTbd": not room,
                "popular": bool(s.get("few_seats_left")),
                "related": [],
                # Seats: only "reserve a seat" is something you can still act on.
                "rsvp": s.get("availability") == "reserve_a_seat",
                "availability": s.get("availability"),
                "capacity": t.get("capacity"),
                "seatsRemaining": t.get("seatsRemaining"),
                "fewSeatsLeft": bool(s.get("few_seats_left")),
                "laptop": "Laptop required" in a.get("Session Appendices", []),
                "venue": (a.get("Venue") or [""])[0],
            })
    # -R / -R1 codes are repeats of the same content: attend at most one.
    members = {}
    for rec in out:
        members.setdefault(REPEAT.sub("", rec["code"]), []).append(rec)
    for base, recs in members.items():
        for rec in recs:
            rec["group"] = base
            rec["repeats"] = sorted(x["code"] for x in recs if x is not rec)
    out.sort(key=lambda x: (x["start"], x["code"]))
    return out


def favorites(export, sessions, now_ms):
    by_id = {}
    for rec in sessions:
        by_id.setdefault(rec["id"], []).append(rec)
    picks = {}
    for s in export.get("sessions") or []:
        runs = by_id.get(str(s["id"]))
        if not runs:
            continue
        reserved_run = next((r for r in runs if any(t.get("reserved") and str(t.get("timeId")) == r["inst"] for t in s.get("times") or [])), None)
        if not s.get("favorite") and not reserved_run:
            continue
        p = 3 if reserved_run else TIER.get(s.get("availability"), 2)
        rec = {"p": p, "lock": reserved_run["inst"] if reserved_run else None, "note": "", "at": now_ms,
               "g": runs[0]["group"], "code": runs[0]["code"]}
        if reserved_run:
            rec["reserved"] = reserved_run["inst"]
        picks[str(s["id"])] = rec
    return picks


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("export_json")
    ap.add_argument("--data-dir", default=DATA)
    ap.add_argument("--backup-dir", default=os.path.expanduser("~/Downloads"))
    args = ap.parse_args()
    now = sync.utcnow()
    export = sync.load(args.export_json, None)
    if not isinstance(export, dict) or not isinstance(export.get("sessions"), list):
        raise SystemExit("expected the portal export: an object with a 'sessions' list")
    cur = normalize(export)
    data = os.path.abspath(args.data_dir)
    os.makedirs(data, exist_ok=True)
    spath, cpath, mpath = (os.path.join(data, n) for n in ("sessions.json", "changes.json", "meta.json"))
    prev_doc = sync.load(spath, None)
    prev = prev_doc["sessions"] if prev_doc else []
    seen = {r["inst"]: r.get("firstSeen") for r in prev}
    for r in cur:
        r["firstSeen"] = seen[r["inst"]] if r["inst"] in seen else (sync.iso(now) if prev else None)
    added, removed, changed = sync.diff(prev, cur) if prev else ([], [], [])
    # Seat availability isn't one of the sync's tracked fields; log it here.
    if prev:
        prev_by = {r["inst"]: r for r in prev}
        by_inst = {c["inst"]: c for c in changed}
        for r in cur:
            o = prev_by.get(r["inst"])
            if o and o.get("availability") != r.get("availability"):
                c = by_inst.get(r["inst"])
                if not c:
                    c = {"id": r["id"], "inst": r["inst"], "code": r["code"], "title": r["title"], "f": {}}
                    changed.append(c)
                c["f"]["availability"] = [o.get("availability"), r.get("availability")]
    cs = sync.stats(cur)
    changes = sync.load(cpath, {"batches": []})
    changed_at = (prev_doc or {}).get("changedAt")
    if (not prev_doc) or added or removed or changed:
        changed_at = sync.iso(now)
    if (not prev_doc) or prev != cur:
        sync.dump(spath, {"generatedAt": sync.iso(now), "changedAt": changed_at, "source": os.path.basename(args.export_json),
                          "exportedAt": export.get("exported_at"), "dropped": [], "stats": cs, "sessions": cur}, compact=True)
    if added or removed or changed:
        changes["batches"].insert(0, {"at": sync.iso(now), "milestones": [], "added": added, "removed": removed, "changed": changed})
        sync.dump(cpath, changes)
    elif not os.path.exists(cpath):
        sync.dump(cpath, changes)
    sync.dump(mpath, {"lastChecked": sync.iso(now), "lastChanged": changed_at, "ok": True, "error": None, "stats": cs,
                      "source": "re:Invent portal export"})
    now_ms = int(time.time() * 1000)
    picks = favorites(export, cur, now_ms)
    version = "%s-%d" % (now.strftime("%Y%m%d"), len(picks))
    sync.dump(os.path.join(data, "favorites.json"), {
        "app": "ignite26-planner", "v": 1, "conference": "reinvent2026", "version": version,
        "source": "re:Invent portal favorites + reservations", "picks": picks})
    os.makedirs(args.backup_dir, exist_ok=True)
    bpath = os.path.join(args.backup_dir, "reinvent-2026-picks.json")
    sync.dump(bpath, {"app": "ignite26-planner", "v": 1, "conference": "reinvent2026", "exportedAt": sync.iso(now),
                      "picks": picks, "settings": {}})
    tiers = {3: 0, 2: 0, 1: 0}
    for p in picks.values():
        tiers[p["p"]] += 1
    print("reinvent: sessions=%d | added=%d removed=%d changed=%d | favorites: %d (Must %d incl. %d reserved, Want %d, Maybe %d) -> favorites.json; backup -> %s"
          % (len(cur), len(added), len(removed), len(changed), len(picks), tiers[3], sum(1 for p in picks.values() if p.get("reserved")), tiers[2], tiers[1], bpath))


if __name__ == "__main__":
    main()
