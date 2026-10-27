"""Which building a published room is in, for the sync and import scripts.

A Python mirror of the building patterns in assets/js/venue.js and assets/js/conferences.js:
the browser uses them for walking times, the scripts use them to notice a room in a building
the venue model doesn't know (a sponsor venue, a new hotel) and say so in the change summary.
Keep the two in step: tests/test_venues.py runs every published room through both.
"""
import re

CONFERENCE_VENUES = {"ignite2026": "moscone", "gartner2026": "swan-dolphin", "reinvent2026": "las-vegas"}

# A room that is not a room yet (same as PLACEHOLDER_ROOM in sync.py and `placeholder` in venue.js).
PLACEHOLDER = re.compile(r"^(ztest\S*|tbd|tba)$", re.I)

# Buildings per venue, in the order the browser tests them (the first match wins).
BUILDINGS = {
    "moscone": [
        ("W", r"moscone\s*west|^west\b"),
        ("S", r"moscone\s*south|^south\b|esplanade"),
        ("N", r"moscone\s*north|^north\b"),
        ("M", r"marriott|marquis"),
        ("C", r"chase\s*center"),
        ("E", r"metreon|\baviary\b"),
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


def building(venue, room):
    """The building id of a room label, or None when it is blank, a placeholder or in no known building."""
    label = room.strip() if isinstance(room, str) else ""
    if not label or PLACEHOLDER.match(label):
        return None
    for bid, pattern in _COMPILED[venue]:
        if pattern.search(label):
            return bid
    return None


def count_phrase(n):
    """'1 room in an unknown building' / '2 rooms in an unknown building'."""
    return "%d room%s in an unknown building" % (n, "" if n == 1 else "s")


def notice(rooms, sep=", "):
    """'2 rooms in an unknown building: A, B' for the run log; '' when there are none."""
    return count_phrase(len(rooms)) + ": " + sep.join(rooms) if rooms else ""


def unknown_rooms(venue, cur, prev=()):
    """Distinct room labels of cur in no known building that prev did not have, in label order.
    Placeholders and blanks are not rooms. Reporting only rooms new since the last snapshot
    announces a new venue once, in the batch where it appears."""
    seen = {r.get("room") for r in prev}
    rooms = {r.get("room") for r in cur} - seen
    return sorted(room for room in rooms if isinstance(room, str) and room.strip()
                  and not PLACEHOLDER.match(room.strip()) and building(venue, room) is None)
