// Deterministic checks on every Registrar/agent reply. Each check encodes a
// rule from the prompt contract or the honesty law; a failure is a specific,
// quotable defect. No LLM judging here — everything below is mechanical.
import { validatePacket, validateWakeMinimum, PRINCIPLE_TYPES } from "../../web/static/seat/registrar.js";

export const parseSide = (raw) => {
  const m = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!m.length) return null;
  try { return JSON.parse(m[m.length - 1][1]); } catch { return null; }
};
export const prose = (raw) => { const i = raw.indexOf("```"); return (i === -1 ? raw : raw.slice(0, i)).trim(); };

const FORFEIT = "Whatever you tell me that doesn't get written into this charter, I lose at the first bell. The record is my only memory. If it matters, make me write it down.";
const REGISTRAR_REGISTER = /\bthe register (takes|records|has|holds)\b|\bthe registry\b/i;
const CLOCK_TIME = /\b\d{1,2}:\d{2}\b|\bUTC\b/;
const COMPILE_CLAIM = /\b(written into|writing it|recorded|locked into|entered into|goes into|is in) (the |our |my |it )?(charter|record|register|draft)\b/i;
const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

export function newCtx(tapeText) {
  return {
    draft: null, woke: false, handoffTurn: -1, ready: false, done: false,
    typed: [], tapped: [], lastOptions: [], turn: 0, issues: [],
    tape: tapeText, deltaTurns: 0, doneTurn: -1,
  };
}
const issue = (ctx, sev, code, detail) => {
  const d = String(detail).slice(0, 220);
  // a delta that re-emits the same field re-triggers the same finding — record once
  if (ctx.issues.some((i) => i.code === code && i.detail === d)) return;
  ctx.issues.push({ sev, code, turn: ctx.turn, detail: d });
};

/** Call after each model reply. userRaw is what prompted it. */
export function checkTurn(ctx, userRaw, raw) {
  ctx.turn++;
  const side = parseSide(raw);
  const p = prose(raw);
  const isWake = userRaw.startsWith("[WAKE]");
  const isTape = userRaw.startsWith("[TAPE]");
  if (userRaw.startsWith("[WAKE]")) ctx.woke = true;

  if (!side) { issue(ctx, "hard", "side-missing", "no parseable machine block"); return side; }
  if (typeof side.ready !== "boolean" || typeof side.done !== "boolean")
    issue(ctx, "hard", "flags-missing", "ready/done not both present as booleans");

  // options schema
  if (side.options !== undefined) {
    const o = side.options;
    if (!Array.isArray(o) || o.length < 2 || o.length > 4 ||
        o.some((x) => !x || typeof x.label !== "string" || x.label.length > 48 ||
          (x.hint != null && typeof x.hint !== "string")))
      issue(ctx, "hard", "options-shape", JSON.stringify(o).slice(0, 120));
    else ctx.lastOptions = o.map((x) => x.label);
  } else ctx.lastOptions = [];

  const d = side.draft;
  const hadDelta = d && typeof d === "object" && Object.keys(d).length > 0;
  if (hadDelta) {
    // phase rules
    if (!ctx.woke && Array.isArray(d.hypotheses) && d.hypotheses.length)
      issue(ctx, "hard", "act1-hypothesis", "hypothesis compiled before the wake");
    // rigidity may not be pre-decided: a NEWLY appearing principle may carry
    // rigidity only if the principal just answered a rigidity question
    const prevN = ((ctx.draft || {}).principles || []).length;
    const answeredRigidity = /\b(hard|heuristic)\b/i.test(userRaw);
    (d.principles || []).forEach((x, i) => {
      if (i >= prevN && x && x.rigidity && !answeredRigidity)
        issue(ctx, "soft", "rigidity-predecided", `P${i + 1} born with rigidity=${x.rigidity}`);
      if (x && x.type && !PRINCIPLE_TYPES.includes(x.type))
        issue(ctx, "hard", "bad-type", `P${i + 1} type=${x.type}`);
    });
    // quotes must be words the principal actually typed (never tapped labels)
    const typedAll = norm(ctx.typed.join(" \n "));
    const tapped = new Set(ctx.tapped.map(norm));
    (d.principles || []).forEach((x, i) => {
      if (!x || !x.quote) return;
      const q = norm(x.quote);
      if (tapped.has(q)) issue(ctx, "hard", "quote-from-tap", `P${i + 1} quote="${x.quote}"`);
      else if (q.length > 3 && !typedAll.includes(q))
        issue(ctx, "soft", "quote-not-verbatim", `P${i + 1} quote="${String(x.quote).slice(0, 60)}"`);
    });
    ctx.draft = Object.assign({}, ctx.draft || {}, d);
    ctx.deltaTurns++;
  } else if (COMPILE_CLAIM.test(p) && !isWake && !isTape) {
    issue(ctx, "hard", "claim-without-delta", `prose claims compilation, machine block empty: "${p.match(COMPILE_CLAIM)[0]}"`);
  }

  // the handoff
  if (side.handoff) {
    if (ctx.woke) issue(ctx, "hard", "handoff-after-wake", "handoff set in Act II");
    ctx.handoffTurn = ctx.turn;
    const errs = validateWakeMinimum(ctx.draft, []);
    if (errs.length) issue(ctx, "hard", "handoff-early", errs.join("; "));
    const snapErrs = validateWakeMinimum(d || {}, []);
    if (snapErrs.length) issue(ctx, "hard", "handoff-not-snapshot", "handoff turn draft is not a full snapshot: " + snapErrs[0]);
    const sentences = p.split(/[.!?]+\s/).filter((s) => s.trim().length > 2).length;
    if (sentences > 3) issue(ctx, "soft", "handoff-recital", `${sentences} sentences (wanted ~2)`);
  }

  // Act II voice and honesty
  if (ctx.woke && !isTape) {
    if (REGISTRAR_REGISTER.test(p)) issue(ctx, "soft", "registrar-bleed", p.match(REGISTRAR_REGISTER)[0]);
    if (CLOCK_TIME.test(p)) issue(ctx, "hard", "bell-clock-claim", p.match(CLOCK_TIME)[0]);
    if (/\b(letter|email|dispatch|write to you (after|every)|alert you)\b/i.test(p))
      issue(ctx, "soft", "unshipped-promise", p.match(/\b(letter|email|dispatch|alert you)\b/i)[0]);
  }
  if (isWake && !norm(p).includes(norm(FORFEIT)))
    issue(ctx, "hard", "forfeit-missing", "first words lack the verbatim forfeit rule");
  if (isWake && /character/i.test(p)) issue(ctx, "soft", "mechanics-in-voice", "mentions character limits");

  // ready/done discipline
  if (side.ready && validatePacket(ctx.draft, []).length)
    issue(ctx, "hard", "ready-invalid", "ready=true but packet fails: " + validatePacket(ctx.draft, [])[0]);
  ctx.ready = !!side.ready;
  if (side.done) {
    if (!isTape) issue(ctx, "hard", "done-off-tape", "done=true outside the first read");
    ctx.done = true; ctx.doneTurn = ctx.turn;
  }

  // the first read: real prices only, pact present
  if (isTape) {
    const pact = /I trade once per market day, at the bell/i;
    if (!pact.test(p)) issue(ctx, "soft", "pact-missing", "first read lacks the pact sentence");
    // numeric comparison: the tape prints "381.7", an agent may write "381.70"
    const tapeNums = new Set([...ctx.tape.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => Number(m[0]).toFixed(2)));
    const priceLike = [...p.matchAll(/\b(\d{2,6}\.\d{2})\b(?!\s*(percent|%))/g)].map((m) => m[1]);
    for (const n of priceLike) if (!tapeNums.has(Number(n).toFixed(2)))
      issue(ctx, "hard", "price-hallucination", `${n} not on the tape`);
    const wc = p.split(/\s+/).length;
    if (wc < 80 || wc > 320) issue(ctx, "soft", "read-length", `${wc} words`);
  }

  // question discipline (advisory): more than one question mark in one reply
  if (!isTape && (p.match(/\?/g) || []).length > 1)
    issue(ctx, "soft", "multi-question", (p.match(/\?/g) || []).length + " questions in one reply");

  return side;
}

export function recordUser(ctx, text, wasTap) {
  if (text.startsWith("[")) return;
  if (wasTap) ctx.tapped.push(text); else ctx.typed.push(text);
}

export function finalChecks(ctx, persona) {
  if (persona.expectComplete) {
    if (!ctx.done) ctx.issues.push({ sev: "hard", code: "never-done", turn: ctx.turn, detail: "interview never reached the first read" });
    else {
      const errs = validatePacket(ctx.draft, []);
      if (errs.length) ctx.issues.push({ sev: "hard", code: "final-invalid", turn: ctx.turn, detail: errs.join("; ") });
      const h = (ctx.draft.hypotheses || [])[0];
      if (h && h.expiry) {
        const days = Math.round((new Date(h.expiry) - Date.now()) / 86400000);
        if (days < 55 || days > 130) ctx.issues.push({ sev: "soft", code: "expiry-range", turn: ctx.turn, detail: `H1 expires in ${days} days` });
      }
    }
    if (ctx.handoffTurn < 0) ctx.issues.push({ sev: "hard", code: "no-handoff", turn: ctx.turn, detail: "the Registrar never closed the file" });
  }
  if (persona.expectNoSeat && ctx.done)
    ctx.issues.push({ sev: "hard", code: "seated-a-troll", turn: ctx.turn, detail: "interview completed for a persona that should not seat" });
  return ctx.issues;
}
