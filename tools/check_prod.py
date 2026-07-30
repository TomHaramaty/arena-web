"""Ask the live site whether it is actually up, after every deploy.

Sessions of this project have written a `qa-prod-*.mjs` rig again and again — for
the rename, the credit byline, the tape, the mobile pass, the em-dash sweep — and
every one of them lived in a scratchpad and was thrown away. So the same
questions get re-asked by hand each time and go unasked in between, while the
engine deploys up to 38 times a day.

This is that rig, kept: the handful of facts that mean the product is serving.

  python3 tools/check_prod.py                       # against conviction-league.com
  BASE=https://open-outcry.web.app python3 tools/check_prod.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("BASE", "https://conviction-league.com").rstrip("/")
# A real browser UA: the analytics endpoint and some edges treat urllib's default
# as a bot (see the Umami and Resend/Cloudflare findings in this project).
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

PAGES = {
    "/": ["Conviction League", 'data-cta="seat"'],
    "/floor/": ["Conviction League", "<table"],
    "/seat/": ["Conviction League"],
    "/desk/": ["Conviction League"],
}
# The old brand. It stays in the record's prose by design (those entries were
# written then) but must never be in the chrome again.
RETIRED = "Open Outcry"


def fetch(path, attempts=3):
    """(status, body). Retried: a deploy check that goes red on one dropped
    connection teaches everyone to ignore it."""
    url = path if path.startswith("http") else BASE + path
    last = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, ""
        except Exception as e:                      # network, DNS, TLS
            last = e
            if attempt < attempts - 1:
                time.sleep(2 * (attempt + 1))
    return None, f"{type(last).__name__}: {last}"


def problems():
    out = []

    for path, anchors in PAGES.items():
        status, body = fetch(path)
        if status != 200:
            out.append(f"{path}: {status or 'unreachable'} {body[:120]}")
            continue
        for anchor in anchors:
            if anchor not in body:
                out.append(f"{path}: served 200 without {anchor!r}")
        # The floor's baked data is the record's own prose and may say anything;
        # the page's own text may not.
        chrome = body.split('/*__ARENA_DATA__*/')[0]
        if path != "/floor/" and RETIRED in chrome:
            out.append(f"{path}: still says {RETIRED!r}")

    status, body = fetch("/arena.json")
    if status != 200:
        out.append(f"/arena.json: {status or 'unreachable'}")
        return out
    try:
        data = json.loads(body)
    except ValueError as e:
        out.append(f"/arena.json: does not parse ({e}) — the floor is reading this")
        return out

    agents = data.get("agents") or []
    if isinstance(agents, dict):
        agents = list(agents.values())
    if not agents:
        out.append("/arena.json: no agents")
    stamp = data.get("generated_at")
    if not stamp:
        out.append("/arena.json: no generated_at — nothing can judge its freshness")

    for a in agents:
        aid = a.get("id")
        if not aid:
            continue
        status, _ = fetch(f"/avatars/{aid}.png", attempts=2)
        if status != 200:
            out.append(f"/avatars/{aid}.png: {status} — this trader has no face "
                       f"on the floor or in its letters")
    return out


def main():
    print(f"prod check: {BASE}")
    found = problems()
    if not found:
        print("prod check: every page serves, the record parses, "
              "every trader has a face.")
        return 0
    for p in found:
        print(f"PROD  {p}")
    print(f"prod check: {len(found)} problem(s)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
