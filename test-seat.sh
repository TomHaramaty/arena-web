#!/usr/bin/env bash
# Local staging for the seat interview.
#   - Auth + Firestore are EMULATED: no production data, no real accounts, no email.
#   - The Registrar is REAL paid Gemini, so latency and feel are the genuine thing
#     (a few cents of credits per full interview; stop any time with Ctrl-C).
#   - Restarting this script wipes the emulator = a clean slate / fresh principal.
set -e
cd "$(dirname "$0")"

echo "Building the site…"
python3 render.py >/dev/null
echo
echo "Starting local staging…"
echo "  When it says 'All emulators ready', open:"
echo
echo "      http://localhost:5002/seat/"
echo
echo "  On the landing page click the dashed 'Dev sign-in — local test' button."
echo "  No email, no production writes. Stop with Ctrl-C."
echo
exec firebase emulators:start --only auth,firestore,hosting --project open-outcry
