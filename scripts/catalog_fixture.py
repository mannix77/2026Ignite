#!/usr/bin/env python3
"""Build the test fixture of the re:Invent 2026 catalog with placeholder abstracts.

The catalog sits behind attendee sign-in and this repository is public, so the fixture keeps
only what the tests need (no speakers, rooms or seat counts), and every abstract is replaced by
placeholder text. The placeholder is written from the session's own title, type, level, topics
and services, in the catalog's style, at the real abstract's length, so token counts match real
data. It is assembled from a pool of sentences, so it reads like an abstract but is not a
substitute for real ones when judging the quality of a model's answers. Nothing of the real
abstract is kept except its length.

Usage (the export stays outside the repository):

    python3 -I scripts/catalog_fixture.py <ListSessions pages, JSON, with abstracts>... \
        > ios/PlannerCore/Tests/PlannerCoreTests/Fixtures/reinvent2026-catalog.json

The output is the same for the same input: choices are seeded by each session's id.
"""

import hashlib
import json
import random
import sys

KEEP = ["sessionId", "title", "abbreviation", "type", "level", "venue", "isAllDaySession",
        "isReservable", "sessionTime", "topics", "services"]

# Openers for a title that names a subject ("Amazon Aurora DSQL deep dive") and for one that
# says what you'll do ("Build an agent ...", "How Kiro learns ..."), which reads as "how to ...".
OPENERS = {
    "Breakout session": {"noun": ["In this session, learn about {t}.", "This session explores {t}.",
                                  "Join this session for a closer look at {t}."],
                         "how": ["In this session, learn {t}.", "Join this session to discover {t}."]},
    "Chalk talk": {"noun": ["In this chalk talk, we whiteboard {t}.", "Join this chalk talk to dive deep into {t}."],
                   "how": ["In this chalk talk, we whiteboard {t}.", "Join this interactive chalk talk to explore {t}."]},
    "Workshop": {"noun": ["In this workshop, get hands-on with {t}.", "This hands-on workshop walks you through {t}."],
                 "how": ["In this workshop, learn {t}, step by step.", "This hands-on workshop shows you {t}."]},
    "Builders' session": {"noun": ["In this small-group builders' session, work hands-on with {t}."],
                          "how": ["In this small-group builders' session, learn {t} alongside an AWS expert."]},
    "Lightning talk": {"noun": ["In this lightning talk, get a fast look at {t}.", "This short talk covers {t}."],
                       "how": ["In this lightning talk, see {t}.", "This short talk shows {t}."]},
    "Code talk": {"noun": ["In this code talk, watch experts write the code behind {t}."],
                  "how": ["In this code talk, watch experts show {t}, live in code."]},
}
DEFAULT_OPENERS = {"noun": ["Join us to explore {t}.", "This session covers {t}."],
                   "how": ["Join us to learn {t}.", "Come and see {t}."]}

MIDDLES = [
    "Learn how {s1} works with {s2} to reduce operational overhead and speed up delivery.",
    "We cover architecture patterns, common pitfalls, and best practices for {p}.",
    "Hear how customers apply these ideas in production, and what they learned along the way.",
    "Explore real-world examples and reference architectures you can adapt to your own workloads.",
    "Discover how to measure success, control costs, and iterate quickly with {s1}.",
    "Walk through a reference implementation and the trade-offs behind each design decision.",
    "See how to secure, monitor, and scale {p} workloads with {s1}.",
    "Get practical guidance on governance, reliability, and performance for {p}.",
    "Find out where {s2} fits, and when a simpler approach is the better choice.",
    "Dive into the latest capabilities of {s1} and how they change the way teams build.",
    "As {p} workloads grow, teams need a way to {goal} without slowing down.",
    "Many organizations struggle to {goal}; this session shows a path that works at scale.",
    "We start with the problem, then build up a solution using {s1} and {s2}.",
    "You'll see how {s1} helps teams {goal}, with examples drawn from real deployments.",
    "We compare several approaches to {p} and explain when to choose each one.",
    "Along the way, we share the metrics that matter and how to track them.",
    "Expect a candid look at what went wrong, what went right, and why.",
    "The session closes with a roadmap you can take back to your team.",
    "We look at cost, latency, and resilience, and how to balance them with {s1}.",
    "Using {s2}, we show how to {goal} while keeping security and compliance in view.",
    "Learn the mental models experienced builders use when working with {s1}.",
    "We demonstrate an end-to-end workflow, from first prototype to production.",
    "Discover how to automate the repetitive parts of {p} so your team can focus on outcomes.",
    "We discuss migration strategies for moving existing {p} workloads to {s1}.",
    "Find out how to evaluate results, catch regressions early, and roll out changes safely.",
    "Learn how leading teams organize people, process, and technology around {p}.",
]
GOALS = ["ship features faster", "cut infrastructure costs", "improve reliability", "reduce operational toil",
         "meet compliance requirements", "scale to millions of users", "modernize legacy systems",
         "get more value from their data", "move from pilot to production", "respond to incidents faster",
         "keep latency low under load", "govern access across accounts"]
TOPIC_OPENERS = ["{P} is changing quickly, and {s1} is at the center of it.",
                 "Teams building on {s1} face a familiar set of {p} challenges.",
                 "Getting {p} right takes more than picking the right service."]

LEVEL_LINES = {
    "100": "No prior experience is required.",
    "200": "Some familiarity with {p} is helpful.",
    "300": "This session assumes working knowledge of {s1}.",
    "400": "This expert-level session is for practitioners who already run {s1} in production.",
}
HANDS_ON = "You must bring your laptop to participate."
CLOSERS = ["Leave with practical guidance you can apply right away.",
           "You'll leave with a clear plan for your next steps.",
           "Leave with patterns and code you can reuse in your own environment."]


IMPERATIVES = {"accelerate", "achieve", "automate", "boost", "bring", "build", "create", "cut", "deliver",
               "deploy", "design", "drive", "get", "go", "harness", "improve", "make", "master", "migrate",
               "modernize", "optimize", "power", "protect", "reimagine", "run", "scale", "secure",
               "ship", "simplify", "streamline", "supercharge", "take", "transform", "turn", "unlock", "use"}
SHORT = ["Seating is limited.", "Come with questions.", "Expect plenty of time for Q&A.",
         "Examples are shared after the session.", "All are welcome.", "Learn from real customer stories.",
         "See it working end to end.", "Q&A follows.", "Bring your use case.", "Demos included.",
         "Code samples are provided.", "Expect a lively discussion.", "Slides are shared afterwards.",
         "No slides, just a whiteboard.", "Live demos throughout.", "Join the conversation.",
         "Hear what worked and what didn't.", "Real numbers, real trade-offs."]


# A first word that is not a name, so it can be lowered inside a sentence.
COMMON = IMPERATIVES | {"a", "an", "the", "from", "inside", "beyond", "what", "why", "when", "how", "with",
                        "using", "modern", "best", "advanced", "deep", "getting", "introducing", "building",
                        "designing", "scaling", "securing", "migrating", "modernizing", "accelerating",
                        "automating", "optimizing", "running", "making", "creating", "delivering",
                        "understanding", "unlocking", "transforming", "architecting", "architect", "dive"}


def focus(title):
    """("how", "how to build ...") for a title that says what you'll do, else ("noun", title),
    with its first letter lowered when the first word isn't a name."""
    t = title.strip().rstrip(".!?")
    first = t.split(" ", 1)[0].rstrip(":,").lower()
    if first in COMMON:
        t = t[0].lower() + t[1:]
    if first in IMPERATIVES or first in ("architect", "dive"):
        return "how", "how to " + t
    if first == "how":
        return "how", t
    return "noun", t


def placeholder(session, target):
    """Sentences in the catalog's style, chosen to come within a few characters of `target`."""
    rng = random.Random(hashlib.sha256(session["sessionId"].encode()).hexdigest())
    services = session.get("services") or ["AWS"]
    topics = session.get("topics") or ["cloud"]

    def fill(s):
        s1 = rng.choice(services)
        others = [x for x in services if x != s1]
        s2 = rng.choice(others) if others else rng.choice(topics)
        topic = rng.choice(topics)
        return s.format(t=phrase, s1=s1, s2=s2, p=topic, P=topic[:1].upper() + topic[1:], goal=rng.choice(GOALS))

    kind, phrase = focus(session["title"])
    head = [fill(rng.choice(OPENERS.get(session.get("type"), DEFAULT_OPENERS)[kind]))]
    if rng.random() < 0.4:  # some abstracts set the scene before naming the session
        head.insert(0, fill(rng.choice(TOPIC_OPENERS)))
    if session.get("type") in ("Workshop", "Builders' session"):
        head.append(HANDS_ON)
    level = LEVEL_LINES.get((session.get("level") or "")[:3])
    tail = ([fill(level)] if level else []) + [fill(rng.choice(CLOSERS))]
    middles = [fill(m) for m in MIDDLES]
    rng.shuffle(middles)
    short = SHORT[:]
    rng.shuffle(short)

    length = lambda parts: len(" ".join(parts))
    parts = head[:]
    for m in middles:  # longest run of full sentences that still leaves room for the tail
        if length(parts + [m] + tail) <= target:
            parts.append(m)
    for m in short:  # then short ones to close the gap
        if length(parts + [m] + tail) <= target:
            parts.append(m)
    parts += tail
    text = " ".join(parts)
    if len(text) > target:  # a short abstract: keep the opener, then whatever short lines fit
        parts = head[:1]
        for m in tail[-1:] + short:
            if length(parts + [m]) <= target:
                parts.append(m)
        text = " ".join(parts)
    if len(text) > target:  # shorter than one sentence: cut at a word boundary
        text = text[:target - 1].rsplit(" ", 1)[0].rstrip(",;:.") + "."
    return text


def main(paths):
    sessions = {}
    for path in paths:
        with open(path) as f:
            for item in json.load(f)["items"]:
                sessions[item["sessionId"]] = item
    items = []
    for sid in sorted(sessions):
        real = sessions[sid]
        out = {k: real[k] for k in KEEP if k in real}
        out["abstract"] = placeholder(real, len(real.get("abstract") or ""))
        out["realAbstractLength"] = len(real.get("abstract") or "")
        items.append(out)
    json.dump({"note": "re:Invent 2026 catalog for tests. Abstracts are PLACEHOLDER TEXT at the real "
                       "lengths (realAbstractLength); no speakers. Built by scripts/catalog_fixture.py.",
               "totalCount": len(items), "items": items}, sys.stdout, ensure_ascii=False, indent=0, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
