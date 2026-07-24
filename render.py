"""Render the Open Outcry site: data/arena.json + web/ templates → public/.

The engine (arena-engine) pushes fresh data/arena.json here; this script is the
whole build. Deterministic: same arena.json → byte-identical output.

  public/index.html   ← web/landing.html   (the narrative landing; artifact
                        blocks server-rendered from the record — zero JS)
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


def artifact(src_left, src_right, body_html):
    right = f"<span>{src_right}</span>" if src_right else ""
    return (f'<figure class="artifact"><figcaption class="src">'
            f'<span>{src_left}</span>{right}</figcaption>'
            f'<div class="abody">{body_html}</div></figure>')


def pick_principle(data, agent_id="ballast", prin_id="P3"):
    """A principle seeded from a seat interview, with its provenance quote."""
    agents = [a for a in [find_agent(data, agent_id)] if a] or data["agents"]
    for a in agents:
        prins = a.get("principles", [])
        chosen = next((p for p in prins if p.get("id") == prin_id), None)
        candidates = [chosen] if chosen else prins
        for p in candidates:
            if not p:
                continue
            date, quote = origin_parts(p.get("origin", ""))
            if not quote:
                continue
            tags = "".join(
                f'<span class="tag{" hard" if t == "hard" else ""}">{esc(t)}</span>'
                for t in [p.get("id", ""), p.get("type", ""), p.get("rigidity", "")] if t)
            body = (f'<div class="tagrow">{tags}</div>'
                    f'<p class="astmt">{esc(p["statement"])}</p>'
                    f'<p class="aquote">“{esc(quote)}” '
                    f'<span class="attr">— the principal, {esc(fmt_date(date))}</span></p>')
            return artifact(f"{esc(a['id'])} · rulebook · {esc(p.get('id', ''))}",
                            "seeded at the seat interview", body)
    return ""


def pick_journal(data, agent_id="vertex"):
    """A real deliberation: dated, sourced, citing principles by id."""
    order = [a for a in [find_agent(data, agent_id)] if a] + \
            [a for a in data["agents"] if a["id"] != agent_id]
    for a in order:
        for j in a.get("journal", []):
            rat = (j.get("rationale") or "").strip()
            if len(rat) < 200 or j.get("type") == "reflect":
                continue
            paras = [p.strip() for p in rat.split("\n\n") if p.strip()]
            excerpt = " ".join(paras[:2])
            if len(excerpt) > 620:
                excerpt = excerpt[:620].rsplit(" ", 1)[0].rstrip(".,;") + " …"
            body = (f'<p class="atitle">{esc(j.get("title", ""))}</p>'
                    f'<p class="aexcerpt">{esc(excerpt)}</p>')
            return artifact(
                f"{esc(a['id'])} · journal · {esc(fmt_date(j.get('date', '')))}",
                esc(a.get("archetype", "")), body)
    return ""


def pick_hypothesis(data, agent_id="ballast"):
    """A live hypothesis with its falsifier and its clock still running."""
    run_date = data.get("run_date", "")
    order = [a for a in [find_agent(data, agent_id)] if a] + \
            [a for a in data["agents"] if a["id"] != agent_id]
    for a in order:
        for h in a.get("hypotheses", []):
            if h.get("status") != "testing" or not h.get("expiry") or not h.get("falsifier"):
                continue
            clock = f"expires {esc(h['expiry'])}"
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
            return artifact(f"{esc(a['id'])} · hypotheses · {esc(h.get('id', ''))}",
                            "a belief on trial", body)
    return ""


def floor_snippet(data, top=5):
    """The real floor, sorted the way the arena scores: alpha vs own benchmark."""
    rows = []
    for a in sorted(data["agents"], key=lambda x: x.get("alpha", 0), reverse=True)[:top]:
        alpha = a.get("alpha", 0)
        cls, arrow = ("up", "▲") if alpha >= 0 else ("dn", "▼")
        rows.append(
            f'<tr><td><span class="fname">{esc(a["name"])}</span>'
            f'<span class="farch"> — {esc(a["archetype"])}</span></td>'
            f'<td class="falpha"><span class="{cls}">{arrow} {abs(alpha) * 100:.1f}%</span></td>'
            f'<td class="fbench">vs {esc(a["benchmark_label"])}</td></tr>')
    body = f'<table class="floortab">{"".join(rows)}</table>'
    return artifact(f"the floor · run {esc(data.get('run_date', ''))}",
                    "alpha vs each agent's own benchmark", body)


def pick_provenance(data, agent_id="ballast", prin_id="P2"):
    """The principal's own words, standing in the rulebook — quote first."""
    a = find_agent(data, agent_id)
    if not a:
        return ""
    p = next((x for x in a.get("principles", []) if x.get("id") == prin_id), None)
    if not p:
        return ""
    date, quote = origin_parts(p.get("origin", ""))
    if not quote:
        return ""
    rig = esc(p.get("rigidity", ""))
    body = (f'<blockquote class="provquote">“{esc(quote)}”</blockquote>'
            f'<p class="provattr">— the principal, {esc(fmt_date(date))}</p>'
            f'<p class="provnow">Now <b>{esc(a["id"])}</b>\'s {rig} rule '
            f'<b>{esc(p.get("id", ""))}</b>: “{esc(p["statement"])}”</p>')
    return artifact(f"{esc(a['id'])} · rulebook · {esc(p.get('id', ''))} · provenance",
                    "your words, with standing", body)


def build_landing(data):
    tpl = (ROOT / "web" / "landing.html").read_text(encoding="utf-8")
    n = len(data["agents"])
    stat = (f"{n} seats live · latest entry {esc(data.get('run_date', ''))} · "
            f"every artifact below is rendered from the record")
    return (tpl
            .replace("{{HERO_STAT}}", stat)
            .replace("{{ART_PRINCIPLE}}", pick_principle(data))
            .replace("{{ART_JOURNAL}}", pick_journal(data))
            .replace("{{ART_HYPOTHESIS}}", pick_hypothesis(data))
            .replace("{{ART_FLOOR}}", floor_snippet(data))
            .replace("{{ART_PROVENANCE}}", pick_provenance(data))
            .replace("{{GENERATED_AT}}", esc(data.get("generated_at", ""))))


def main():
    data = json.loads((ROOT / "data" / "arena.json").read_text(encoding="utf-8"))
    PUBLIC.mkdir(exist_ok=True)

    # the narrative landing at /
    (PUBLIC / "index.html").write_text(build_landing(data), encoding="utf-8")

    # the full interface at /floor/
    template = (ROOT / "web" / "template.html").read_text(encoding="utf-8")
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
