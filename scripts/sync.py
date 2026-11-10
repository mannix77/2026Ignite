#!/usr/bin/env python3
"""Sync the Microsoft Ignite 2026 session catalog into data/*.json and log what changed.

Stdlib only (runs on the macOS system Python 3.9 and in GitHub Actions).

    python3 scripts/sync.py                     # fetch the live catalog, update data/
    python3 scripts/sync.py --from-file x.json  # use a saved API response instead of the network

Outputs (relative to the repo root, under data/ignite2026/):
    sessions.json  normalized catalog the app reads (committed)
    changes.json   newest-first log of change batches (committed)
    meta.json      last check time and status for the app (regenerated every run, not committed)

The browser app (assets/js/live.js) applies the same normalization to the public CDN
copy of the catalog; keep the two in step (tests/test_sync.py cross-checks them).
"""
import argparse
import datetime as dt
import hashlib
import http.client
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

import venues

API = "https://api-v2.ignite.microsoft.com/api"
CDN = "https://eventtools.event.microsoft.com/ignite2026-prod/fallback"
# The CDN copy (what the official site and this app's live check read) first, so the
# snapshot and the browser compare like with like; the API is the fallback.
SOURCES = {
    "sessions": [CDN + "/session-all-en-us.json", API + "/session/all/en-US"],
    "speakers": [CDN + "/speaker-all-en-us.json", API + "/speaker/all/en-US"],
    "settings": [CDN + "/settings.json", API + "/settings"],
}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "ignite2026")
VENUE = venues.CONFERENCE_VENUES["ignite2026"]   # the building patterns rooms are checked against
MAX_BATCHES = 400
# Used when the site settings can't be fetched. Times outside the event window are
# treated as placeholders (the 2026 index already holds fake times on Nov 14).
DEFAULT_WINDOW = ("2026-11-17", "2026-11-20")
# Fields compared between snapshots, in display order. "desc" changes are flagged, not stored.
TRACKED = ["title", "code", "type", "start", "end", "dur", "room", "speakers",
           "level", "delivery", "recorded", "desc"]
# The catalog has spelled these differently across years ("In person" vs "In-person").
DELIVERY_NAMES = {"inperson": "In-person", "online": "Online", "ondemand": "On-demand"}
MAX_DUR = 1440
# Whitespace trimmed from text fields; must match TRIM in assets/js/live.js.
TRIM = re.compile("^[ \t\n\r\x0b\x0c\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|"
                  "[ \t\n\r\x0b\x0c\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$")
REPEAT_SUFFIX = re.compile(r"-R\d+$", re.I)
# Site settings that reveal the schedule going live (see README "How publication is detected").
FLAGS = {
    "showSessionTimeSlots": ("sessionDetailsFlags", "showSessionTimeSlots"),
    "showLocations": ("showLocations",),
    "showRoomsToAnonymousUsers": ("showRoomsToAnonymousUsers",),
    "enableMySchedule": ("enableMySchedule",),
    "dateSelectors": ("dateSelectorsToggle", "enabled"),
    "roomCapacity": ("sessionRoomCapacitySettings", "enableSessionRoomCapacity"),
}
FLAG_LABELS = {
    "showSessionTimeSlots": "The Ignite site switched on session times",
    "showLocations": "The Ignite site switched on session locations",
    "showRoomsToAnonymousUsers": "The Ignite site switched on room names",
    "enableMySchedule": "The Ignite site opened its schedule builder",
    "dateSelectors": "The Ignite site switched on day filters",
    "roomCapacity": "The Ignite site switched on live room capacity",
}


def utcnow():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_json(url, attempts=3):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (ignite-planner sync; personal use)",
                "Accept": "application/json",
            })
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as e:
            last = e
            if i < attempts - 1:
                time.sleep(2 ** i)
    raise RuntimeError("fetch failed for %s: %s" % (url, last))


def fetch_first(kind):
    """Try each source in SOURCES order (the CDN copy, then the API); report every error if all fail."""
    errors = []
    for url in SOURCES[kind]:
        try:
            return fetch_json(url), url
        except RuntimeError as e:
            errors.append(str(e))
    raise RuntimeError("; ".join(errors))


def list_of(v):
    """A list, a single value, or junk -> list (mirrors listOf in live.js)."""
    return v if isinstance(v, list) else ([v] if v else [])


def vals(lst):
    """[{displayValue: x}, ...] -> [x, ...] (non-empty strings, deduped, order kept)."""
    out = []
    for v in list_of(lst):
        s = v.get("displayValue") if isinstance(v, dict) else v
        if isinstance(s, str) and s and s not in out:
            out.append(s)
    return out


def one(v):
    if isinstance(v, list):
        v = v[0] if v else ""
    if isinstance(v, dict):
        v = v.get("displayValue") or ""
    return v if isinstance(v, str) else ""


def text(v):
    return TRIM.sub("", v) if isinstance(v, str) else ""


def parse_iso(s):
    """Parse the API's ISO timestamps (with Z or offset) -> aware UTC datetime, else None."""
    if not s or not isinstance(s, str):
        return None
    s = text(s)
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$", s)
    if not m:
        return None
    base, _, off = m.groups()
    if len(base) == 16:
        base += ":00"
    try:
        t = dt.datetime.strptime(base, "%Y-%m-%dT%H:%M:%S")
        if off and off != "Z":
            off = off.replace(":", "")
            sign = 1 if off[0] == "+" else -1
            t = t - sign * dt.timedelta(hours=int(off[1:3]), minutes=int(off[3:5]))
    except (ValueError, OverflowError):  # matches the pattern but isn't a real date/time (month 13, Feb 30, 24:00)
        return None
    return t.replace(tzinfo=dt.timezone.utc)


def slot_minutes(slot):
    """'19:50 - 21:20' -> (1190, 1280, 90); wraps past midnight. None if unparseable."""
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$", slot or "")
    if not m:
        return None
    a = int(m.group(1)) * 60 + int(m.group(2))
    b = int(m.group(3)) * 60 + int(m.group(4))
    return a, b, (b - a) % 1440


def level_num(levels):
    # "(200) Intermediate" in 2026, "Intermediate (200)" in Ignite 2025's published catalog.
    for v in levels:
        m = re.search(r"\((\d{3})\)", v)
        if m:
            return int(m.group(1))
    return None


def window_bounds(window):
    """(first_day, last_day) -> UTC datetimes covering a pre-day and a spare day after."""
    a = dt.datetime.strptime(window[0], "%Y-%m-%d").replace(tzinfo=dt.timezone.utc) - dt.timedelta(days=1)
    b = dt.datetime.strptime(window[1], "%Y-%m-%d").replace(tzinfo=dt.timezone.utc) + dt.timedelta(days=2)
    return a, b


# The one rule for "not published yet" (specs/features/ignite-catalog-sync.feature); live.js
# mirrors it as placeholderRoom / inWindow / hasRoom and tests/test_sync.py keeps them equal.
# A placeholder is kept in the record (roomTbd marks a room label, so a change notice can name
# "Rescheduling 3"), but it is never shown or counted as a room or a time; a placeholder time is
# dropped and counted in draftTimes.

def placeholder_room(room):
    """True for a room that isn't published: blank, a test room ("zTest12"), TBD/TBA, or a holding
    room ("Rescheduling 3"). venues.PLACEHOLDER is the pattern the venue models share."""
    room = text(room)
    return not room or bool(venues.PLACEHOLDER.match(room))


def in_window(t, bounds, end=False):
    """True for a time inside the event window (bounds from window_bounds); a missing time or one
    outside it (Ignite's fake 14 Nov day, a 31 Dec end) is a placeholder. An end may fall on the
    window's closing edge (a session that started inside it ends there), not past it."""
    return t is not None and bounds[0] <= t and (t <= bounds[1] if end else t < bounds[1])


def has_room(rec):
    """A normalized run with a published room (what withRooms and the guards count)."""
    return bool(rec.get("room")) and not rec.get("roomTbd")


def whole_minutes(dur):
    """True for a positive whole number of minutes (45 or 45.0, not True/NaN/'45'), at most a day."""
    if isinstance(dur, bool) or not isinstance(dur, (int, float)):
        return False
    return dur == dur and dur != float("inf") and dur == int(dur) and 0 < dur <= MAX_DUR


def is_test(s, title):
    return (title.lower() in ("test", "testing", "test session")
            or str(s.get("sessionTimeId") or "").lower().endswith("test"))


def normalize(raw_sessions, raw_speakers, window=DEFAULT_WINDOW, by_name=None):
    spk = {p["speakerId"]: p for p in raw_speakers or [] if isinstance(p, dict) and p.get("speakerId")}
    bounds = window_bounds(window)
    out, dropped = [], []
    draft_times = 0
    for s in raw_sessions:
        if not isinstance(s, dict):
            continue  # null/number/list in the feed: not a session (skipped the same way in live.js)
        title = text(s.get("title"))
        sid = "" if s.get("sessionId") in (None, "") else str(s.get("sessionId"))
        if not sid or is_test(s, title):
            dropped.append(text(s.get("sessionCode")) or sid)
            continue
        start = parse_iso(s.get("startDateTime"))
        end = parse_iso(s.get("endDateTime"))
        if start and not in_window(start, bounds):
            draft_times += 1  # placeholder/test schedule: don't present it as real
            start = end = None
        if end and start and not in_window(end, bounds, end=True):
            draft_times += 1  # a placeholder end (31 Dec): the length gives the end instead
            end = None
        if end and (not start or end < start):
            end = None  # an end on its own, or before the start, is noise
        slot = text(s.get("TimeSlot") or s.get("timeSlot"))
        sm = slot_minutes(slot)
        dur = s.get("durationInMinutes")
        if not whole_minutes(dur):
            if start and end:
                dur = int((end - start).total_seconds() // 60)
            else:
                dur = sm[2] if sm else None
        else:
            dur = int(dur)
        if start and not end and dur:
            end = start + dt.timedelta(minutes=dur)
        # speakerNames is the complete list; the speaker feed (via speakerIds) adds company/title
        # but can lag behind, so never drop a name just because its record is missing.
        known = {}
        for spk_id in list_of(s.get("speakerIds")):
            p = spk.get(spk_id) if isinstance(spk_id, str) else None
            if p and text(p.get("displayName")):
                known[text(p["displayName"])] = [text(p["displayName"]), text(p.get("company")), text(p.get("jobTitle"))]
        names = [text(n) for n in text(s.get("speakerNames")).split(",") if text(n)]
        speakers = [known.get(n) or (by_name or {}).get(n) or [n, "", ""] for n in names] or list(known.values())
        room = text(one(s.get("location")))
        viewing = [v.lower() for v in vals(s.get("viewingOptions"))]
        recorded = None
        if any("not" in v and "record" in v for v in viewing):
            recorded = False
        elif any("record" in v for v in viewing):
            recorded = True
        out.append({
            "id": sid,
            "inst": text(str(s.get("sessionInstanceId") if s.get("sessionInstanceId") is not None else "")) or sid,
            "code": text(s.get("sessionCode")),
            "title": title,
            "desc": text(s.get("description")),
            "type": one(s.get("sessionType")),
            "level": level_num(vals(s.get("sessionLevel"))),
            "topics": vals(s.get("topic")),
            "tags": vals(s.get("tags")),
            "audience": vals(s.get("audienceTypes")),
            "delivery": [DELIVERY_NAMES.get(re.sub(r"[^a-z]", "", v.lower()), v) for v in vals(s.get("deliveryTypes"))],
            "recorded": recorded,
            "speakers": speakers,
            "start": iso(start) if start else None,
            "end": iso(end) if end else None,
            "slot": slot or None,
            "dur": dur,
            "room": room or None,
            "roomTbd": placeholder_room(room),
            "popular": bool(s.get("isPopular")),
            "related": [c for c in list_of(s.get("relatedSessionCodes")) if isinstance(c, str) and c],
            "_links": [r.get("sessionCode") for r in list_of(s.get("repeatedSessions"))
                       if isinstance(r, dict) and isinstance(r.get("sessionCode"), str) and r.get("sessionCode")],
        })
    assign_groups(out)
    out.sort(key=lambda r: (r["code"], r["inst"]))
    return out, dropped, draft_times


def assign_groups(recs):
    """Repeat runs show up two ways: as records sharing a sessionId (the 2026 site's model)
    or as separate records BRK101 / BRK101-R1 linked by repeatedSessions (Ignite 2025).
    Give every record a 'group' (the shortest code in the set) and its sibling codes."""
    parent = {}

    def find(c):
        parent.setdefault(c, c)
        while parent[c] != c:
            parent[c] = parent[parent[c]]
            c = parent[c]
        return c

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            keep, drop = sorted((ra, rb), key=lambda c: (len(c), c))
            parent[drop] = keep

    first_code_of_id = {}
    for r in recs:
        code = r["code"] or r["inst"]
        union(REPEAT_SUFFIX.sub("", code) or code, code)
        for link in r.pop("_links"):
            union(code, link)
        if r["id"] in first_code_of_id:
            union(first_code_of_id[r["id"]], code)
        else:
            first_code_of_id[r["id"]] = code
    members = {}
    for r in recs:
        r["group"] = find(r["code"] or r["inst"])
        members.setdefault(r["group"], []).append(r["code"])
    for r in recs:
        r["repeats"] = sorted({c for c in members[r["group"]] if c != r["code"]})


def comparable(rec, field):
    v = rec.get(field)
    if field == "speakers":
        return sorted(p[0] for p in v or [])  # reordering isn't a change
    if field == "desc":
        return hashlib.sha1((v or "").encode("utf-8")).hexdigest()[:10]
    return v


def diff(prev, cur):
    """Compare two normalized lists. Matching is by sessionId (repeat instances paired in time order)."""
    def group(lst):
        g = {}
        for r in lst:
            g.setdefault(r["id"], []).append(r)
        for k in g:
            g[k].sort(key=lambda r: (r.get("start") or "", r["inst"]))
        return g

    pg, cg = group(prev), group(cur)
    added, removed, changed = [], [], []

    def brief(r):
        return {"id": r["id"], "inst": r["inst"], "code": r["code"], "title": r["title"]}

    def compare(o, r):
        f = {}
        for field in TRACKED:
            a, b = comparable(o, field), comparable(r, field)
            if a != b:
                f[field] = True if field == "desc" else [a, b]
        if f:
            changed.append(dict(brief(r), f=f))

    for sid, recs in cg.items():
        olds = pg.get(sid)
        if not olds:
            # New as a whole: one session; its other runs are extra runs (repeat=True).
            added.extend(dict(brief(r), repeat=i > 0) for i, r in enumerate(recs))
            continue
        # Runs keep their instance id; pair leftovers by time only if ids were regenerated.
        old_by_inst = {o["inst"]: o for o in olds}
        left_new = []
        for r in recs:
            o = old_by_inst.pop(r["inst"], None)
            if o is None:
                left_new.append(r)
            else:
                compare(o, r)
        left_old = [o for o in olds if o["inst"] in old_by_inst]
        for o, r in zip(left_old, left_new):
            compare(o, r)
        added.extend(dict(brief(r), repeat=len(recs) > 1) for r in left_new[len(left_old):])
        removed.extend(dict(brief(o), repeat=len(olds) > 1) for o in left_old[len(left_new):])
    for sid, recs in pg.items():
        if sid not in cg:
            removed.extend(dict(brief(r), repeat=i > 0) for i, r in enumerate(recs))
    return added, removed, changed


def stats(lst, draft_times=0):
    return {
        "sessions": len(lst),
        "withDates": sum(1 for r in lst if r.get("start")),
        "withRooms": sum(1 for r in lst if has_room(r)),
        "draftTimes": draft_times,
    }


def read_flags(settings):
    out = {}
    for name, path in FLAGS.items():
        v = settings
        for k in path:
            v = v.get(k) if isinstance(v, dict) else None
        out[name] = v
    out["eventStart"] = settings.get("eventStartDate")
    out["eventEnd"] = settings.get("eventEndDate")
    out["rsvp"] = {r.get("sessionTypeName"): r.get("opensAt") for r in settings.get("rsvpConfiguration") or []
                   if isinstance(r, dict) and r.get("sessionTypeName")}
    return out


def milestones(ps, cs, pflags, cflags):
    m = []
    if ps["withDates"] == 0 and cs["withDates"] > 0:
        m.append("Session dates/times published (%d sessions)" % cs["withDates"])
    if ps["withRooms"] == 0 and cs["withRooms"] > 0:
        m.append("Rooms published (%d sessions)" % cs["withRooms"])
    if ps["withDates"] > 0 and cs["withDates"] == 0:
        m.append("Session dates were withdrawn from the catalog")
    for name, label in FLAG_LABELS.items():
        if pflags and cflags and not pflags.get(name) and cflags.get(name):
            m.append(label)
    return m


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def dump(path, obj, compact=False):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def short(v):
    if isinstance(v, list):
        v = ", ".join(str(x) for x in v)
    s = "—" if v is None or v == "" else str(v)
    return s if len(s) <= 60 else s[:57] + "…"


def short_pair(old, new):
    """short() both sides of a change. When either is a string long enough to be clipped, drop the
    shared opening words first, so a title that only gained a suffix still shows the difference."""
    if not (isinstance(old, str) and isinstance(new, str)) or max(len(old), len(new)) <= 60:
        return short(old), short(new)
    n = len(os.path.commonprefix([old, new]))
    cut = old.rfind(" ", 0, n) + 1
    if n - cut > 40:  # no word break near the difference: keep the 20 characters before it
        cut = n - 20
    lead = "…" if cut else ""
    return short(lead + old[cut:]), short(lead + new[cut:])


def code_span(label):
    """A feed label as a Markdown code span (like session codes), so Markdown in it is inert: line
    endings become spaces (a blank line would end the span) and a backtick becomes an apostrophe."""
    return "`%s`" % re.sub(r"[\r\n]+", " ", label).replace("`", "'")


def summary_markdown(batch, watch):
    lines = ["### 🚨 " + m for m in batch["milestones"]]
    if batch.get("accepted"):
        a = batch["accepted"]
        lines.append("### ⚠️ Catalog accepted by hand (%s): %s" % (a["by"], a["reason"]))
    hit = [x for x in batch["added"] + batch["removed"] + batch["changed"] if x["code"] in watch]
    if hit:
        lines.append("**%d change(s) affect sessions on your watchlist:** %s"
                     % (len(hit), ", ".join(sorted({x["code"] for x in hit}))))
    # A room in a building the venue model doesn't know (scripts/venues.py): walking times to
    # it are guessed until assets/js/venue.js learns the building. Batches logged before this
    # notice existed have no such key.
    unknown = batch.get("unknownRooms") or []
    if unknown:
        lines.append("**%s:** %s" % (venues.count_phrase(len(unknown)), ", ".join(code_span(r) for r in unknown)))
    # An extra run added to or dropped from a session (repeat=True; the session itself may be new or gone) is
    # reported apart from sessions added or removed, so it never reads as a cancellation.
    groups = {(key, run): [x for x in batch[key] if bool(x.get("repeat")) == run]
              for key in ("added", "removed") for run in (False, True)}
    line = "Added %d · removed %d · changed %d" % (len(groups["added", False]), len(groups["removed", False]), len(batch["changed"]))
    for (key, verb) in (("added", "added"), ("removed", "dropped")):
        n = len(groups[key, True])
        if n:
            line += " · %d extra run%s %s" % (n, "" if n == 1 else "s", verb)
    lines.append(line)

    def fmt(x):
        return "%s`%s` %s" % ("⭐ " if x["code"] in watch else "", x["code"], x["title"])

    for label, key, run in (("Added", "added", False), ("Removed", "removed", False),
                            ("Extra runs added", "added", True),
                            ("Extra runs dropped", "removed", True)):
        items = groups[key, run]
        if items:
            lines.append("\n**%s**" % label)
            lines.extend("- " + fmt(x) for x in items[:60])
            if len(items) > 60:
                lines.append("- …and %d more" % (len(items) - 60))
    if batch["changed"]:
        lines.append("\n**Changed**")
        rows = sorted(batch["changed"], key=lambda x: (x["code"] not in watch, x["code"]))
        for x in rows[:80]:
            parts = [k if v is True else "%s: %s → %s" % ((k,) + short_pair(*v)) for k, v in x["f"].items()]
            lines.append("- %s — %s" % (fmt(x), "; ".join(parts)))
        if len(rows) > 80:
            lines.append("- …and %d more" % (len(rows) - 80))
    return "\n".join(lines) + "\n"


def day_or_none(v):
    """'2026-11-17T08:00:00-08:00' -> '2026-11-17'; None for blanks/placeholders ('', 'TBD')."""
    if not isinstance(v, str) or not re.match(r"^\d{4}-\d{2}-\d{2}", v):
        return None
    try:
        dt.datetime.strptime(v[:10], "%Y-%m-%d")
    except ValueError:
        return None
    return v[:10]


def event_window(args, flags):
    if args.event_window:
        a, b = args.event_window.split(":")
        return a, b
    # Like live.js liveWindow: unusable or reversed site dates mean the configured default.
    a, b = day_or_none((flags or {}).get("eventStart")), day_or_none((flags or {}).get("eventEnd"))
    return (a, b) if a and b and a <= b else DEFAULT_WINDOW


def session_stats(lst):
    """Sessions (not runs) with a time / a room: a session counts if any of its runs has one."""
    return {
        "withDates": len({r["id"] for r in lst if r.get("start")}),
        "withRooms": len({r["id"] for r in lst if has_room(r)}),
    }


def withdrawal(ps, cs):
    """Why the new catalog looks like a broken feed rather than a real withdrawal, or None.
    A renamed time/room field keeps the session count but empties those fields."""
    for key, what in (("withDates", "dates"), ("withRooms", "rooms")):
        if ps[key] > 0 and cs[key] < 0.5 * ps[key]:
            return ("sessions with %s fell from %d to %d; keeping last good data "
                    "(rerun with --allow-withdrawal if this is real)" % (what, ps[key], cs[key]))
    return None


MALFORMED_SHARE = 0.05  # same limit in live.js

# The fields the app relies on, each with the shapes it is read in (blank always allowed: an
# unpublished room or time is blank). Any other shape on more than SHAPE_SHARE of the records
# means the feed format changed (a renamed or restructured field, as `location` did in Oct 2026):
# the catalog is refused instead of being read as empty. Mirrored in live.js (fieldShapes).
SHAPE_FIELDS = ("sessionId", "sessionInstanceId", "title", "location", "startDateTime")
SHAPE_ACCEPTED = {
    "sessionId": ("text", "number"),
    "sessionInstanceId": ("text", "number"),
    "title": ("text", "object", "list"),
    "location": ("text", "object", "list"),
    "startDateTime": ("text",),
}
SHAPE_SHARE = 0.05  # same limit in live.js


def value_shape(v):
    """blank | text | number | object (has a displayValue) | list (of those) | unknown."""
    if v is None or v == "" or v == []:
        return "blank"
    if isinstance(v, bool):
        return "unknown"
    if isinstance(v, (int, float)):
        # Only a number the browser can also hold: JSON's 1e400 or an integer beyond a double
        # is Infinity there, which live.js calls unknown; agree with it.
        try:
            return "number" if math.isfinite(float(v)) else "unknown"
        except OverflowError:
            return "unknown"
    if isinstance(v, str):
        return "text"
    if isinstance(v, dict):
        return "object" if isinstance(v.get("displayValue"), str) else "unknown"
    if isinstance(v, list):
        return "list" if all(isinstance(x, str) or (isinstance(x, dict) and isinstance(x.get("displayValue"), str)) for x in v) else "unknown"
    return "unknown"


def js_number(v):
    """A finite number as JavaScript's Number.prototype.toString prints it (ECMAScript 6.1.6.1.20):
    the shortest round-trip digits (which Python's repr also produces), whole numbers below 1e21
    without a point or exponent, a point for 1e-6 and above, an exponent (1e+21, 1e-7) otherwise."""
    x = float(v)
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    mant, _, exp = repr(abs(x)).partition("e")
    whole, _, frac = mant.partition(".")
    digits = (whole + frac).lstrip("0")
    n = len(whole) + (int(exp) if exp else 0) - (len(whole + frac) - len(digits))  # decimal point sits after n digits
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    return sign + digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))


def js_json(v):
    """JSON.stringify's output for a parsed JSON value: numbers as JavaScript prints them, a number
    the browser cannot hold as null (as it does), keys in their order, non-ASCII text kept."""
    if v is None or isinstance(v, bool):
        return "null" if v is None else ("true" if v else "false")
    if isinstance(v, (int, float)):
        try:
            return js_number(v) if math.isfinite(float(v)) else "null"
        except OverflowError:
            return "null"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(js_json(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + js_json(x) for k, x in v.items()) + "}"
    return json.dumps(str(v), ensure_ascii=False)


def shape_example(v):
    """The example value in the refusal, as the browser would print it (JSON, at most 60 chars);
    a number the browser cannot hold prints as Infinity on both sides."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and value_shape(v) == "unknown":
        return "Infinity"
    return js_json(v)[:60]


def field_shapes(raw_sessions):
    """Per relied-upon field: the records read, how many carry an unrecognised shape, one example."""
    recs = [s for s in (raw_sessions if isinstance(raw_sessions, list) else []) if isinstance(s, dict)]
    out = {}
    for f in SHAPE_FIELDS:
        unknown = [s.get(f) for s in recs if value_shape(s.get(f)) not in ("blank",) + SHAPE_ACCEPTED[f]]
        example = shape_example(unknown[0]) if unknown else None
        out[f] = {"records": len(recs), "unknown": len(unknown), "example": example}
    return out


def shape_problem(shapes, share=SHAPE_SHARE):
    """Why the feed looks like a format change, or None (same wording in live.js)."""
    for f in SHAPE_FIELDS:
        sh = shapes.get(f) or {}
        if sh.get("records") and sh.get("unknown", 0) > share * sh["records"]:
            return ("feed format changed: `%s` has an unrecognised shape in %d of %d sessions (e.g. %s); keeping last good data"
                    % (f, sh["unknown"], sh["records"], sh["example"]))
    return None


GUARD_TITLES = {"partial": "partial catalog", "withdrawal": "dates or rooms withdrawn",
                "shape": "feed format changed", "malformed": "malformed feed"}
ACCEPTABLE = ("partial", "withdrawal")   # a format change needs code, not acceptance
EXAMPLES = 10


def _placeholder(r):
    """A run that was never really published: a placeholder room and no time."""
    return not has_room(r) and not r.get("start")


def refusal(guard, message, prev, cur=None):
    """Why a catalog was refused, with what the guard saw: the counts before and after, the
    sessions that went missing (or that lost a room or time), examples of them, and whether
    every missing session was a placeholder. `cur` is None when the feed could not be read."""
    prev = prev or []
    by_id = {}
    for r in prev:
        by_id.setdefault(r["id"], []).append(r)
    cur_ids = {r["id"] for r in (cur or [])}
    missing = [sid for sid in by_id if sid not in cur_ids] if cur is not None else []
    had = lambda runs, k: any(has_room(r) if k == "room" else r.get(k) for r in runs)  # noqa: E731
    cur_by_id = {}
    for r in cur or []:
        cur_by_id.setdefault(r["id"], []).append(r)
    emptied = [sid for sid, runs in by_id.items() if sid in cur_by_id
               and ((had(runs, "room") and not had(cur_by_id[sid], "room")) or (had(runs, "start") and not had(cur_by_id[sid], "start")))]
    examples = [{"code": by_id[sid][0]["code"], "title": by_id[sid][0]["title"], "room": by_id[sid][0].get("room") or ""}
                for sid in (missing or emptied)[:EXAMPLES]]
    counts = lambda lst: {"sessions": len({r["id"] for r in lst}), "runs": len(lst)}  # noqa: E731
    return {
        "guard": guard, "message": message,
        "before": counts(prev), "after": counts(cur) if cur is not None else None,
        "missing": len(missing), "emptied": len(emptied), "examples": examples,
        "allPlaceholders": all(all(_placeholder(r) for r in by_id[sid]) for sid in missing) if missing else None,
    }


def refusal_markdown(r):
    """The diagnosis for the production issue (and the run log)."""
    lines = ["### Catalog refused: %s" % GUARD_TITLES.get(r["guard"], r["guard"]), r["message"], ""]
    b, a = r["before"], r.get("after")
    if a:
        lines.append("- Sessions: %d → %d (runs %d → %d)" % (b["sessions"], a["sessions"], b["runs"], a["runs"]))
    else:
        lines.append("- Sessions in the last good catalog: %d (runs %d); the feed could not be read" % (b["sessions"], b["runs"]))
    lines.append("- Missing sessions: %d; sessions that lost a room or time: %d" % (r["missing"], r["emptied"]))
    if r.get("allPlaceholders") is not None:
        lines.append("- Was every missing session a placeholder: %s" % ("yes" if r["allPlaceholders"] else "no"))
    if r["examples"]:
        what = "missing" if r["missing"] else "emptied"
        lines.append("- Examples (%s): " % what + "; ".join("`%s` %s%s" % (x["code"], x["title"], " (%s)" % x["room"] if x["room"] else "") for x in r["examples"]))
        total = r["missing"] or r["emptied"]
        if total > len(r["examples"]):
            lines.append("- …and %d more" % (total - len(r["examples"])))
    if r["guard"] in ACCEPTABLE:
        lines.append("- If this is real, accept it from the Actions tab: run the workflow with `accept: %s`." % r["guard"])
    else:
        lines.append("- This needs a code change (the feed's shape, not its content, changed); acceptance does not apply.")
    return "\n".join(lines) + "\n"


def run(args):
    now = utcnow()
    data = os.path.abspath(args.data_dir) if args.data_dir else DATA
    os.makedirs(data, exist_ok=True)
    spath = os.path.join(data, "sessions.json")
    cpath = os.path.join(data, "changes.json")
    mpath = os.path.join(data, "meta.json")
    prev_doc = load(spath, None)
    prev = prev_doc["sessions"] if prev_doc else []
    changes = load(cpath, {"batches": []})
    meta = load(mpath, {})
    meta["lastChecked"] = iso(now)

    # What the owner accepted for this run (--accept partial|withdrawal; --allow-withdrawal is the
    # older spelling), who they are, and the diagnosis if a guard refuses after all.
    accept = set(getattr(args, "accept", None) or [])
    if getattr(args, "allow_withdrawal", False):
        accept.add("withdrawal")
    accepts = lambda kind: kind in accept  # noqa: E731
    actor = getattr(args, "accepted_by", None) or os.environ.get("GITHUB_ACTOR") or "local"
    accept_note = lambda kind, why: {"guard": kind, "by": actor, "at": iso(now), "reason": why}  # noqa: E731
    accepted = None
    refused = None

    try:
        if args.from_file:
            raw, src = load(args.from_file, None), args.from_file
            raw_spk = load(args.speakers_file, []) if args.speakers_file else []
            flags = load(args.settings_file, None) if args.settings_file else None
            flags = read_flags(flags) if isinstance(flags, dict) else meta.get("siteFlags")
        else:
            raw, src = fetch_first("sessions")
            try:
                raw_spk, _ = fetch_first("speakers")
            except RuntimeError as e:
                print("warning: speakers unavailable:", e, file=sys.stderr)
                raw_spk = []
            try:
                flags = read_flags(fetch_first("settings")[0])
            except (RuntimeError, AttributeError) as e:
                print("warning: site settings unavailable:", e, file=sys.stderr)
                flags = meta.get("siteFlags")
        if not isinstance(raw, list):
            raise RuntimeError("unexpected catalog payload (not a list)")
        # A feed with many non-session entries is broken, not a list of cancellations.
        # (Test sessions are dropped on purpose later; an entry with no session id isn't one.)
        bad = sum(1 for s in raw if not isinstance(s, dict) or s.get("sessionId") in (None, ""))
        if raw and bad > MALFORMED_SHARE * len(raw):
            raise RuntimeError("%d of %d catalog entries are malformed; keeping last good data" % (bad, len(raw)))
        # A field we rely on in a shape we have never read is a format change, not many blanks.
        shape_why = shape_problem(field_shapes(raw))
        if shape_why:
            refused = refusal("shape", shape_why, prev)
            raise RuntimeError(shape_why)
        # If the speaker feed is down, keep companies/titles from the last snapshot.
        by_name = {p[0]: p for r in prev for p in r.get("speakers") or [] if p[1] or p[2]}
        cur, dropped, draft = normalize(raw, raw_spk, event_window(args, flags or {}), by_name)
        # Guard: an outage or partial index must not look like hundreds of cancellations.
        # It counts sessions, not runs: dropping a session's extra run (Ignite deleted its
        # placeholder runs once rooms were published) loses nothing. Same rule in live.js.
        # The owner can accept a real shrink for one run (--accept partial); the 50-session
        # floor stays, since that is a broken feed, not a smaller catalog.
        n_cur, n_prev = len({r["id"] for r in cur}), len({r["id"] for r in prev})
        if n_cur < 50 or (prev and n_cur < 0.6 * n_prev):
            why = "catalog returned %d sessions (previously %d); keeping last good data" % (n_cur, n_prev)
            if n_cur >= 50 and accepts("partial"):
                accepted = accept_note("partial", why)
            else:
                refused = refusal("partial", why, prev, cur)
                raise RuntimeError(why)
        # The withdrawal guard asks whether the sessions still listed lost their rooms or times;
        # after an accepted shrink it must not count the sessions that went with the shrink.
        base = [r for r in prev if r["id"] in {x["id"] for x in cur}] if accepted else prev
        why = withdrawal(session_stats(base), session_stats(cur)) if prev else None
        if why:
            if accepts("withdrawal"):
                accepted = accepted or accept_note("withdrawal", why)
            else:
                refused = refusal("withdrawal", why, prev, cur)
                raise RuntimeError(why)
    except RuntimeError as e:
        meta.update({"ok": False, "error": str(e)})
        meta.pop("accepted", None)
        if refused:
            meta["refusal"] = refused
            if getattr(args, "refusal_out", None):
                with open(args.refusal_out, "w", encoding="utf-8") as f:
                    f.write(refusal_markdown(refused))
        else:
            meta.pop("refusal", None)
        dump(mpath, meta)
        print("sync failed:", e, file=sys.stderr)
        return 3, False
    meta.pop("refusal", None)

    # Carry "firstSeen" forward so the app can badge new sessions.
    # Sessions present in the baseline snapshot keep firstSeen = None ("always there").
    seen = {r["inst"]: r.get("firstSeen") for r in prev}
    seen_by_id = {r["id"]: r.get("firstSeen") for r in prev}
    for r in cur:
        if r["inst"] in seen:
            r["firstSeen"] = seen[r["inst"]]
        elif r["id"] in seen_by_id:
            r["firstSeen"] = seen_by_id[r["id"]]
        else:
            r["firstSeen"] = iso(now) if prev else None

    # Site flags are kept in sessions.json (committed) so flips are detected across CI runs.
    prev_flags = (prev_doc or {}).get("siteFlags") or meta.get("siteFlags")
    flags = flags or prev_flags
    added, removed, changed = diff(prev, cur) if prev else ([], [], [])
    ps, cs = stats(prev), stats(cur, draft)
    ms = milestones(ps, cs, prev_flags, flags) if prev else []
    generated = (prev_doc or {}).get("generatedAt")
    # "Last changed" means a change the app shows (sessions added/removed/retimed/moved or a
    # milestone), not untracked churn such as popularity flags or firstSeen stamps.
    changed_at = (prev_doc or {}).get("changedAt") or generated
    if (not prev_doc) or added or removed or changed or ms:
        changed_at = iso(now)
    if (not prev_doc) or prev != cur or prev_doc.get("dropped") != dropped or prev_doc.get("siteFlags") != flags \
            or prev_doc.get("changedAt") != changed_at:
        dump(spath, {"generatedAt": iso(now), "changedAt": changed_at, "source": src, "dropped": dropped,
                     "siteFlags": flags, "stats": cs, "sessions": cur}, compact=True)
        generated = iso(now)
    # meta.json isn't committed, so derive "last change" from committed data, not from now.
    meta["lastChanged"] = changed_at
    batch = None
    # Rooms in a building the venue model doesn't know, new since the last snapshot: they always
    # come with a session added or a room change, so they ride in that batch and are named once.
    unknown = venues.unknown_rooms(VENUE, cur, prev)
    if added or removed or changed or ms:
        batch = {"at": iso(now), "milestones": ms, "added": added, "removed": removed, "changed": changed,
                 "unknownRooms": unknown}
        if accepted:
            batch["accepted"] = accepted   # who took a guard's refusal on themselves, and why
        changes["batches"].insert(0, batch)
        del changes["batches"][MAX_BATCHES:]
        dump(cpath, changes)
    elif not os.path.exists(cpath):
        dump(cpath, changes)
    meta.update({"ok": True, "error": None, "stats": cs, "source": src})
    if accepted:
        meta["accepted"] = accepted
    else:
        meta.pop("accepted", None)
    if flags:
        meta["siteFlags"] = flags
    meta["lastLogged"] = changes["batches"][0]["at"] if changes["batches"] else None
    dump(mpath, meta)

    watch = set(load(os.path.join(data, "watchlist.json"), {}).get("codes", []))
    if batch and args.summary_out:
        with open(args.summary_out, "w", encoding="utf-8") as f:
            f.write(summary_markdown(batch, watch))
    print(console_summary(cs, draft, added, removed, changed, ms, unknown))
    return 0, bool(batch)


def console_summary(stats, draft, added, removed, changed, milestones, unknown=()):
    """One line for the run log. Sessions and extra runs are counted apart: a dropped extra run
    (repeat=True) of a session that stays listed is not a removed session."""
    def sessions(xs):
        return sum(1 for x in xs if not x.get("repeat"))
    def runs(xs):
        return sum(1 for x in xs if x.get("repeat"))
    line = "sessions=%d dates=%d rooms=%d draft=%d | added=%d removed=%d changed=%d" % (
        stats["sessions"], stats["withDates"], stats["withRooms"], draft, sessions(added), sessions(removed), len(changed))
    if runs(added) or runs(removed):
        line += " | extra runs: added=%d dropped=%d" % (runs(added), runs(removed))
    if milestones:
        line += " | " + "; ".join(milestones)
    if unknown:
        line += " | " + venues.notice(unknown, "; ")
    return line


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from-file", help="read the sessions API response from a file")
    ap.add_argument("--speakers-file", help="read the speakers API response from a file")
    ap.add_argument("--settings-file", help="read the site settings response from a file")
    ap.add_argument("--event-window", help="FIRST:LAST conference days (YYYY-MM-DD:YYYY-MM-DD); "
                                           "default: from the site settings")
    ap.add_argument("--summary-out", help="write a markdown change summary here when something changed")
    ap.add_argument("--data-dir", help="output directory (default: data/ignite2026/ in the repo)")
    ap.add_argument("--allow-withdrawal", action="store_true",
                    help="accept a catalog in which more than half of the published dates/rooms disappeared (same as --accept withdrawal)")
    ap.add_argument("--accept", action="append", choices=list(ACCEPTABLE), default=[],
                    help="take a guard's refusal on yourself for this run only: partial (fewer sessions, above the 50-session floor) "
                         "or withdrawal (dates/rooms gone); logged in changes.json with who accepted it")
    ap.add_argument("--accepted-by", help="who accepts (default: $GITHUB_ACTOR, else 'local')")
    ap.add_argument("--refusal-out", help="write the diagnosis of a refused catalog here (markdown, for the production issue)")
    args = ap.parse_args()
    try:
        code, changed = run(args)
    except Exception as e:  # never leave CI green-but-silent on an unexpected payload
        code, changed = 3, False
        data = os.path.abspath(args.data_dir) if args.data_dir else DATA
        mpath = os.path.join(data, "meta.json")
        meta = load(mpath, {})
        meta.update({"ok": False, "error": "%s: %s" % (type(e).__name__, e), "lastChecked": iso(utcnow())})
        os.makedirs(data, exist_ok=True)
        dump(mpath, meta)
        import traceback
        traceback.print_exc()
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write("changed=%s\n" % ("true" if changed else "false"))
    sys.exit(code)


if __name__ == "__main__":
    main()
