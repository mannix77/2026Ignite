#!/usr/bin/env python3
"""Turn a re:Invent portal export of "my favorites + my schedule" into the planner's
favorites for data/reinvent2026/ (specs/features/reinvent-favorites.feature).

    python3 scripts/import_reinvent_favorites.py ~/Downloads/reinvent2026-my-sessions-v2.json

The export is {"exported_at", "sessions": [{id, code, favorite, reserved, availability,
few_seats_left, times: [{timeId, reserved, capacity, seatsRemaining}]}]}. Sessions are
matched to the imported catalog (data/reinvent2026/sessions.json) by id; the catalog's run
id is what a lock or reservation points at.

Writes (no personal notes, so the files can be committed):
    data/reinvent2026/favorites.json  reserved -> Must pinned to the run; favorites with seats
                                      to reserve or walk-up only -> Want; full/waitlisted -> Maybe
    data/reinvent2026/seats.json      availability, capacity and seats left per session, for the app
    ~/Downloads/reinvent-2026-picks.json  the same picks as a restorable backup
"""
import argparse
import datetime as dt
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "reinvent2026")
CONFERENCE = "reinvent2026"
# Tier for a favorite by what the portal says about seats; a reserved seat is always Must.
TIER = {"reserve_a_seat": 2, "walk_up_only": 2, "session_full": 1, "waitlist": 1}
AVAILABILITY = set(TIER) | {"reserved"}
# Guard: an export that is mostly junk, or holds no sessions, must not replace good files.
MAX_JUNK_SHARE = 0.1


def usable_id(v):
    """The export's and the catalog's ids are non-blank strings; anything else is unusable."""
    return v.strip() if isinstance(v, str) and v.strip() else None


def flag(v):
    """A portal flag is a real Boolean (missing counts as False); anything else is junk."""
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    raise ValueError("flag")


def count(v):
    """A whole, finite, non-negative seat count; anything else is left out."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 or v != int(v):
        return None
    return int(v)


def read_session(s):
    """The usable parts of one exported session, or None for junk."""
    if not isinstance(s, dict):
        return None
    sid = usable_id(s.get("id"))
    times = s.get("times") if s.get("times") is not None else []
    if not sid or not isinstance(times, list):
        return None
    availability = s.get("availability")
    if availability is not None and not isinstance(availability, str):
        return None
    try:
        favorite, reserved = flag(s.get("favorite")), flag(s.get("reserved"))
        slots = [t for t in times if isinstance(t, dict)]
        for t in slots:
            flag(t.get("reserved"))
    except ValueError:
        return None
    reserved = reserved or any(t.get("reserved") is True for t in slots)
    # Seat counts come from the slot the pick stands for: the reserved one, else the first.
    slot = next((t for t in slots if t.get("reserved") is True), slots[0] if slots else {})
    return {"id": sid, "code": sync.text(s.get("code")), "favorite": favorite, "reserved": reserved,
            "availability": availability if availability in AVAILABILITY else None,
            "few": s.get("few_seats_left") is True,
            "capacity": count(slot.get("capacity")), "seatsRemaining": count(slot.get("seatsRemaining"))}


def favorites(export, catalog, now):
    """-> (picks, seats, skipped) where skipped counts {"unknown", "junk", "unmarked"}."""
    by_id = {}
    for rec in catalog:
        sid = usable_id(rec.get("id"))
        if sid:
            by_id.setdefault(sid, rec)
    now_ms = int(now.timestamp() * 1000)
    picks, seats = {}, {}
    skipped = {"unknown": [], "junk": 0, "unmarked": 0}
    for raw in export.get("sessions") or []:
        s = read_session(raw)
        if s is None:
            skipped["junk"] += 1
            continue
        rec = by_id.get(s["id"])
        if rec is None:
            skipped["unknown"].append(s["code"] or s["id"])
            continue
        if not s["reserved"] and not s["favorite"]:
            skipped["unmarked"] += 1
            continue
        availability = "reserved" if s["reserved"] else s["availability"]
        p = 3 if s["reserved"] else TIER.get(availability, 2)
        pick = {"p": p, "lock": rec["inst"] if s["reserved"] else None, "note": "", "at": now_ms,
                "g": rec.get("group") or rec["code"], "code": rec["code"]}
        if s["reserved"]:
            pick["reserved"] = rec["inst"]
        picks[s["id"]] = pick
        seat = {"availability": availability, "fewSeatsLeft": s["few"]}
        for k in ("capacity", "seatsRemaining"):
            if s[k] is not None:
                seat[k] = s[k]
        seats[s["id"]] = seat
    return picks, seats, skipped


def check_export(export, picks, skipped):
    """The reason to refuse this export, or None. Fixed thresholds: the data can't lower them."""
    total = len(export.get("sessions") or [])
    if total == 0:
        return "the export holds no sessions; nothing replaced"
    if skipped["junk"] > MAX_JUNK_SHARE * total:
        return "%d of %d records are junk (more than %d%%); nothing replaced" % (skipped["junk"], total, round(MAX_JUNK_SHARE * 100))
    if not picks:
        return "no favorite or reserved session in the export matches the catalog; nothing replaced"
    return None


def write(args, export, catalog, now):
    picks, seats, skipped = favorites(export, catalog, now)
    problem = check_export(export, picks, skipped)
    if problem:
        raise SystemExit("refusing the export: " + problem)
    exported_at = export.get("exported_at") if isinstance(export.get("exported_at"), str) else None
    version = "%s-%d" % (now.strftime("%Y%m%d"), len(picks))
    data = os.path.abspath(args.data_dir)
    sync.dump(os.path.join(data, "favorites.json"), {
        "app": "ignite26-planner", "v": 1, "conference": CONFERENCE, "version": version,
        "source": "re:Invent portal favorites + reservations", "exportedAt": exported_at, "picks": picks})
    sync.dump(os.path.join(data, "seats.json"), {
        "app": "ignite26-planner", "kind": "seats", "conference": CONFERENCE, "exportedAt": exported_at,
        "note": "Seat availability from the portal at export time; refreshed by scripts/import_reinvent_favorites.py.",
        "seats": seats})
    os.makedirs(args.backup_dir, exist_ok=True)
    bpath = os.path.join(args.backup_dir, "reinvent-2026-picks.json")
    sync.dump(bpath, {"app": "ignite26-planner", "v": 1, "conference": CONFERENCE, "exportedAt": sync.iso(now),
                      "picks": picks, "settings": {}})
    tiers = {3: 0, 2: 0, 1: 0}
    for pk in picks.values():
        tiers[pk["p"]] += 1
    return {"picks": len(picks), "must": tiers[3], "reserved": sum(1 for pk in picks.values() if "reserved" in pk),
            "want": tiers[2], "maybe": tiers[1], "skipped": skipped, "backup": bpath}


def parse_now(s):
    t = dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
    return t.replace(tzinfo=dt.timezone.utc)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("export_json")
    ap.add_argument("--data-dir", default=DATA, help="folder holding sessions.json (default: data/reinvent2026/)")
    ap.add_argument("--backup-dir", default=os.path.expanduser("~/Downloads"))
    ap.add_argument("--now", type=parse_now, default=None, help="timestamp to stamp the files with (tests)")
    args = ap.parse_args(argv)
    export = sync.load(args.export_json, None)
    if not isinstance(export, dict) or not isinstance(export.get("sessions"), list):
        raise SystemExit("expected the portal export: an object with a 'sessions' list")
    doc = sync.load(os.path.join(os.path.abspath(args.data_dir), "sessions.json"), None)
    if not isinstance(doc, dict) or not isinstance(doc.get("sessions"), list):
        raise SystemExit("no imported catalog in %s; run scripts/import_reinvent.py first" % args.data_dir)
    result = write(args, export, doc["sessions"], args.now or sync.utcnow())
    sk = result["skipped"]
    print("reinvent favorites: %d picks (Must %d incl. %d reserved, Want %d, Maybe %d); skipped: %d not in the catalog%s, %d not favorited, %d junk; backup -> %s"
          % (result["picks"], result["must"], result["reserved"], result["want"], result["maybe"], len(sk["unknown"]),
             (" (%s)" % ", ".join(sk["unknown"])) if sk["unknown"] else "", sk["unmarked"], sk["junk"], result["backup"]))
    return result


if __name__ == "__main__":
    main()
