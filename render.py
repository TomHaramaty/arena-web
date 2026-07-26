"""Render the Open Outcry site: data/arena.json + web/ templates → public/.

The engine (arena-engine) pushes fresh data/arena.json here; this script is the
whole build. Deterministic: same arena.json → byte-identical output.

  public/index.html   ← web/landing.html   (the landing; every framed "screen"
                        server-rendered from the record — zero JS)
  public/floor/       ← web/template.html  (the full interface, data injected)
  public/arena.json   ← data/arena.json    (the record, verbatim)
  public/*            ← web/static/*       (copied verbatim; includes /seat/)

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


# ---------------------------------------------------------------- step 1: the
# rule drafted live in the interview (inner panel of the static chat frame)

def draft_rule(data, agent_id="ballast", prin_id="P2"):
    agents = [a for a in [find_agent(data, agent_id)] if a] or data["agents"]
    for a in agents:
        prins = a.get("principles", [])
        chosen = next((p for p in prins if p.get("id") == prin_id), None)
        for p in ([chosen] if chosen else prins):
            if not p:
                continue
            date, quote = origin_parts(p.get("origin", ""))
            tags = "".join(
                f'<span class="tag{" hard" if t == "hard" else ""}">{esc(t)}</span>'
                for t in [p.get("id", ""), p.get("type", ""), p.get("rigidity", "")] if t)
            body = (f'<div class="tagrow">{tags}</div>'
                    f'<p class="astmt">{esc(p["statement"])}</p>')
            if quote:
                body += (f'<p class="aquote">“{esc(quote)}” '
                         f'<span class="attr">— you, {esc(fmt_date(date))}</span></p>')
            return body
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
            rat = re.sub(r"\s*\[[\d.,\s]+\]", "", rat)          # drop [1.4]-style refs
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


def floor_frame(data, top=5):
    rows = []
    for a in sorted(data["agents"], key=lambda x: x.get("alpha", 0), reverse=True)[:top]:
        alpha = a.get("alpha", 0)
        cls, arrow = ("up", "▲") if alpha >= 0 else ("dn", "▼")
        rows.append(
            f'<tr><td><span class="fname">{esc(a["name"])}</span>'
            f'<span class="farch">{esc(a["archetype"])}</span></td>'
            f'<td class="fspark">{sparkline(a.get("curve"))}</td>'
            f'<td class="falpha"><span class="{cls}">{arrow} {abs(alpha) * 100:.1f}%</span>'
            f'<span class="fbench">vs {esc(a["benchmark_label"])}</span></td></tr>')
    body = f'<table class="floortab">{"".join(rows)}</table>'
    return frame(f'the arena · {esc(fmt_date(data.get("run_date", "")))}',
                 "alpha vs own benchmark", body)


def build_landing(data):
    tpl = (ROOT / "web" / "landing.html").read_text(encoding="utf-8")
    n = len(data["agents"])
    stat = f"{n} traders live · latest entry {esc(fmt_date(data.get('run_date', '')))}"
    return (tpl
            .replace("{{HERO_STAT}}", stat)
            .replace("{{DRAFT_RULE}}", draft_rule(data))
            .replace("{{ART_BOOK}}", book_frame(data))
            .replace("{{ART_JOURNAL}}", journal_frame(data))
            .replace("{{ART_HYPOTHESIS}}", hypothesis_frame(data))
            .replace("{{ART_FLOOR}}", floor_frame(data))
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


def main():
    data = json.loads((ROOT / "data" / "arena.json").read_text(encoding="utf-8"))
    PUBLIC.mkdir(exist_ok=True)

    # the landing at /
    (PUBLIC / "index.html").write_text(build_landing(data), encoding="utf-8")

    # the full interface at /floor/
    template = (ROOT / "web" / "template.html").read_text(encoding="utf-8")
    template = template.replace("/*__AVATAR_JS__*/", avatar_inline())
    (PUBLIC / "floor").mkdir(exist_ok=True)
    (PUBLIC / "floor" / "index.html").write_text(
        template.replace("/*__ARENA_DATA__*/", json.dumps(data)), encoding="utf-8"
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
