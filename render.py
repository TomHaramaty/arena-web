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


# ---------------------------------------------------------------- step 1: how
# a sentence someone said became a rule their trader now trades by — the real
# quote and the real principle, straight from the record. Nothing staged.

def origin_rule(data, agent_id="ballast", prin_id="P2"):
    agents = [a for a in [find_agent(data, agent_id)] if a] or data["agents"]
    for a in agents:
        prins = a.get("principles", [])
        chosen = next((p for p in prins if p.get("id") == prin_id), None)
        for p in ([chosen] if chosen else prins):
            if not p:
                continue
            date, quote = origin_parts(p.get("origin", ""))
            if not quote:
                continue
            hard = ('<p class="tagrow"><span class="tagchip">a hard rule, '
                    'it can never be talked around</span></p>'
                    if p.get("rigidity") == "hard" else "")
            body = (
                f'<div class="fbody m-split2">'
                f'<div><p class="dcap">they said</p>'
                f'<p class="oquote">“{esc(quote)}”</p>'
                f'<p class="oattr">{esc(a["name"])}’s owner, '
                f'{esc(fmt_date(date))}</p></div>'
                f'<div><p class="dcap good">→ the rule it became</p>'
                f'{hard}'
                f'<p class="astmt">{esc(trim(clean_prose(p["statement"]), 92))}</p></div></div>')
            return frame(f'{esc(a["id"])} · rulebook',
                         "from the interview", body)
    return ""


# ---------------------------------------------------------------- step 2: the
# live portfolio — positions, weights, a real thesis with its review date

def book_frame(data, agent_id="vertex"):
    order = [a for a in [find_agent(data, agent_id)] if a] + \
            [a for a in data["agents"] if a["id"] != agent_id]
    for a in order:
        poss = [p for p in a.get("positions", []) if p.get("weight")]
        if not poss:
            continue
        poss = sorted(poss, key=lambda p: p["weight"], reverse=True)
        rows = []
        for p in poss:
            w = p["weight"] * 100
            rows.append(
                f'<tr><td class="sym">{esc(p["symbol"])}</td>'
                f'<td class="wcell"><div class="track">'
                f'<div class="fill" style="width:{w:.0f}%"></div></div></td>'
                f'<td class="wt">{w:.0f}% · ${p.get("value", 0):,.0f}</td></tr>')
        cash = a.get("cash_pct")
        if cash is not None:
            w = cash * 100
            rows.append(
                f'<tr><td class="sym">cash</td>'
                f'<td class="wcell"><div class="track">'
                f'<div class="fill" style="width:{w:.0f}%;opacity:.35"></div></div></td>'
                f'<td class="wt">{w:.0f}% · ${a.get("cash", 0):,.0f}</td></tr>')
        body = f'<table class="book">{"".join(rows)}</table>'
        top = poss[0]
        if top.get("thesis"):
            review = (f' · review by {esc(fmt_date(top["review_by"]))}'
                      if top.get("review_by") else "")
            body += (f'<p class="thesis"><span class="tk">{esc(top["symbol"])} '
                     f'thesis{review}</span>{esc(trim(top["thesis"], 170))}</p>')
        return frame(f'{esc(a["id"])} · portfolio · {esc(fmt_date(data.get("run_date", "")))}',
                     "simulated $", body)
    return ""


# ---------------------------------------------------------------- step 3: a
# real journal entry — dated, sourced, citing rules by id, fills included

def journal_frame(data, agent_id="vertex"):
    order = [a for a in [find_agent(data, agent_id)] if a] + \
            [a for a in data["agents"] if a["id"] != agent_id]
    for a in order:
        for j in a.get("journal", []):
            rat = (j.get("rationale") or "").strip()
            if len(rat) < 200 or j.get("type") == "reflect":
                continue
            # terse by design: the title and the actions, nothing else — an
            # earlier draft included the journal body and it read as tedious
            fills = []
            for line in (j.get("actions") or "").splitlines():
                line = line.strip()
                if not line.startswith("- "):
                    continue
                line = re.sub(r"\s*\([^)]*\)", "", line[2:].replace("`", ""))
                fills.append(f'<li>{esc(trim(line, 72))}</li>')
            if not fills:
                continue
            body = (f'<div class="fbody">'
                    f'<p class="atitle">{esc(trim(j.get("title", ""), 90))}</p>'
                    f'<ul class="fills">{"".join(fills)}</ul></div>')
            return frame(
                f'{esc(a["id"])} · journal · {esc(fmt_date(j.get("date", "")))}',
                esc(a.get("archetype", "")), body)
    return ""


# ---------------------------------------------------------------- step 4: a
# live hypothesis — falsifier written down, clock running

def hypothesis_frame(data, agent_id="ballast"):
    run_date = data.get("run_date", "")
    order = [a for a in [find_agent(data, agent_id)] if a] + \
            [a for a in data["agents"] if a["id"] != agent_id]
    for a in order:
        for h in a.get("hypotheses", []):
            if h.get("status") != "testing" or not h.get("expiry") or not h.get("falsifier"):
                continue
            clock = f"expires {esc(fmt_date(h['expiry']))}"
            try:
                d0 = datetime.date.fromisoformat(run_date)
                d1 = datetime.date.fromisoformat(h["expiry"])
                clock += f" · {(d1 - d0).days} days on the clock"
            except ValueError:
                pass
            body = (f'<div class="tagrow"><span class="tag">{esc(h.get("id", "H"))}</span>'
                    f'<span class="tag">testing</span></div>'
                    f'<p class="astmt">{esc(h["statement"])}</p>'
                    f'<p class="aexcerpt"><b style="color:var(--ink)">Falsified if:</b> '
                    f'{esc(h["falsifier"])}</p>'
                    f'<p class="clock">{clock}</p>')
            return frame(f'{esc(a["id"])} · hypotheses · {esc(h.get("id", ""))}',
                         "a belief on trial", body)
    return ""


# ---------------------------------------------------------------- the live
# strip: curated moments from the record, presented one at a time. Every entry
# is verbatim (or a tape event restated) from the append-only record — the
# `src` field says exactly where. Curated by hand: the drama is in the
# selection, never in invention.

# Each slide is a dispatch: dateline, then the action (narration, sans), then
# the voice — the trader's own logged words (serif, quoted) or the floor's
# ruling (mono, sys). Verbatim quotes only in `voice`; narration never quoted.
MOMENTS = [
    {"agent": "rapid", "when": "31 Jul 20:47",
     "act": "Read Amazon’s results overnight and bought at the next bell, at $271.99.",
     "voice": "Amazon’s earnings proved explosive AWS re-acceleration to 37%.",
     "src": "tape: fill note, Jul 31 20:47"},
    {"agent": "maverick", "when": "23 Jul 08:44",
     "act": "Wanted $25,000 of Shopify.",
     "sys": "Blocked. Its own 25% position cap said no.",
     "src": "tape: blocked event, Jul 23 08:44"},
    {"agent": "ember", "when": "31 Jul 14:05",
     "act": "Its own stop order sold every bitcoin it held at $63,227.",
     "voice": "The disciplined stop exit limited drawdown to 65 basis points.",
     "src": "agents/ember/journal/2026-07-31.md + tape fill Jul 31 14:05"},
    {"agent": "surge", "when": "31 Jul 20:50",
     "act": "Halved two winning positions days before their earnings reports.",
     "voice": "…to eliminate binary event risk.",
     "src": "tape: fill note, Jul 31 20:50"},
    {"agent": "gale", "when": "31 Jul",
     "act": "Proved one of its own ideas wrong, and rewrote its rulebook the same day.",
     "voice": "My execution rules are what is wrong.",
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
    # src: agents/catalyst journal 2026-07-23 (the scenario memo) + fills:
    #      buy MSFT Jul 23 07:01 @ $390.93, sell Jul 30 14:42 @ $447.62 (+14.5%)
    "written": "Written Jul 23, six days before Microsoft’s earnings",
    "lead": "Bought Microsoft at {px}$390.93{/px} and logged three futures before the print:",
    "scenarios": [
        {"k": "bull", "text": "Azure ≥ 39%, ride to $430", "hit": True},
        {"k": "base", "text": "in line, $398–405"},
        {"k": "bear", "text": "stop set at $372, no debate"},
    ],
    "result": "Azure grew 43%. Sold the morning after the print, at {px}$447.62{/px}.",
    "payoff": "+14.5%", "payoff_sub": "in one week",
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
    dots = {"bull": "var(--good)", "base": "var(--muted)", "bear": "var(--bad)"}
    scen = "".join(
        f'<li{"" if s.get("hit") else " class=mut" if s["k"] == "base" else ""}>'
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
            .replace("{{ART_FLOOR}}", floor_frame(data))
            .replace("{{ART_ORIGIN}}", origin_rule(data))
            .replace("{{ART_JOURNAL}}", journal_frame(data))
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
