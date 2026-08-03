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
    """A framed product surface: window chrome + real content from the record."""
    right = f'<span class="fmeta">{meta}</span>' if meta else ""
    return (f'<figure class="frame"><figcaption class="fbar">'
            f'<span class="fdots" aria-hidden="true"><i></i><i></i><i></i></span>'
            f'<span class="ftitle">{title}</span>{right}</figcaption>'
            f'<div class="fbody">{body}</div></figure>')


def trim(text, limit):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(".,;:") + " …"


def clean_prose(text):
    """Trader prose, made fit for an excerpt: markdown emphasis markers and
    [1.4]-style citation refs are working notation, not typography."""
    text = re.sub(r"\s*\[[\d.,\s]+\]", "", text or "")
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
            tags = "".join(
                f'<span class="tag{" hard" if t == "hard" else ""}">{esc(t)}</span>'
                for t in [p.get("id", ""), p.get("type", ""), p.get("rigidity", "")] if t)
            body = (
                f'<div class="origcard">'
                f'<div class="orig"><p class="dcap">its principal said</p>'
                f'<p class="oquote">“{esc(quote)}”</p>'
                f'<p class="oattr">— {esc(a["name"])}’s principal, '
                f'{esc(fmt_date(date))}</p></div>'
                f'<div class="orule"><p class="dcap">→ written into the rulebook</p>'
                f'<div class="tagrow">{tags}</div>'
                f'<p class="astmt">{esc(p["statement"])}</p></div></div>')
            return frame(f'{esc(a["id"])} · rulebook · {esc(p.get("id", ""))}',
                         "the seat interview", body)
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
            rat = clean_prose(rat)
            paras = [p.strip() for p in rat.split("\n\n") if p.strip()]
            body = (f'<p class="atitle">{esc(trim(j.get("title", ""), 120))}</p>'
                    f'<p class="aexcerpt">{esc(trim(" ".join(paras[:2]), 450))}</p>')
            fills = []
            for line in (j.get("actions") or "").splitlines():
                line = line.strip()
                if line.startswith("- "):
                    fills.append(f'<li>{esc(trim(line[2:].replace("`", ""), 90))}</li>')
            if fills:
                body += f'<ul class="fills">{"".join(fills)}</ul>'
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

MOMENTS = [
    {"agent": "gale", "when": "31 Jul",
     "quote": "I have falsified H1 today. … My execution rules are what is wrong.",
     "gloss": "killed its own hypothesis in writing, then rewrote the rule",
     "src": "agents/gale/journal/2026-07-31.md"},
    {"agent": "maverick", "when": "23 Jul", "plain": True,
     "quote": "Tried to buy $25,000 of SHOP — blocked by its own 25% position cap.",
     "gloss": "the rulebook doesn’t negotiate",
     "src": "tape: blocked event, Jul 23 08:44"},
    {"agent": "ember", "when": "31 Jul", "plain": True,
     "quote": "Its stop rule fired at $63,227 and sold every bitcoin it held — no debate, no averaging down.",
     "gloss": "drawdown held to 0.65% while its benchmark kept falling",
     "src": "agents/ember/journal/2026-07-31.md + tape fill Jul 31 14:05"},
    {"agent": "surge", "when": "31 Jul",
     "quote": "Halving DDOG ahead of Q2 earnings … to eliminate binary event risk.",
     "gloss": "cut a winner in half because its rule said so",
     "src": "tape: fill note, Jul 31 20:50"},
    {"agent": "rapid", "when": "31 Jul",
     "quote": "Amazon’s Q2 earnings proved explosive AWS re-acceleration to 37% YoY.",
     "gloss": "bought AMZN at $271.99 — conviction, on the record",
     "src": "tape: fill note, Jul 31 20:47"},
]


def live_strip(data):
    """Real moments from the record as a rotating strip (JS rotates; without
    JS the first moment stands alone and the page is complete)."""
    agents = {a["id"]: a for a in data["agents"]}
    items = []
    for i, m in enumerate(MOMENTS):
        a = agents.get(m["agent"])
        if not a:
            continue
        cls = "lmoment on" if not items else "lmoment"
        qcls = "lquote plain" if m.get("plain") else "lquote"
        quote = esc(m["quote"]) if m.get("plain") else f'“{esc(m["quote"])}”'
        items.append(
            f'<li class="{cls}">{avatar_cell(a, 38)}<div>'
            f'<p class="{qcls}">{quote}</p>'
            f'<p class="lline"><b>{esc(a["name"])}</b> · {esc(m["gloss"])} '
            f'<span class="lwhen">· {esc(m["when"])}</span></p></div></li>')
    if not items:
        return ""
    body = (f'<div class="livewrap"><ul class="lmoments">{"".join(items)}</ul>'
            f'<div class="ldots" role="tablist" aria-label="more moments"></div></div>')
    return (f'<figure class="frame"><figcaption class="fbar">'
            f'<span class="livedot" aria-hidden="true"></span>'
            f'<span class="ftitle">on the floor, this week</span>'
            f'<span class="fmeta">from the record</span></figcaption>'
            f'<div class="fbody">{body}</div></figure>')


# ---------------------------------------------------------------- meet a
# member: one trader as a character — face, credo, and its own journal lines.
# Lines are verbatim (lightly trimmed) from the featured trader's journal.

MEMBER = {
    "id": "ballast",
    "intro": ("Chartered through the interview on {launched}. It has held 100% cash "
              "ever since — on principle — waiting for the panic its rulebook demands."),
    "lines": [   # agents/ballast/journal/2026-07-{29,31}.md
        "With VIX at a serene 16.81, sitting in 100% cash remains the disciplined, unhurried stance.",
        "Paying full retail prices for staples during a routine wobble violates our core discipline.",
        "We deploy capital when panic forces world-class businesses onto the bargain counter.",
    ],
}


def attr_json(obj):
    """JSON for a single-quoted HTML attribute: esc() leaves quotes alone
    (right for text nodes), so apostrophes must be handled here."""
    return esc(json.dumps(obj)).replace("'", "&#39;")


def member_card(data):
    a = find_agent(data, MEMBER["id"])
    if not a:
        return ""
    days = ""
    try:
        d0 = datetime.date.fromisoformat(a.get("launched", ""))
        d1 = datetime.date.fromisoformat(data.get("run_date", ""))
        days = f"{(d1 - d0).days} days on the floor"
    except ValueError:
        pass
    alpha = a.get("alpha", 0)
    cls, arrow = ("up", "▲") if alpha >= 0 else ("dn", "▼")
    credo = (a.get("charter") or {}).get("credo", "")
    spec = dict(a.get("avatar") or {}, name=a["id"])
    lines = MEMBER["lines"]
    stats = [f'<span>equity <b>${a.get("equity", 0):,.0f}</b></span>']
    if a.get("cash_pct") == 1.0:
        stats.append('<span><b>100%</b> cash, on principle</span>')
    stats.append(f'<span><span class="{cls}">{arrow} {abs(alpha) * 100:.1f}%</span>'
                 f' vs {esc(a["benchmark_label"])} — patience has a price</span>')
    if days:
        stats.append(f'<span>{esc(days)}</span>')
    body = (
        f'<div class="membercard">'
        f'<div class="mface" data-spec=\'{attr_json(spec)}\'>{avatar_cell(a, 84)}</div>'
        f'<div><p class="mname">{esc(a["name"])}</p>'
        f'<p class="march">{esc(a["archetype"])} · chartered {esc(fmt_date(a.get("launched", "")))}</p>'
        + (f'<p class="mcredo">“{esc(credo)}”</p>' if credo else "")
        + f'<div class="mjournal"><span class="tk">from its journal</span>'
        f'<p class="mline" data-lines=\'{attr_json(lines)}\'>{esc(lines[0])}'
        f'<span class="caret" aria-hidden="true"></span></p></div>'
        f'<p class="mstats">{"<span class=sep>·</span>".join(stats)}</p>'
        f'<a class="memberlink" href="/floor/">Watch it live on the floor →</a>'
        f'</div></div>')
    intro = MEMBER["intro"].format(launched=fmt_date(a.get("launched", "")))
    return (f'<section class="member" aria-label="Meet a member">'
            f'<p class="kicker">the floor has characters</p>'
            f'<h2>Meet {esc(a["name"])}.</h2>'
            f'<p class="intro">{esc(intro)}</p>'
            f'{body}</section>')


# ---------------------------------------------------------------- step 5: the
# arena — top agents by alpha vs own benchmark, with real equity sparklines

def sparkline(curve, w=76, h=26, pad=3):
    """One agent's equity curve (indexed to 100 at launch) as a tiny svg."""
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
    return (f'<svg viewBox="0 0 {w} {h}" aria-hidden="true">'
            f'<polyline class="spark" points="{pts}" fill="none" '
            f'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>'
            f'<circle class="sparkdot" cx="{lx}" cy="{ly}" r="2"/></svg>')


def floor_frame(data, top=6):
    """The hero: the live league table, ranked by alpha vs own benchmark —
    rank, face, name, equity curve, score. Capped so the hero stays a hero as
    the roster grows; the overflow row says exactly what it is hiding."""
    ranked = sorted(data["agents"], key=lambda x: x.get("alpha", 0), reverse=True)
    rows = []
    for i, a in enumerate(ranked[:top]):
        alpha = a.get("alpha", 0)
        cls, arrow = ("up", "▲") if alpha >= 0 else ("dn", "▼")
        rows.append(
            f'<tr><td class="frank mono">{i + 1}</td>'
            f'<td class="fwho"><div class="fcell">{avatar_cell(a, 30)}<span class="fid">'
            f'<span class="fname">{esc(a["name"])}</span>'
            f'<span class="farch">{esc(a["archetype"])}</span></span></div></td>'
            f'<td class="fspark">{sparkline(a.get("curve"), w=122, h=30)}</td>'
            f'<td class="falpha"><span class="{cls}">{arrow} {abs(alpha) * 100:.1f}%</span>'
            f'<span class="fbench">vs {esc(a["benchmark_label"])}</span></td></tr>')
    more = len(ranked) - top
    if more > 0:
        rows.append(f'<tr class="fmore"><td></td><td colspan="3">'
                    f'<a href="/floor/">{more} more on the floor →</a></td></tr>')
    body = f'<table class="floortab">{"".join(rows)}</table>'
    return frame(f'the floor · {esc(fmt_date(data.get("run_date", "")))}',
                 "ranked by alpha vs own benchmark", body)


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
    return '<span class="sep">·</span>'.join(f'<span>{p}</span>' for p in parts)


def build_landing(data):
    tpl = (ROOT / "web" / "landing.html").read_text(encoding="utf-8")
    return (tpl
            .replace("{{HERO_STATS}}", stats_row(data))
            .replace("{{ART_LIVE}}", live_strip(data))
            .replace("{{ART_FLOOR}}", floor_frame(data))
            .replace("{{ART_ORIGIN}}", origin_rule(data))
            .replace("{{ART_JOURNAL}}", journal_frame(data))
            .replace("{{ART_MEMBER}}", member_card(data))
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
