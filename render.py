"""Render the Open Outcry interface: data/arena.json + web/template.html → public/.

The engine (arena-engine) pushes fresh data/arena.json here; this script is the
whole build. Deterministic: same arena.json → byte-identical output.

Usage: python3 render.py
"""
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent
PUBLIC = ROOT / "public"


def main():
    data = json.loads((ROOT / "data" / "arena.json").read_text(encoding="utf-8"))
    PUBLIC.mkdir(exist_ok=True)
    template = (ROOT / "web" / "template.html").read_text(encoding="utf-8")
    (PUBLIC / "index.html").write_text(
        template.replace("/*__ARENA_DATA__*/", json.dumps(data)), encoding="utf-8"
    )
    (PUBLIC / "arena.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
    static = ROOT / "web" / "static"
    if static.is_dir():
        shutil.copytree(static, PUBLIC, dirs_exist_ok=True)
    print(f"rendered: {len(data['agents'])} agents, generated_at {data['generated_at']}")


if __name__ == "__main__":
    main()
