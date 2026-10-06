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
import os
import re
import sys
import time
import urllib.error
import urllib.request

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
MAX_BATCHES = 400
# Used when the site settings can't be fetched. Times outside the event window are
# treated as placeholders (the 2026 index already holds fake times on Nov 14).
DEFAULT_WINDOW = ("2026-11-17", "2026-11-20")
# Fields compared between snapshots, in display order. "desc" changes are flagged, not stored.
TRACKED = ["title", "code", "type", "start", "end", "dur", "room", "speakers",
           "level", "delivery", "recorded", "desc"]
# The catalog has spelled these differently across years ("In person" vs "In-person").
DELIVERY_NAMES = {"inperson": "In-person", "online": "Online", "ondemand": "On-demand"}
PLACEHOLDER_ROOM = re.compile(r"^(ztest\S*|tbd|tba|)$", re.I)
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
    """Try the API, then the CDN copy the official site falls back to."""
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
    lo, hi = window_bounds(window)
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
        if start and not (lo <= start < hi):
            draft_times += 1  # placeholder/test schedule: don't present it as real
            start = end = None
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
            "roomTbd": bool(PLACEHOLDER_ROOM.match(room)),
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
            added.extend(brief(r) for r in recs)
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
            removed.extend(brief(r) for r in recs)
    return added, removed, changed


def stats(lst, draft_times=0):
    return {
        "sessions": len(lst),
        "withDates": sum(1 for r in lst if r.get("start")),
        "withRooms": sum(1 for r in lst if r.get("room") and not r.get("roomTbd")),
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


def summary_markdown(batch, watch):
    lines = ["### 🚨 " + m for m in batch["milestones"]]
    hit = [x for x in batch["added"] + batch["removed"] + batch["changed"] if x["code"] in watch]
    if hit:
        lines.append("**%d change(s) affect sessions on your watchlist:** %s"
                     % (len(hit), ", ".join(sorted({x["code"] for x in hit}))))
    lines.append("Added %d · removed %d · changed %d" % (len(batch["added"]), len(batch["removed"]), len(batch["changed"])))

    def fmt(x):
        return "%s`%s` %s" % ("⭐ " if x["code"] in watch else "", x["code"], x["title"])

    for label, key in (("Added", "added"), ("Removed", "removed")):
        if batch[key]:
            lines.append("\n**%s**" % label)
            lines.extend("- " + fmt(x) for x in batch[key][:60])
            if len(batch[key]) > 60:
                lines.append("- …and %d more" % (len(batch[key]) - 60))
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
    # Like live.js: unusable site dates mean the configured default, never a crash.
    a, b = day_or_none((flags or {}).get("eventStart")), day_or_none((flags or {}).get("eventEnd"))
    return (a, b) if a and b else DEFAULT_WINDOW


def withdrawal(ps, cs):
    """Why the new catalog looks like a broken feed rather than a real withdrawal, or None.
    A renamed time/room field keeps the session count but empties those fields."""
    for key, what in (("withDates", "dates"), ("withRooms", "rooms")):
        if ps[key] > 0 and cs[key] < 0.5 * ps[key]:
            return ("sessions with %s fell from %d to %d; keeping last good data "
                    "(rerun with --allow-withdrawal if this is real)" % (what, ps[key], cs[key]))
    return None


MALFORMED_SHARE = 0.05  # same limit in live.js


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
        # If the speaker feed is down, keep companies/titles from the last snapshot.
        by_name = {p[0]: p for r in prev for p in r.get("speakers") or [] if p[1] or p[2]}
        cur, dropped, draft = normalize(raw, raw_spk, event_window(args, flags or {}), by_name)
        # Guard: an outage or partial index must not look like hundreds of cancellations.
        if len(cur) < 50 or (prev and len(cur) < 0.6 * len(prev)):
            raise RuntimeError("catalog returned %d sessions (previously %d); keeping last good data"
                               % (len(cur), len(prev)))
        why = withdrawal(stats(prev), stats(cur)) if prev and not getattr(args, "allow_withdrawal", False) else None
        if why:
            raise RuntimeError(why)
    except RuntimeError as e:
        meta.update({"ok": False, "error": str(e)})
        dump(mpath, meta)
        print("sync failed:", e, file=sys.stderr)
        return 3, False

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
    if added or removed or changed or ms:
        batch = {"at": iso(now), "milestones": ms, "added": added, "removed": removed, "changed": changed}
        changes["batches"].insert(0, batch)
        del changes["batches"][MAX_BATCHES:]
        dump(cpath, changes)
    elif not os.path.exists(cpath):
        dump(cpath, changes)
    meta.update({"ok": True, "error": None, "stats": cs, "source": src})
    if flags:
        meta["siteFlags"] = flags
    meta["lastLogged"] = changes["batches"][0]["at"] if changes["batches"] else None
    dump(mpath, meta)

    watch = set(load(os.path.join(data, "watchlist.json"), {}).get("codes", []))
    if batch and args.summary_out:
        with open(args.summary_out, "w", encoding="utf-8") as f:
            f.write(summary_markdown(batch, watch))
    print("sessions=%d dates=%d rooms=%d draft=%d | added=%d removed=%d changed=%d%s"
          % (cs["sessions"], cs["withDates"], cs["withRooms"], draft, len(added), len(removed), len(changed),
             (" | " + "; ".join(ms)) if ms else ""))
    return 0, bool(batch)


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
                    help="accept a catalog in which more than half of the published dates/rooms disappeared")
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
