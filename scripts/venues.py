"""Which building a published room is in, for the sync and import scripts.

A Python mirror of the building patterns in assets/js/venue.js and assets/js/conferences.js:
the browser uses them for walking times, the scripts use them to notice a room in a building
the venue model doesn't know (a sponsor venue, a new hotel) and say so in the change summary.
Keep the two in step: tests/test_venues.py runs every published room through both.
"""
import re

CONFERENCE_VENUES = {"ignite2026": "moscone", "gartner2026": "swan-dolphin", "reinvent2026": "las-vegas"}

# A room that is not a room yet (sync.py's placeholder_room uses it and adds blanks; the same pattern
# as PLACEHOLDER_ROOM in venue.js, which live.js imports): test rooms, TBD/TBA, and
# "Rescheduling 3" / "Rescheduling Room", where Microsoft parks a session while it moves it.
# Python's \s, '.', '$' and re.I read some characters differently from JavaScript's (\x1c and
# \x85 are spaces only to Python, \ufeff only to JavaScript; ſ and ı fold to s and i; '$' also
# matches before a final newline), so the pattern spells them out: _JS_SPACE is the body of
# JavaScript's \s, '.' becomes JavaScript's (anything but a line break), re.ASCII keeps the case
# folding to A-Z, and \Z ends the label. tests/test_sync.py runs every BMP character through both.
_JS_SPACE = "\t\n\x0b\x0c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
PLACEHOLDER = re.compile(r"^(ztest[^%s]*|tbd|tba|rescheduling([%s][^\n\r\u2028\u2029]*)?)\Z"
                         % (_JS_SPACE, _JS_SPACE), re.I | re.ASCII)

# Buildings per venue, in the order the browser tests them (the first match wins).
BUILDINGS = {
    "moscone": [
        ("W", r"moscone\s*west|^west\b"),
        ("S", r"moscone\s*south|^south\b|esplanade"),
        ("N", r"moscone\s*north|^north\b"),
        ("M", r"marriott|marquis"),
        ("C", r"chase\s*center"),
        ("E", r"metreon|\baviary\b"),
        ("D", r"dimes\s*gallery"),
        ("H", r"intercontinental|hilton|hyatt|westin|park central|four seasons|st\.? regis|yerba buena (center|gardens)|sfmoma|\bw hotel"),
        ("O", r"^(online|virtual|on[- ]demand$)"),
    ],
    "swan-dolphin": [
        ("D", r"dolphin|atlantic hall|pacific (hall|terrace)|hemisphere|central pavilion|(upper|lower) peninsula|peninsula|oceanic|\b(asia|europe|australia)\s*\d|\bamericas\b|\bbay room\b|it ?xpo"),
        ("R", r"swan\s*reserve|\boasis\b|\binlet\b|\breef\b|\blagoon\b|\bvue\b|\bharbor\s*[1-5]\b"),
        ("S", r"\bswan\b|\b(lark|mockingbird|osprey|pelican|toucan|macaw|parrot|peacock|cockatoo|hummingbird)\b|\b(dove|egret|heron|ibis|sandpiper|teal)\b|eagle boardroom|lake view"),
        ("Y", r"yacht|beach (club|resort)|grand harbor|\b(asbury|cape cod|newport|hampton|saybrook|seaview|bourne|stonington|wellfleet|eastham|nantucket|martha)\b"),
        ("B", r"boardwalk"),
        ("H", r"hollywood studios|epcot|magic kingdom|animal kingdom|disney springs|west pavill?ion"),
        ("O", r"^(online|virtual|on[- ]demand$)"),
    ],
    "las-vegas": [
        ("V", r"^\s*(venetian|palazzo)"),
        ("W", r"^\s*(wynn|encore)"),
        ("C", r"^\s*caesars\s+palace"),
        ("F", r"^\s*caesars\s+forum"),
        ("M", r"^\s*mgm"),
        ("O", r"^(online|virtual|on[- ]demand$)"),
    ],
}
_COMPILED = {venue: [(bid, re.compile(pat, re.I)) for bid, pat in buildings] for venue, buildings in BUILDINGS.items()}


def room_label(v):
    """The usable room label of a stored value: trimmed, non-blank, not a placeholder; else None.
    A non-string (a hand-edited snapshot, a feed quirk) is no room. The normalizers already count
    malformed records, so a bad room value is skipped here without a second count."""
    label = v.strip() if isinstance(v, str) else ""
    return label if label and not PLACEHOLDER.match(label) else None


def building(venue, room):
    """The building id of a room label, or None when it is blank, a placeholder or in no known building."""
    label = room_label(room)
    if label is None:
        return None
    for bid, pattern in _COMPILED[venue]:
        if pattern.search(label):
            return bid
    return None


def count_phrase(n):
    """'1 room in an unknown building' / '2 rooms in an unknown building'."""
    return "%d room%s in an unknown building" % (n, "" if n == 1 else "s")


def notice(rooms, sep=", "):
    """'2 rooms in an unknown building: A, B' for the run log; '' when there are none. A label is
    one line of the log: line endings inside it (a feed quirk) become spaces."""
    return count_phrase(len(rooms)) + ": " + sep.join(re.sub(r"[\r\n]+", " ", r) for r in rooms) if rooms else ""


def unknown_rooms(venue, cur, prev=()):
    """Distinct room labels of cur in no known building that prev did not have, in label order.
    Placeholders and blanks are not rooms. Reporting only rooms new since the last snapshot
    announces a new venue once, in the batch where it appears."""
    seen = {room_label(r.get("room")) for r in prev}
    rooms = {room_label(r.get("room")) for r in cur} - seen - {None}
    return sorted(room for room in rooms if building(venue, room) is None)
