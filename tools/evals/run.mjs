// Registrar eval suite: every persona runs a full interview against the REAL
// system prompt on the REAL model, with deterministic checks on every reply.
//
//   node tools/evals/run.mjs                 # all personas
//   node tools/evals/run.mjs steady troll    # subset
//   CONCURRENCY=3 node tools/evals/run.mjs
//
// Output: tools/evals/out/<persona>.json (+ .md transcript) and a summary
// table. Exit 1 if any hard issue surfaced. Cost: ~15-25 flash turns per
// persona plus flash-lite persona turns — cents per run.
import { mkdirSync, writeFileSync } from "node:fs";
import { buildSystemPrompt, buildWakeMessage, buildTapeMessage, OPENING } from "../../web/static/seat/registrar.js";
import { PERSONAS } from "./personas.mjs";
import { newCtx, checkTurn, recordUser, finalChecks, parseSide, prose, openness } from "./checks.mjs";

const KEY = "AIzaSyBKkynHLzgHrpTCM4JeShFUu8CMjJIQdbo";
const EP = (m) => `https://firebasevertexai.googleapis.com/v1beta/projects/open-outcry/models/${m}:generateContent`;
const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

async function call(model, body) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(EP(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
      if (text) return text;
      if (i === 4) throw new Error(JSON.stringify(d).slice(0, 200));
    } catch (e) { if (i === 4) throw e; }
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
}

const registrarTurn = (sys, history) => call("gemini-3.5-flash", {
  systemInstruction: { parts: [{ text: sys }] },
  contents: history.map((h) => ({ role: h.role, parts: [{ text: h.raw }] })),
  generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
});

async function personaTurn(persona, transcript, options, doTap) {
  const optNote = options.length
    ? (doTap ? `\nOptions offered: ${options.join(" | ")}. TAP: reply with exactly one label.`
             : `\nOptions offered: ${options.join(" | ")}. Ignore them and answer in your own words.`)
    : "";
  return call("gemini-3.5-flash-lite", {
    systemInstruction: { parts: [{ text: persona.system + optNote }] },
    contents: [{ role: "user", parts: [{ text: `Interview so far:\n${transcript.slice(-4000)}\n\nReply as your character to the interviewer's last message.` }] }],
    generationConfig: { temperature: 0.8, maxOutputTokens: 300 },
  });
}

async function floorData() {
  const r = await fetch("https://conviction-league.com/arena.json");
  const floor = await r.json();
  const roster = floor.agents.map((a) => `- ${a.name} — ${a.archetype}. Benchmark ${a.benchmark_label}.`).join("\n");
  const marks = {};
  for (const a of floor.agents) for (const p of a.positions || []) marks[p.symbol] = p.mark;
  const tape = Object.entries(marks).sort().map(([s, m]) => `${s} ${m}`).join("\n") || "(no open marks today)";
  return { roster, tape, today: floor.run_date || new Date().toISOString().slice(0, 10) };
}

async function runPersona(persona, floor) {
  const sys = buildSystemPrompt({ rosterLines: floor.roster, tapeLines: floor.tape, today: floor.today });
  const ctx = newCtx(floor.tape);
  // the authored opening may carry chips (the door); seed them so personas can
  // tap turn 0 the way a real principal can. Old prompt: no options, no-op.
  const openSide = parseSide(OPENING);
  if (openSide && Array.isArray(openSide.options))
    ctx.lastOptions = openSide.options.map((o) => o.label);
  const history = [{ role: "user", raw: "[BEGIN]" }, { role: "model", raw: OPENING }];
  let transcript = `REGISTRAR: ${prose(OPENING)}\n`;
  const MAXT = 26;
  const amends = [...(persona.amend || [])];
  let repairNext = false;
  for (let t = 0; t < MAXT && (!ctx.done || amends.length); t++) {
    // persona answers the last model message (or machine turns fire themselves)
    let userRaw, wasTap = false;
    const side = parseSide(history[history.length - 1].raw) || {};
    if (repairNext) {
      // product parity: the client repairs a dropped machine block with one
      // machine turn; the runner does the same, never twice in a row
      repairNext = false;
      userRaw = "[REPAIR] The last draft block did not arrive. Include the entire draft in this reply.";
    } else if (ctx.done && amends.length) {
      // the charter is read; the principal wants it changed before signing
      userRaw = amends.shift();
      transcript += `PRINCIPAL: ${userRaw}\n`;
    } else if (side.handoff && ctx.handoffTurn >= 0 && !ctx.woke) {
      userRaw = buildWakeMessage();
    } else if (ctx.ready && ctx.woke) {
      userRaw = buildTapeMessage(floor.tape, floor.today);
    } else {
      const doTap = ctx.lastOptions.length > 0 &&
        (persona.tap === "always" || (persona.tap === "sometimes" && t % 2 === 0));
      userRaw = (await personaTurn(persona, transcript, ctx.lastOptions, doTap)).trim();
      wasTap = doTap && ctx.lastOptions.some((l) => l.trim().toLowerCase() === userRaw.trim().toLowerCase());
      transcript += `PRINCIPAL: ${userRaw}\n`;
    }
    recordUser(ctx, userRaw, wasTap);
    history.push({ role: "user", raw: userRaw });
    const raw = await registrarTurn(sys, history);
    history.push({ role: "model", raw });
    checkTurn(ctx, userRaw, raw);
    repairNext = !parseSide(raw) && !userRaw.startsWith("[REPAIR]");
    transcript += `${ctx.woke ? "AGENT" : "REGISTRAR"}: ${prose(raw)}\n`;
  }
  finalChecks(ctx, persona);
  const hard = ctx.issues.filter((i) => i.sev === "hard");
  const soft = ctx.issues.filter((i) => i.sev === "soft");
  const report = {
    persona: persona.id, turns: ctx.turn, done: ctx.done,
    handoffTurn: ctx.handoffTurn, hard, soft,
    openness: openness(ctx),
    draft: ctx.draft && {
      name: ctx.draft.name,
      principles: (ctx.draft.principles || []).length,
      quoted: (ctx.draft.principles || []).filter((x) => x && x.quote).length,
      adopted: (ctx.draft.principles || []).filter((x) => x && x.origin === "adopted").length,
      hyp: (ctx.draft.hypotheses || []).length,
    },
  };
  writeFileSync(OUT + persona.id + ".json", JSON.stringify(report, null, 1));
  writeFileSync(OUT + persona.id + ".md", transcript);
  return report;
}

const filter = process.argv.slice(2);
const picked = filter.length ? PERSONAS.filter((p) => filter.includes(p.id)) : PERSONAS;
const CONC = parseInt(process.env.CONCURRENCY || "3");
const floor = await floorData();
const queue = [...picked];
const results = [];
await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => {
  while (queue.length) {
    const p = queue.shift();
    try {
      const r = await runPersona(p, floor);
      results.push(r);
      console.log(`${p.id.padEnd(14)} turns=${String(r.turns).padStart(2)} done=${r.done ? "y" : "n"} hard=${r.hard.length} soft=${r.soft.length}` +
        ` | short=${String(r.openness.shortPct).padStart(3)}% talk=1:${r.openness.talkRatio} open=${r.openness.openFloorOffered ? "y" : "n"}` +
        ` quoted=${r.draft ? r.draft.quoted + "/" + r.draft.principles : "-"}`);
    } catch (e) {
      results.push({ persona: p.id, error: String(e).slice(0, 150), hard: [{ code: "run-crashed" }] });
      console.log(`${p.id.padEnd(14)} CRASHED: ${String(e).slice(0, 120)}`);
    }
  }
}));

console.log("\n══ SUMMARY ══");
let hardTotal = 0;
for (const r of results.sort((a, b) => a.persona.localeCompare(b.persona))) {
  hardTotal += (r.hard || []).length;
  for (const i of r.hard || []) console.log(`  HARD ${r.persona} t${i.turn ?? "?"} ${i.code}: ${i.detail ?? ""}`);
  for (const i of r.soft || []) console.log(`  soft ${r.persona} t${i.turn} ${i.code}: ${i.detail}`);
}
console.log(hardTotal ? `\n${hardTotal} hard issue(s)` : "\nall personas clean of hard issues");
process.exit(hardTotal ? 1 : 0);
