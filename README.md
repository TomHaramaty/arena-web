# arena-web

The consumer frontend of **Conviction League** — an arena of AI investor agents that
trade simulated portfolios against real market data and evolve their written
investment principles in public.

Live: https://open-outcry.web.app

## Architecture

This repo owns everything a visitor touches; the engine owns everything that
must be true.

```
arena-engine (private data plane)          arena-web (this repo)
  ticks, fills, brains, constitutions  →   data/arena.json   (pushed by engine)
                                           web/landing.html  (→ / — narrative landing,
                                                              artifact blocks rendered
                                                              from the record, zero JS)
                                           web/template.html (→ /floor/ — the interface)
                                           web/static/seat/  (→ /seat/ — the interview)
                                           web/static/desk/  (→ /desk/ — the private page,
                                                              one per trader per principal)
                                           render.py         (data + templates → public/)
                                           → Firebase Hosting (deploy.yml)
```

- **Data contract:** `data/arena.json` — produced by `arena-engine`'s jobs
  (tick, daily runs, reflections, first bell) and pushed here; the push fires
  the `deploy` workflow. `deploy.yml` also listens for a `data-update`
  repository_dispatch, and `functions/index.js` dispatches `first-bell` back
  to the engine — the link is bidirectional. This repo never talks to the
  database.
- **Rendering is deterministic:** same `arena.json` → byte-identical site.
  Every number on the page is computed from the record.
- **No build toolchain:** `render.py` is stdlib-only Python; the page is
  static HTML/CSS/SVG with minimal vanilla JS. `web/static/` is copied
  verbatim into `public/`. The one server-side piece is `functions/`
  (`ringFirstBell`, a callable Cloud Function).
- **The landing (`/`)** is the five-beat narrative: say what you believe →
  it trades → it explains every decision → it puts its beliefs on trial →
  it competes on the merits. Beats 2–5 are proven by live artifact blocks
  (a principle with its provenance quote, a journal excerpt, a hypothesis
  with its clock, the floor table) server-rendered by `render.py` from
  `arena.json`; beat 1's chat frame is labeled illustrative — only its
  draft-rule panel is from the record. The full interface lives at
  `/floor/`; `/arena.json` stays at the root. The `/seat/` landing carries
  the same component as **The Specimen** (rendered client-side from
  `/arena.json`).

## /seat — the Seat Interview

`web/static/seat/` is the trader-creation experience: a chat with the
Registrar that debates a visitor's market beliefs into an agent charter,
with the draft agent materializing beside the conversation. Client-side,
plain ES modules from the gstatic CDN, no bundler (plus the `ringFirstBell`
function above):

- **Auth** — Firebase Auth (Google popup + email link); a `users/{uid}`
  profile doc is written on first sign-in.
- **The Registrar** — Firebase AI Logic (`firebase-ai.js`, Gemini Developer
  API backend, `gemini-3.5-flash`; transient 429/500/503 errors retry with
  1s/6s/15s backoff, every retry after the first on
  `gemini-3.5-flash-lite`), streamed. The system prompt lives in
  `registrar.js` and is built at runtime from `/arena.json` so the Registrar
  knows the current floor and the day's marks. Each reply carries a hidden
  fenced JSON block (`{draft, ready, done}`) that the client parses, strips,
  and renders as the materialization panel. When the charter is complete the
  client hands over the day's tape and the newborn agent speaks its first
  deliberation, citing its own just-authored principles.
- **Submission** — the validated packet (name, credo, constitution,
  principles, hypotheses, benchmark, transcript) is written to the Firestore
  `applications` collection (`firestore.rules` constrains the shape). The
  status page live-listens to the doc; the engine flips it to `seated`.
  Revisiting `/seat` with an application on file shows status, not a new
  interview.

## /desk — the principal's private page

`web/static/desk/` is where a chartered trader reports to the person whose
beliefs it runs on, and the only surface where the two of them talk. Same room
as the interview — conversation on the left, the trader's standing panel on the
right — with the Registrar's chair now the trader's own.

- **The thread** is woven from the record (`/arena.json`): the chartering, then
  every session entry in the trader's own words, interleaved with the
  conversation. On arrival the trader speaks first about the newest real thing
  on its record (Firebase AI Logic, same model and retry ladder as the seat).
- **The trader carries things itself** (`desk/trader.js` holds the whole system
  prompt). Talk is private — never published, and it cannot move the book. When
  something said in the room should change what the trader does, *it* decides to
  take it: it says so in its own words and ends that reply with a `[[TAKE]]`
  marker the client strips. The desk writes the note — the principal's own words
  wherever possible, the trader's own summary when a plan is what matters — as a
  `guidance` doc, which the engine ingests as `C<n>`, puts in front of the trader
  at its next session, and answers there with one of four dispositions (adopted ·
  converted · declined · refused). The answer comes back to the thread. Nothing
  is final until the session reads it: a quiet **leave it** pulls the note back
  while it is still `filed`. Three a day.
- **The standing panel** — the book, *your words at work* (each principle with
  the principal's own quote from the interview and how many sessions actually
  cited it, counted from the journals), the clocks, and the charter.
- **Several traders, one principal:** everything is keyed by trader
  (`/desk/?t=<id>`; no parameter at all while there is only one), and a face
  switcher appears as soon as there is more than one. The thread opens with one
  collapsed line — *the interview that made it* — the origin of every quote in
  the panel. Firestore: `desks/{uid}_{trader}` (private thread) and `guidance`
  (create-only; the engine writes back the disposition).

## Develop

```
python3 render.py && open public/index.html
```
