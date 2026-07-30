"""Check the rendered site before it is deployed.

render.py bakes the live record into HTML — the landing table, the floor's whole
dataset inside a <script> block — and the engine pushes new data up to 38 times a
day, each push deploying straight to production with nothing looking at the
result. The record is prose written by nineteen traders, so the data is the least
predictable input this build has.

That has already broken the site once: a `</script>` inside a journal line closed
the script block early and took the entire floor down (fixed 2026-07-28 with
render.py::script_json). The fix was right and there was still nothing that would
have caught it, or will catch the next one.

These are the checks a person would run by hand and never does. They cost a
second and they run between render and deploy, so a bad bake fails the workflow
instead of reaching the floor.

  python3 tools/check_build.py            # after render.py
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

# Pages the build must produce, with an anchor proving each is the real page and
# not an empty or half-rendered one.
PAGES = {
    "index.html": ["Conviction League", 'data-cta="seat"'],
    "floor/index.html": ["Conviction League", "ARENA", "<table"],
    "seat/index.html": ["Conviction League"],
    "desk/index.html": ["Conviction League"],
}

# Values that mean a formatter was handed something it did not expect. Any of
# these in the served HTML is a number or a name the reader cannot trust.
LEAKS = (
    ("undefined", r"\bundefined\b"),
    ("NaN", r"\bNaN\b"),
    ("Python None", r">\s*None\s*<"),
    ("unformatted dict", r">\s*\{'"),
    ("template placeholder", r"/\*__[A-Z_]+__\*/"),
)

FLOOR_MIN_BYTES = 40_000        # the floor carries the whole dataset
LANDING_MIN_BYTES = 8_000


def problems():
    out = []

    if not PUBLIC.is_dir():
        return ["public/ does not exist — render.py did not run"]

    for page, anchors in PAGES.items():
        path = PUBLIC / page
        if not path.exists():
            out.append(f"{page}: missing from the build")
            continue
        html = path.read_text(encoding="utf-8", errors="replace")
        for anchor in anchors:
            if anchor not in html:
                out.append(f"{page}: does not contain {anchor!r} — half rendered?")
        for label, pattern in LEAKS:
            hits = re.findall(pattern, html)
            # The floor's baked JSON is the record's own prose; a trader may
            # legitimately write "undefined" in a journal. Only flag leaks
            # outside the data block.
            if hits and label != "template placeholder":
                if _outside_data(html, pattern):
                    out.append(f"{page}: {label} leaked into the page "
                               f"({len(hits)} occurrence(s))")
            elif hits:
                out.append(f"{page}: {label} left unfilled: {hits[0]}")

    floor = PUBLIC / "floor" / "index.html"
    if floor.exists():
        html = floor.read_text(encoding="utf-8", errors="replace")
        if len(html) < FLOOR_MIN_BYTES:
            out.append(f"floor/index.html: {len(html):,} bytes — too small to be "
                       f"carrying the record")
        out += baked_data_problems(html)

    landing = PUBLIC / "index.html"
    if landing.exists() and len(landing.read_text(encoding="utf-8")) < LANDING_MIN_BYTES:
        out.append("index.html: too small to be the landing")

    served = PUBLIC / "arena.json"
    if not served.exists():
        out.append("arena.json: not published")
    else:
        try:
            data = json.loads(served.read_text(encoding="utf-8"))
        except ValueError as e:
            out.append(f"arena.json: not valid JSON ({e})")
        else:
            out += record_problems(data)

    return out


def warnings():
    """Things that are wrong but must not stop a deploy.

    A trader seated overnight has no rendered face until gen-avatars is run by
    hand. That is worth shouting about — it 404s on the floor and puts a broken
    image in a letter — but blocking the deploy on it would freeze the record's
    publishing for everyone until somebody woke up, which is worse than a missing
    picture.
    """
    served = PUBLIC / "arena.json"
    if not served.exists():
        return []
    try:
        data = json.loads(served.read_text(encoding="utf-8"))
    except ValueError:
        return []
    return face_problems(data)


def _outside_data(html, pattern):
    """Is there a match outside the baked <script> data block? The block holds
    the record's own words, which the page is entitled to contain."""
    stripped = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.S)
    return bool(re.search(pattern, stripped))


def baked_data_problems(html):
    """The floor's dataset must survive being baked into a script block.

    This is the check that would have caught the 2026-07-28 outage: pull the
    baked JSON back out and parse it. If a `</script>` or a raw line separator
    ever escapes the escaping again, this fails here instead of on the floor.
    """
    out = []
    match = re.search(r"const\s+ARENA\s*=\s*(\{.*?\});?\s*\n", html, re.S)
    if not match:
        match = re.search(r"=\s*(\{\"generated_at\".*?\})\s*;", html, re.S)
    if not match:
        return ["floor/index.html: could not find the baked dataset — the "
                "injection point may have been renamed (update this check)"]
    raw = match.group(1)
    if "</script>" in raw:
        out.append("floor/index.html: a literal </script> is inside the baked "
                   "data — the block closes early and the floor is dead")
    for bad, name in ((" ", "U+2028"), (" ", "U+2029")):
        if bad in raw:
            out.append(f"floor/index.html: raw {name} in the baked data — "
                       f"a JS parse error")
    try:
        json.loads(raw.replace("<\\/", "</"))
    except ValueError as e:
        out.append(f"floor/index.html: the baked data does not parse ({e})")
    return out


def record_problems(data):
    """The shape the pages read. A key silently absent renders as an empty page
    rather than an error, which is the worst way to be wrong."""
    out = []
    for key in ("generated_at", "agents"):
        if key not in data:
            out.append(f"arena.json: no {key!r}")
    agents = data.get("agents") or []
    if not agents:
        return out + ["arena.json: no agents — the floor would be empty"]
    if isinstance(agents, dict):
        agents = list(agents.values())
    for a in agents:
        aid = a.get("id", "?")
        for key in ("id", "name", "equity"):
            if a.get(key) in (None, ""):
                out.append(f"arena.json: {aid} has no {key!r}")
        if a.get("chosen") is not None or (a.get("avatar") or {}).get("chosen") is not None:
            out.append(f"arena.json: {aid} publishes 'chosen' — whether a "
                       f"principal picked their face is not the floor's business")
    return out


def face_problems(data):
    """Every trader on the floor needs a rendered face: the avatar PNGs are
    served from this repo, and a newly seated trader has none until
    tools/gen-avatars.mjs is run. vector shipped with a 404 for a face on
    2026-07-29 and its principal's letter would have carried a broken image."""
    agents = data.get("agents") or []
    if isinstance(agents, dict):
        agents = list(agents.values())
    out = []
    for a in agents:
        aid = a.get("id")
        if not aid:
            continue
        if not (PUBLIC / "avatars" / f"{aid}.png").exists():
            out.append(f"avatars/{aid}.png: missing — run "
                       f"`node tools/gen-avatars.mjs {aid}` and commit it")
    return out


def main():
    for w in warnings():
        print(f"WARN   {w}")
    found = problems()
    if not found:
        print("build check: the pages are whole and the baked record parses.")
        return 0
    for p in found:
        print(f"BUILD  {p}")
    print(f"build check: {len(found)} problem(s) — not deploying this")
    return 1


if __name__ == "__main__":
    sys.exit(main())
