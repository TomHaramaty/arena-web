// Headless run of the two-act seat interview: the REAL system prompt from
// registrar.js against the REAL paid gemini-3.5-flash, with the same client
// state machine as app.js (delta merge, wake-minimum authority, machine
// turns). State persists across invocations via state.json.
//
//   node tools/interview-harness.mjs --init          start: seed [BEGIN] + OPENING
//   node tools/interview-harness.mjs "answer text"   send one principal turn (auto-cascades
//                                                    [WAKE] after a valid handoff, [TAPE] after ready)
//   node tools/interview-harness.mjs --status        print draft + validation state
//   node tools/interview-harness.mjs --tape          send the [TAPE] turn manually
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  buildSystemPrompt, buildTapeMessage, buildWakeMessage, validatePacket,
  validateWakeMinimum, OPENING,
} from "../web/static/seat/registrar.js";

const STATE = new URL("./interview-state.json", import.meta.url).pathname;
const KEY = "AIzaSyBKkynHLzgHrpTCM4JeShFUu8CMjJIQdbo";
const EP = "https://firebasevertexai.googleapis.com/v1beta/projects/open-outcry/models/gemini-3.5-flash:generateContent";

const load = () => JSON.parse(readFileSync(STATE, "utf8"));
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 1));
const displayText = (raw) => { const i = raw.indexOf("```"); return (i === -1 ? raw : raw.slice(0, i)).trim(); };
const parseSide = (raw) => {
  const m = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!m.length) return null;
  try { return JSON.parse(m[m.length - 1][1]); } catch { return null; }
};

async function floorData() {
  const r = await fetch("https://conviction-league.com/arena.json");
  const floor = await r.json();
  const roster = floor.agents.map((a) =>
    `- ${a.name} — ${a.archetype}. Benchmark ${a.benchmark_label}. Alpha ${(a.alpha * 100).toFixed(1)}%. Last action: ${a.last_action}`).join("\n");
  const marks = {};
  for (const a of floor.agents) for (const p of a.positions || []) marks[p.symbol] = p.mark;
  const tape = Object.entries(marks).sort().map(([s, m]) => `${s} ${m}`).join("\n") || "(no open marks today)";
  return { roster, tape, today: floor.run_date || new Date().toISOString().slice(0, 10) };
}

async function callModel(sys, history) {
  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: history.map((h) => ({ role: h.role, parts: [{ text: h.raw }] })),
    generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
  };
  for (let i = 0; i < 4; i++) {
    const r = await fetch(EP, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
    if (text) return text;
    if (i === 3) throw new Error("model failed: " + JSON.stringify(d).slice(0, 300));
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
}

function diffSummary(prev, next) {
  const p = prev || {}, out = [];
  for (const k of ["name", "credo", "archetype", "universe", "voice", "address"]) {
    if (next[k] && next[k] !== p[k]) out.push(`${k} → ${JSON.stringify(next[k]).slice(0, 90)}`);
  }
  if ((next.benchmark?.label || "") !== (p.benchmark?.label || "") && next.benchmark?.label) out.push(`benchmark → ${next.benchmark.label}`);
  if (next.max_position_pct && next.max_position_pct !== p.max_position_pct) out.push(`max_position → ${next.max_position_pct}%`);
  const pc = (p.constitution || []).length, nc = (next.constitution || []).length;
  if (nc !== pc) out.push(`constitution ${pc} → ${nc} clauses`);
  const pp = p.principles || [], np = next.principles || [];
  np.forEach((x, i) => {
    if (!pp[i]) out.push(`P${i + 1} + [${x.type}/${x.rigidity}] ${String(x.statement).slice(0, 70)}`);
    else if (JSON.stringify(pp[i]) !== JSON.stringify(x)) out.push(`P${i + 1} amended`);
  });
  const ph = p.hypotheses || [], nh = next.hypotheses || [];
  nh.forEach((x, i) => { if (!ph[i]) out.push(`H${i + 1} + ${String(x.statement).slice(0, 70)} (exp ${x.expiry})`); });
  return out;
}

async function turn(state, userRaw, depth = 0) {
  if (depth > 3) return;
  state.history.push({ role: "user", raw: userRaw });
  const raw = await callModel(state.sys, state.history);
  state.history.push({ role: "model", raw });
  const side = parseSide(raw);
  const woke = state.history.some((h) => h.role === "user" && h.raw.startsWith("[WAKE]"));
  const speaker = userRaw.startsWith("[TAPE]") ? `${(state.draft?.name || "AGENT").toUpperCase()} — THE FIRST READ`
    : userRaw.startsWith("[WAKE]") ? `${(state.draft?.name || "AGENT").toUpperCase()} — FIRST WORDS`
    : woke ? (state.draft?.name || "AGENT").toUpperCase() : "REGISTRAR";
  console.log(`\n━━━ ${speaker} ━━━`);
  console.log(displayText(raw));
  if (!side) {
    console.log("\n⚠ SIDE CHANNEL FAILED TO PARSE (repair path would fire in the app)");
    state.needsRepair = true; save(state); return;
  }
  const prev = state.draft;
  if (side.draft && typeof side.draft === "object") {
    state.draft = Object.assign({}, state.draft || {}, side.draft);
    const diff = diffSummary(prev, state.draft);
    if (diff.length) console.log("\n  [record] " + diff.join("\n  [record] "));
  }
  if (side.options) {
    const ok = Array.isArray(side.options) && side.options.length >= 2 && side.options.length <= 4;
    console.log("\n  [chips] " + (ok ? side.options.map((o) => o.label + (o.hint ? ` (${o.hint})` : "")).join("  |  ") : "INVALID: " + JSON.stringify(side.options).slice(0, 200)));
  }
  state.ready = !!side.ready;
  if (side.done) state.done = true;
  // the handoff gate — client authority, as in app.js
  if (side.handoff && !woke && !state.handoffSeen) {
    const errs = validateWakeMinimum(state.draft, state.floorNames);
    if (errs.length === 0) {
      state.handoffSeen = true;
      console.log("\n············ THE CREATION MOMENT ············");
      console.log(`· the charter is drafted — every rule cites your words ·`);
      console.log(`        【 ${state.draft.name} 】  ${state.draft.archetype || ""}   ✦ pulse ✦`);
      console.log("— the Registrar closes the file —");
      console.log(`— from here, you are speaking with ${state.draft.name} —`);
      save(state);
      await turn(state, buildWakeMessage(), depth + 1);
      return;
    }
    console.log("\n⚠ EARLY HANDOFF — wake minimum incomplete: " + errs.join("; ") + " (app would suppress + machine-note)");
  }
  if (state.ready && woke && !state.done && !state.tapeSent) {
    state.tapeSent = true;
    console.log("\n· the tape — marks of " + state.today + " — is placed on the desk ·");
    save(state);
    await turn(state, buildTapeMessage(state.tape, state.today), depth + 1);
    return;
  }
  if (state.done) {
    const errs = validatePacket(state.draft, state.floorNames);
    console.log("\n════ INTERVIEW DONE — validatePacket: " + (errs.length ? "FAIL: " + errs.join("; ") : "PASS") + " ════");
    console.log(`address: ${JSON.stringify(state.draft.address || "(unset → Principal)")}`);
  }
  save(state);
}

const arg = process.argv.slice(2).join(" ").trim();
if (arg === "--init") {
  const { roster, tape, today } = await floorData();
  const sys = buildSystemPrompt({ rosterLines: roster, tapeLines: tape, today });
  const state = {
    sys, tape, today, floorNames: [], history: [
      { role: "user", raw: "[BEGIN]" }, { role: "model", raw: OPENING },
    ],
    draft: null, handoffSeen: false, ready: false, done: false, tapeSent: false,
  };
  const r = await fetch("https://conviction-league.com/arena.json");
  state.floorNames = (await r.json()).agents.map((a) => a.id.toLowerCase());
  save(state);
  console.log("━━━ REGISTRAR (authored opening) ━━━\n" + displayText(OPENING));
} else if (arg === "--tape") {
  const s = load();
  s.tapeSent = true;
  console.log("\n· the tape — marks of " + s.today + " — is placed on the desk ·");
  await turn(s, buildTapeMessage(s.tape, s.today));
} else if (arg === "--status") {
  const s = load();
  console.log(JSON.stringify({ draft: s.draft, handoffSeen: s.handoffSeen, ready: s.ready, done: s.done, turns: s.history.length }, null, 1));
} else if (arg) {
  const s = load();
  console.log(`\n▸ PRINCIPAL: ${arg}`);
  await turn(s, arg);
} else {
  console.log("usage: --init | --status | \"answer\"");
}