"""Which traders on the record have no rendered face yet.

The deploy asks this before it builds, and skips the whole avatar apparatus — an
npm install, a headless Chrome — on the ~37 deploys a day where the answer is
none. Prints a GitHub Actions output line so the steps that follow can be
conditional on it:

    ids=glide,ledger        # render these
    ids=                    # nothing to do

Reads data/arena.json (what the engine pushes, and what the generator itself
reads) against web/static/avatars — the roster about to be built, against the
faces this repo actually ships.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from check_build import ROOT, missing_face_ids   # noqa: E402

RECORD = ROOT / "data" / "arena.json"
AVATARS = ROOT / "web" / "static" / "avatars"


def ids():
    if not RECORD.exists():
        return []
    try:
        data = json.loads(RECORD.read_text(encoding="utf-8"))
    except ValueError:
        # An unparseable record is the build check's problem to report, not this
        # one's to guess at. Render nothing.
        return []
    return missing_face_ids(data, AVATARS)


def main():
    found = ids()
    print("ids=" + ",".join(found))
    if found:
        print(f"faces to render: {', '.join(found)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
