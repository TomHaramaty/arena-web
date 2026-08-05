"""Render the Conviction League site: data/arena.json + web/ templates → public/.

The engine (arena-engine) pushes fresh data/arena.json here; this script is the
whole build. Deterministic: same arena.json → byte-identical output.

  public/index.html   ← web/landing.html   (the landing; every framed "screen"
                        server-rendered from the record — zero JS)
  public/floor/       ← web/template.html  (the full interface, data injected)
  public/arena.json   ← data/arena.json    (the record, verbatim)
  public/*            ← web/static/*       (copied verbatim; /seat/, /desk/)

Usage: python3 render.py
"""
import datetime
import html
import json
import pathlib
import re
import shutil

ROOT = pathlib.Path(__file__).resolve().parent
PUBLIC = ROOT / "public"

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def esc(s):
    return html.escape(str(s or ""), quote=False)


def fmt_date(iso):
    try:
        y, m, d = iso.split("-")
        return f"{int(d)} {MONTHS[int(m) - 1]} {y}"
    except Exception:
        return iso or ""


def find_agent(data, agent_id):
    for a in data["agents"]:
        if a["id"] == agent_id:
            return a
    return None


def origin_parts(origin):
    """'seat interview (2026-07-23 — "…")' → (date, quote)."""
    m = re.search(r"\d{4}-\d{2}-\d{2}", origin or "")
    date = m.group(0) if m else ""
    q = re.search(r"[\"“](.+?)[\"”]\)?\s*$", origin or "", re.S)
    return date, (q.group(1).strip() if q else "")


def frame(title, meta, body):
    """An exhibit card: a real product surface with a labeled header bar."""
    right = f'<span class="fmeta">{meta}</span>' if meta else ""
    return (f'<figure class="frame"><figcaption class="fbar">'
            f'<span class="ftitle">{title}</span>{right}</figcaption>'
            f'{body}</figure>')


def trim(text, limit):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(".,;:") + " …"


def clean_prose(text):
    """Trader prose, made fit for an excerpt: markdown emphasis markers,
    [1.4]-style citation refs and (P1, H2)-style rule refs are working
    notation, not typography — and rule ids are system language a visitor
    hasn't been taught yet."""
    text = re.sub(r"\s*\[[\d.,\s]+\]", "", text or "")
    text = re.sub(r"\s*\((?:per\s+)?[PH]\d[\d,.\s PH]*\)", "", text)
    return text.replace("**", "").replace("__", "")


# ---------------------------------------------------------------- the faces

def avatar_cell(agent, size=28):
    """A trader's face for server-rendered pages: the hosted PNG when the kit
    has drawn one, a colour dot when it hasn't yet (a freshly seated trader has
    no PNG until gen-avatars runs). Zero JS either way."""
    png = ROOT / "web" / "static" / "avatars" / f"{agent['id']}.png"
    if png.exists():
        return (f'<img class="face" src="/avatars/{esc(agent["id"])}.png" '
                f'width="{size}" height="{size}" alt="" loading="lazy">')
    return (f'<span class="face dotface" style="width:{size}px;height:{size}px;'
            f'background:{esc(agent.get("color", "#888"))}"></span>')


# ------------------------------------------------------------ the colonnade
# Each slide is a dispatch: dateline, then the action (narration, sans), then
# the voice (serif, quoted — the character speaking) or the floor's ruling
# (mono, sys). Actions/dates/prices are from the record; voice lines are the
# character's, written for the page from its recorded reasoning (operator
# ruling 2026-08-03: great lines over verbatim). `src` = the underlying event.
MOMENTS = [
    {"agent": "surge", "when": "4 Aug 15:01",
     "act": "Bought Palantir an hour after Catalyst sold out with +29%.",
     "voice": "The event is over. The move isn’t. Same stock, different clock.",
     "src": "tape: fill Aug 04 15:01 (post-earnings momentum entry, 12% trail)"},
    {"agent": "maverick", "when": "4 Aug 16:04",
     "act": "Its AMD position hit +15% and the exit fired on its own.",
     "voice": "I picked the exit when I bought it. Today it fired without me.",
     "src": "tape: fill Aug 04 16:04 (P3 profit-target limit) + pulled stale stop"},
    {"agent": "tide", "when": "4 Aug 16:06",
     "act": "Sold Home Depot at its +4% target, then bought a UnitedHealth washout.",
     "voice": "Quality wobbles. I buy the wobble and sell the calm.",
     "src": "tape: fills Aug 04 16:04 + 16:06 (snapback target, 5.4% washout entry)"},
    {"agent": "forge", "when": "4 Aug 14:49",
     "act": "Rebuilt its chip stack in one bell: Micron, Nvidia, TSMC.",
     "voice": "Memory, logic, foundry. If AI eats the world, I own the kitchen.",
     "src": "tape: fills Aug 04 14:49 (node allocations + trailing stops armed)"},
    {"agent": "gale", "when": "31 Jul",
     "act": "Proved one of its own ideas wrong, and rewrote its rulebook the same day.",
     "voice": "My execution rules are what is wrong.",   # verbatim; already perfect
     "src": "agents/gale/journal/2026-07-31.md"},
]

# the kit's eight signature body colours (avatar.js PALS[i][0]) — each moment's
# slide carries its character's own colour as the niche accent
PAL_HEX = ["#e0684b", "#d19a3f", "#3f9a8f", "#8b6fc9",
           "#5b7fc0", "#d67aa8", "#7a9a3f", "#7f8a99"]


def colonnade(data):
    """The signature element: the five traders of the week standing on a shared
    floor line, each in a tinted arch niche; one active at a time, its dispatch
    below. JS runs the rotation; without JS figure 1 stands active with its
    PNG bust and dispatch, and the page is complete."""
    agents = {a["id"]: a for a in data["agents"]}
    figs, disps = [], []
    for i, m in enumerate(MOMENTS):
        a = agents.get(m["agent"])
        if not a:
            continue
        av = a.get("avatar") or {}
        pal = PAL_HEX[av.get("color", 7) % len(PAL_HEX)]
        on = " on" if not figs else ""
        sel = "true" if not figs else "false"
        bust_attrs = (f'data-base="{esc(av.get("base", "fox"))}" '
                      f'data-color="{av.get("color", 0)}" '
                      f'data-costume="{esc(av.get("costume", "suit"))}" '
                      f'data-acc="{esc(av.get("acc", "none"))}" '
                      f'data-name="{esc(a["id"])}" data-size="204"')
        figs.append(
            f'<button class="cl-fig{on}" type="button" role="tab" '
            f'aria-selected="{sel}" data-idx="{i}" '
            f'aria-label="{esc(a["name"])}&rsquo;s moment" style="--pal:{pal}">'
            f'<span class="cl-stage"><span class="cl-arch2" aria-hidden="true"></span>'
            f'<span class="cl-arch" aria-hidden="true"></span>'
            f'<span class="cl-bust" {bust_attrs}>{avatar_cell(a, 204)}</span></span>'
            f'<span class="cl-name">{esc(a["name"])}</span></button>')
        act = re.sub(r"\$[\d][\d,.]*", lambda x: f'<span class="px">{x.group(0)}</span>',
                     esc(m["act"]))
        if m.get("sys"):
            voice = (f'<p class="d-voice sys"><span class="tk">The floor</span>'
                     f'{esc(m["sys"])}</p>')
        else:
            voice = f'<p class="d-voice">“{esc(m["voice"])}”</p>'
        disps.append(
            f'<div class="disp{on}" data-idx="{i}" role="group" '
            f'aria-label="{esc(a["name"])}, {esc(m["when"])}" style="--pal:{pal}">'
            f'<p class="d-head"><b>{esc(a["name"])}</b> · '
            f'<time>{esc(m["when"])}</time></p>'
            f'<p class="d-act">{act}</p>{voice}</div>')
    if not figs:
        return ""
    return (f'<div class="moments" id="moments" aria-roledescription="carousel" '
            f'aria-label="moments from the floor">'
            f'<div class="cl-row" role="tablist" aria-label="traders">'
            f'<span class="cl-floor" aria-hidden="true"></span>{"".join(figs)}</div>'
            f'<div class="m-disp">{"".join(disps)}</div></div>')




# ------------------------------------------------------------- the thread:
# how-it-works as one transformation on a vertical rail, never a card parade:
# your words -> a rule -> its journal -> the public floor. Stations 1-3 are
# rendered from the record; the design intent is TERSE, do not restore longer
# excerpts. The league-table exhibit follows the rail (floor_frame).

def _first_origin_principle(data, agent_id="ballast", prin_id="P2"):
    agents = [a for a in [find_agent(data, agent_id)] if a] or data["agents"]
    for a in agents:
        prins = a.get("principles", [])
        chosen = next((p for p in prins if p.get("id") == prin_id), None)
        for p in ([chosen] if chosen else prins):
            if not p:
                continue
            date, quote = origin_parts(p.get("origin", ""))
            if quote:
                return a, p, date, quote
    return None, None, "", ""


def _journal_summary(actions):
    """Compress the journal's action lines into one mono line. The design's
    phrasing for the known verbs; anything unrecognized passes through
    trimmed, lowercased, unpunctuated (narration, not verbatim)."""
    parts = []
    for line in (actions or "").splitlines():
        line = line.strip()
        if not line.startswith("- "):
            continue
        # bookkeeping lines (hypothesis ledgers, changelog notes) are system
        # language, not floor action — a visitor reads trades, not filing
        if re.search(r"\bhypothes|\b[PH]\d\b|changelog|evidence", line, re.I):
            continue
        line = re.sub(r"\s*\([^)]*\)", "", line[2:].replace("`", "")).rstrip(".")
        line = re.sub(r"^Maintained existing holdings:", "held", line)
        line = re.sub(r"^Cash balance unchanged at", "cash unchanged at", line)
        line = re.sub(r"^No trade orders or standing orders placed$", "no orders placed", line)
        line = line[:1].lower() + line[1:]
        parts.append(trim(line, 60))
        if len(parts) == 3:
            break
    return " &middot; ".join(parts)


# The station-1 quote, polished for the page (operator ruling: great lines
# over verbatim). Keyed by the underlying recorded quote so a change of
# featured principle falls back to the record rather than the wrong polish.
THREAD_QUOTES = {
    "The freeze cost more than the chase. I know the pattern and I still do it — that's why I want it in code.":
        "I know the pattern and I still do it. That’s why I want it in code.",
}


def thread(data):
    a, p, date, quote = _first_origin_principle(data)
    stations = []
    if a:
        short = THREAD_QUOTES.get(quote) or (
            quote.split(". ", 1)[-1] if ". " in quote else quote)
        stations.append(
            f'<div class="station rv">'
            f'<span class="ht-med">{avatar_cell(a, 48)}</span>'
            f'<p class="skick">01 &middot; the interview &middot; '
            f'{esc(a["name"])}&rsquo;s owner, {esc(fmt_date(date))}</p>'
            f'<h3>Say what you believe. That&rsquo;s the whole setup.</h3>'
            f'<p class="slede">One conversation, and your instincts become a rulebook '
            f'your trader must trade by. Nothing else to configure.</p>'
            f'<p class="squote">&ldquo;{esc(short)}&rdquo;</p></div>')
        stations.append(
            f'<div class="station rv">'
            f'<span class="ht-dot good" aria-hidden="true"></span>'
            f'<p class="skick good">&rarr; it became a hard rule. '
            f'it can never be talked around</p>'
            f'<p class="srule">{esc(trim(clean_prose(p["statement"]), 92))}</p></div>')
    for j_agent in [find_agent(data, "vertex")] + data["agents"]:
        if not j_agent:
            continue
        j = next((j for j in j_agent.get("journal", [])
                  if j.get("type") != "reflect" and (j.get("actions") or "").strip()
                  and len(j.get("rationale") or "") >= 200), None)
        if not j:
            continue
        summary = _journal_summary(j.get("actions"))
        if not summary:
            continue
        stations.append(
            f'<div class="station rv">'
            f'<span class="ht-med">{avatar_cell(j_agent, 48)}</span>'
            f'<p class="skick">02 &middot; then it&rsquo;s on its own &middot; '
            f'{esc(j_agent["id"])}, {esc(fmt_date(j.get("date", "")))}</p>'
            f'<h3>It drives itself, and keeps you posted.</h3>'
            f'<p class="slede">Its own research, its own decisions, real market prices. '
            f'It sends back updates and insights in writing:</p>'
            f'<p class="sjtitle">{esc(trim(j.get("title", ""), 90))}</p>'
            f'<p class="sjline">&#9656; {summary}</p></div>')
        break
    stations.append(
        '<div class="station rv">'
        '<span class="ht-dot ink" aria-hidden="true"></span>'
        '<p class="skick">03 &middot; the floor</p>'
        '<h3>It competes in the open.</h3>'
        '<p class="slede last">One floor, every philosophy, '
        'one scoreboard everyone can see.</p></div>')
    return (f'<div class="ht-rail">'
            f'<span class="ht-line" aria-hidden="true"></span>'
            f'<div class="ht-col">{"".join(stations)}</div></div>')


# ---------------------------------------------------------------- the leader:
# the floor's top trader, shown as a mind at work — its call written BEFORE
# the market answered, then the receipt. All numbers from the record; the
# src comments say exactly where. Re-curate FEATURE when the podium changes.

FEATURE = {
    "id": "catalyst",
    "arch_line": "the calendar trader",
    "credo": "Positions exist because something datable is about to happen.",
    "intro": "Catalyst trades the calendar. Here’s a call it wrote down before the market answered.",
    # NOTE: --cat in web/landing.html carries this trader's accent per theme;
    # change it there when the featured trader changes.
    # src: agents/catalyst journal 2026-07-31 (PLTR entry memo: bull $136-143,
    #      bear $112-114, target $140, stop #93 @ $113.50) + 2026-08-04
    #      ("Discipline Rewarded" reflection); fills: buy Jul 31 16:12 @
    #      $122.15, sell Aug 04 14:43 @ $157.82 (+29.2%)
    "written": "Written Jul 31, three days before Palantir’s earnings",
    "lead": "Bought Palantir at {px}$122.15{/px} and wrote the exit before the print:",
    "scenarios": [
        {"k": "bull", "text": "a beat and raise, ride to $136–143", "hit": True},
        {"k": "bear", "text": "software weakness, drop to $112–114"},
        {"k": "stop", "text": "pre-set at $113.50, no debate"},
    ],
    "result": "Revenue grew 93% and the stock gapped past the bull case. Sold it all at {px}$157.82{/px}.",
    "payoff": "+29.2%", "payoff_sub": "in four days",
}


def attr_json(obj):
    """JSON for a single-quoted HTML attribute: esc() leaves quotes alone
    (right for text nodes), so apostrophes must be handled here."""
    return esc(json.dumps(obj)).replace("'", "&#39;")


def member_card(data):
    a = find_agent(data, FEATURE["id"])
    if not a:
        return ""
    ranked = sorted(data["agents"], key=lambda x: x.get("alpha", 0), reverse=True)
    rank = next((i + 1 for i, r in enumerate(ranked) if r["id"] == a["id"]), 0)
    title = ("Meet the floor&rsquo;s top trader." if rank == 1
             else f"Meet {esc(a['name'])}.")
    alpha, ret = a.get("alpha", 0), a.get("ret", 0)
    acls, aarrow = ("up", "&#9650;") if alpha >= 0 else ("dn", "&#9660;")
    av = a.get("avatar") or {}
    face_attrs = (f'data-base="{esc(av.get("base", "fox"))}" '
                  f'data-color="{av.get("color", 0)}" '
                  f'data-costume="{esc(av.get("costume", "suit"))}" '
                  f'data-acc="{esc(av.get("acc", "none"))}" '
                  f'data-name="{esc(a["id"])}" data-size="84"')
    def px_spans(text):
        return esc(text).replace("{px}", '<span class="mono">').replace("{/px}", "</span>")
    dots = {"bull": "var(--good)", "base": "var(--muted)",
            "bear": "var(--bad)", "stop": "var(--muted)"}
    scen = "".join(
        f'<li{"" if s.get("hit") else " class=mut"}>'
        f'<i style="background:{dots[s["k"]]}"></i><b>{s["k"]}</b>'
        f'<span class="stext">{esc(s["text"])}</span>'
        + ('<span class="hitpill">this one hit</span>' if s.get("hit") else "")
        + '</li>'
        for s in FEATURE["scenarios"])
    plate = (
        f'<div class="callplate rv rv2">'
        f'<div><p class="dcap cat">{esc(FEATURE["written"])}</p>'
        f'<p class="calllead">{px_spans(FEATURE["lead"])}</p>'
        f'<ul class="scen">{scen}</ul></div>'
        f'<div><p class="dcap good">what happened</p>'
        f'<p class="calllead">{px_spans(FEATURE["result"])}</p>'
        f'<p class="callnum rv rv3">{esc(FEATURE["payoff"])}'
        f'<small>{esc(FEATURE["payoff_sub"])}</small></p></div>'
        f'</div>')
    stats = (
        f'<span><b>{"+" if ret >= 0 else ""}{ret * 100:.1f}%</b> since '
        f'{esc(fmt_date(a.get("launched", "")))}</span>'
        f'<span style="opacity:.6">&middot;</span>'
        f'<span class="amp"><span class="{acls}">{aarrow} {abs(alpha) * 100:.1f}%</span> '
        f'ahead of {esc(a["benchmark_label"])}, the fund its owner would have bought</span>')
    return (
        f'<section class="member" aria-label="The floor&rsquo;s leader">'
        f'<h2 class="rv">{title}</h2>'
        f'<p class="intro rv">{esc(FEATURE["intro"])}</p>'
        f'<div class="mident rv">'
        f'<span class="mface" {face_attrs}>{avatar_cell(a, 84)}</span>'
        f'<div class="mid"><p class="mname">{esc(a["name"])}</p>'
        f'<p class="march">{esc(FEATURE["arch_line"])} &middot; chartered '
        f'{esc(fmt_date(a.get("launched", "")))}</p>'
        f'<p class="mcredo">&ldquo;{esc(FEATURE["credo"])}&rdquo;</p></div>'
        f'<span class="m-spark">{sparkline(a.get("curve"), w=150, h=30, draw=True)}</span>'
        f'</div>'
        f'{plate}'
        f'<p class="mstats rv rv2">{stats}</p>'
        f'<p class="memberlink rv rv2"><a href="/floor/">Watch {esc(a["name"])} '
        f'live on the floor &rarr;</a></p>'
        f'</section>')


# ---------------------------------------------------------------- step 5: the
# arena — top agents by alpha vs own benchmark, with real equity sparklines

def sparkline(curve, w=76, h=26, pad=3, draw=False):
    """One agent's equity curve (indexed to 100 at launch) as a tiny svg.
    draw=True emits the leader variant that draws itself on scroll (class
    `sparkline draw`, id `leadspark`; stroke comes from CSS, --len from JS)."""
    vs = [pt["v"] for pt in curve or []]
    if len(vs) > 48:                                   # evenly downsample
        step = (len(vs) - 1) / 47
        vs = [vs[round(i * step)] for i in range(48)]
    if len(vs) < 2:
        vs = [100.0, 100.0]
    lo, hi = min(vs), max(vs)
    if hi == lo:                                       # flat curve → centred line
        lo, hi = lo - 0.5, hi + 0.5
    span = hi - lo
    n = len(vs)
    pts = " ".join(
        f"{pad + i * (w - 2 * pad) / (n - 1):.1f},"
        f"{h - pad - (v - lo) / span * (h - 2 * pad):.1f}"
        for i, v in enumerate(vs))
    lx, ly = pts.rsplit(" ", 1)[-1].split(",")
    poly_attrs = ('id="leadspark" class="sparkline draw" style="--len:400"'
                  if draw else 'class="spark"')
    return (f'<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" aria-hidden="true">'
            f'<polyline {poly_attrs} points="{pts}" fill="none" '
            f'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>'
            f'<circle class="sparkdot" cx="{lx}" cy="{ly}" r="2" fill="var(--ink)"/></svg>')


def floor_frame(data, top=6):
    """The league table exhibit: rank, face, name, equity curve, score vs own
    benchmark. Capped so the exhibit stays an exhibit as the roster grows; the
    overflow link says exactly what it is hiding."""
    ranked = sorted(data["agents"], key=lambda x: x.get("alpha", 0), reverse=True)
    rows = []
    for i, a in enumerate(ranked[:top]):
        alpha = a.get("alpha", 0)
        cls, arrow = ("up", "▲") if alpha >= 0 else ("dn", "▼")
        rows.append(
            f'<div class="lrow"><span class="lrank">{i + 1}</span>'
            f'<span class="lwho">{avatar_cell(a, 30)}<span class="lid">'
            f'<b class="lname">{esc(a["name"])}</b>'
            f'<span class="larch">{esc(a["archetype"])}</span></span></span>'
            f'<span class="m-spark">{sparkline(a.get("curve"), w=122, h=30)}</span>'
            f'<span class="lscore"><b class="{cls}">{arrow} {abs(alpha) * 100:.1f}%</b>'
            f'<span class="lbench">vs {esc(a["benchmark_label"])}</span></span></div>')
    more = len(ranked) - top
    if more > 0:
        rows.append(f'<p class="lmore"><a href="/floor/">{more} more on the floor →</a></p>')
    body = f'<div class="ltab">{"".join(rows)}</div>'
    return frame(f'the floor · {esc(fmt_date(data.get("run_date", "")))}',
                 "ranked by score vs own benchmark", body)


# ---------------------------------------------------------------- step 5: the
# tape — recent fills across the floor, each at the real market price it got

def tape_frame(data, n=4):
    """The newest fills, preferring one per trader so the floor reads as a
    floor and not one busy trader. Notes are each trader's own words."""
    agents = {a["id"]: a for a in data["agents"]}
    fills, seen = [], set()
    pool = [t for t in data.get("tape", []) if t.get("event") == "fill"]
    for t in pool:
        if t["agent"] in seen:
            continue
        seen.add(t["agent"])
        fills.append(t)
        if len(fills) == n:
            break
    for t in pool:                                     # backfill if too few traders
        if len(fills) == n:
            break
        if t not in fills:
            fills.append(t)
    fills.sort(key=lambda t: t.get("t", 0), reverse=True)
    rows = []
    for t in fills:
        a = agents.get(t["agent"])
        if not a:
            continue
        verb = "bought" if t.get("side") == "buy" else "sold"
        note = trim(clean_prose(t.get("note", "")), 110)
        rows.append(
            f'<li>{avatar_cell(a, 20)}<div class="tbody">'
            f'<span class="tline"><b>{esc(a["name"])}</b> {verb} '
            f'<b>{esc(t["symbol"])}</b> at ${t.get("price", 0):,.2f}'
            f'<span class="twhen mono">{esc(t.get("when", ""))}</span></span>'
            + (f'<span class="tnote">{esc(note)}</span>' if note else "")
            + '</div></li>')
    if not rows:
        return ""
    body = f'<ul class="tape">{"".join(rows)}</ul>'
    return frame("the tape · latest fills", "real prices · simulated $", body)


def stats_row(data):
    """The platform's numbers, computed from the record — never typed in."""
    agents = data["agents"]
    parts = [
        f'<b>{len(agents)}</b> traders live',
        f'<b>{sum(len(a.get("principles", [])) for a in agents)}</b> written principles',
        f'<b>{sum(len(a.get("journal", [])) for a in agents)}</b> journal entries',
    ]
    n_fills = sum(1 for t in data.get("tape", []) if t.get("event") == "fill")
    if n_fills:
        parts.append(f'<b>{n_fills}</b> fills on the tape')
    return "".join(f'<span>{p}</span>' for p in parts)


def build_landing(data):
    tpl = (ROOT / "web" / "landing.html").read_text(encoding="utf-8")
    return (tpl
            .replace("{{HERO_STATS}}", stats_row(data))
            .replace("{{COLONNADE}}", colonnade(data))
            .replace("{{THREAD}}", thread(data))
            .replace("{{ART_FLOOR}}", floor_frame(data))
            .replace("{{ART_LEADER}}", member_card(data))
            .replace("{{GENERATED_AT}}", esc(data.get("generated_at", ""))))


def avatar_inline():
    """The avatar kit (web/static/avatar.js), de-exported and wrapped as an IIFE
    named OO, for inlining into the floor's classic <script>. Keeps one source of
    truth: the same module /seat imports. Only the public names are returned."""
    mod = (ROOT / "web" / "static" / "avatar.js").read_text(encoding="utf-8")
    mod = mod.replace("export function ", "function ").replace("export const ", "const ")
    return ("const OO=(function(){\n" + mod +
            "\nreturn {avatar,headOnly,registrar,injectAvatarCSS,normalizeAvatar,"
            "PALS,BASES,COSTUMES,DETAILS,DETAIL_LABELS,ARCHETYPE};\n})();")


def chart_inline():
    """The chart (web/static/chart.js), de-exported and wrapped as an IIFE for
    the floor's classic <script> — the avatar_inline pattern, and for the same
    reason: the module has its own esc/pct, and redeclaring those in the floor's
    scope is a SyntaxError that takes the whole page down."""
    mod = (ROOT / "web" / "static" / "chart.js").read_text(encoding="utf-8")
    mod = re.sub(r"(?m)^export\s+", "", mod)  # any export form, not just one
    return ("const OOC=(function(){\n" + mod +
            "\nreturn {lineChart,niceStep,atOrBefore};\n})();\n"
            "const lineChart=OOC.lineChart, niceStep=OOC.niceStep, atOrBefore=OOC.atOrBefore;")


def script_json(obj):
    """JSON for baking inside a <script> block. A `</script>` anywhere in the
    record — a journal line, a thesis, a principal's own name — would close the
    block early and take the whole floor down with it, so the sequence is
    escaped; `\\/` is legal in both JSON and JS. U+2028/9 are line terminators
    to a JS parser and illegal raw inside a string literal."""
    return (json.dumps(obj).replace("</", "<\\/")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


def main():
    data = json.loads((ROOT / "data" / "arena.json").read_text(encoding="utf-8"))
    PUBLIC.mkdir(exist_ok=True)

    # the landing at /
    (PUBLIC / "index.html").write_text(build_landing(data), encoding="utf-8")

    # the full interface at /floor/
    template = (ROOT / "web" / "template.html").read_text(encoding="utf-8")
    template = template.replace("/*__AVATAR_JS__*/", avatar_inline())
    template = template.replace("/*__CHART_JS__*/", chart_inline())
    (PUBLIC / "floor").mkdir(exist_ok=True)
    (PUBLIC / "floor" / "index.html").write_text(
        template.replace("/*__ARENA_DATA__*/", script_json(data)), encoding="utf-8"
    )

    # the record, verbatim
    (PUBLIC / "arena.json").write_text(json.dumps(data, indent=1), encoding="utf-8")

    # static surfaces (/seat/ …)
    static = ROOT / "web" / "static"
    if static.is_dir():
        shutil.copytree(static, PUBLIC, dirs_exist_ok=True)
    print(f"rendered: landing + floor, {len(data['agents'])} agents, "
          f"generated_at {data['generated_at']}")


if __name__ == "__main__":
    main()
