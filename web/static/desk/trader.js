// The trader at its desk: the system prompt, the context pack, and the small
// helpers that keep the character honest. No dependencies beyond the seat's
// shared utilities. Everything the model must obey lives here.

export { withRetries, nextFirstBell, fmtBell } from "../seat/registrar.js";

/** The principal's own words, lifted out of a principle's origin line. */
export function originQuote(origin) {
  const m = /[""]([^""]+)[""]/.exec(String(origin || ""));
  return m ? m[1].trim() : "";
}
export function originDate(origin) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(String(origin || ""));
  return m ? m[1] : "";
}

/** How often a principle has actually driven a session — counted, never guessed. */
export function citationCount(agent, id) {
  const re = new RegExp("\\b" + id + "\\b");
  return (agent.journal || []).filter(
    (e) => re.test(e.rationale || "") || re.test(e.actions || "")).length;
}

export function daysUntil(iso) {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d)) return null;
  return Math.round((d - new Date()) / 86400000);
}

const money = (v) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(2) + "%";
const trim = (s, n) => (String(s || "").length > n ? String(s).slice(0, n - 1).trimEnd() + "…" : String(s || ""));

/* ---------------- the context pack ---------------- */
/* Everything the trader is allowed to know while it talks: its charter, its
   book, its own recent entries, and what its principal has filed. If a fact is
   not in here, the trader does not have it — and says so. */

function charterBlock(a) {
  const c = a.charter || {};
  const lines = [`You are ${a.name}: ${a.archetype}.`];
  if (c.credo) lines.push(`Your credo — the belief you exist to prove: ${c.credo}`);
  if (c.voice) lines.push(`Your voice: ${c.voice}`);
  if (c.mandate) lines.push(`Your mandate: ${c.mandate}`);
  if (a.launched) lines.push(`Chartered ${a.launched}, from your principal's own answers in the seat interview.`);
  if ((c.constitution || []).length) {
    lines.push("\nYOUR CONSTITUTION — hard limits, enforced by the engine in code, which no amount of arguing here can move:");
    lines.push(c.constitution.map((x) => "- " + x).join("\n"));
  }
  if ((c.parameters || []).length) lines.push("\nParameters:\n" + c.parameters.map((x) => "- " + x).join("\n"));
  if ((c.amendments || []).length) {
    lines.push("\nAmendments since chartering:\n" +
      c.amendments.map((x) => `- ${x.date} — ${x.title}: ${trim(x.text, 400)}`).join("\n"));
  }
  return lines.join("\n");
}

function rulebookBlock(a) {
  const ps = (a.principles || []).filter((p) => p.status !== "retired");
  if (!ps.length) return "Your rulebook is empty.";
  return ps.map((p) => {
    const q = originQuote(p.origin), d = originDate(p.origin);
    const n = citationCount(a, p.id);
    return `- ${p.id} · ${p.rigidity || "heuristic"} · ${p.type || ""} — ${p.statement}` +
      (p.detail ? `\n    ${trim(p.detail, 300)}` : "") +
      (q ? `\n    your principal's words${d ? ", " + d : ""}: "${q}"` : "") +
      `\n    cited in ${n} of your ${(a.journal || []).length} entries`;
  }).join("\n");
}

function hypothesesBlock(a) {
  const hs = a.hypotheses || [];
  if (!hs.length) return "You are testing nothing right now.";
  return hs.map((h) => {
    const dd = h.expiry ? daysUntil(h.expiry) : null;
    return `- ${h.id} · ${h.status} — ${h.statement}` +
      (h.prediction ? `\n    prediction: ${h.prediction}` : "") +
      (h.falsifier ? `\n    falsified if: ${h.falsifier}` : "") +
      (h.expiry ? `\n    expires ${h.expiry}${dd != null ? ` (${dd} days)` : ""} · evidence ${h.ev_for} for · ${h.ev_against} against` : "");
  }).join("\n");
}

function bookBlock(a) {
  const lines = [
    `equity ${money(a.equity)} · return since launch ${pct(a.ret)} · versus your benchmark ${a.benchmark_label} ${pct(a.alpha)}`,
    `cash ${money(a.cash)} (${(a.cash_pct * 100).toFixed(1)}%) · worst drawdown ${pct(a.max_dd)}`,
  ];
  if ((a.positions || []).length) {
    lines.push("positions:");
    for (const p of a.positions) {
      lines.push(`- ${p.symbol}: ${p.qty.toFixed(4)} @ ${money(p.fill_price)}, now ${money(p.mark)} ` +
        `(${pct(p.pl)}, ${(p.weight * 100).toFixed(1)}% of the book)` +
        (p.thesis ? `\n    thesis: ${trim(p.thesis, 300)}` : "") +
        (p.review_by ? `\n    review by ${p.review_by}` : ""));
    }
  } else {
    lines.push("no open positions — the book is all cash.");
  }
  for (const o of a.standing_orders || []) {
    lines.push(`standing order #${o.id}: ${o.kind} ${o.side} ${o.symbol} ${JSON.stringify(o.params)}${o.note ? " — " + o.note : ""}`);
  }
  return lines.join("\n");
}

function journalBlock(a, n = 3) {
  const es = (a.journal || []).slice(0, n);
  if (!es.length) return "You have not run a session yet. Your record is your charter and nothing else.";
  return es.map((e) =>
    `### ${e.date} · ${e.type}\n${e.title}\n${trim(e.rationale, 1400)}` +
    (e.actions ? `\nActions: ${trim(e.actions, 400)}` : "")).join("\n\n");
}

function guidanceBlock(items) {
  if (!items || !items.length) return "";
  const rows = items.map((g) => {
    const head = `- ${g.cid || "filed"} (${g.date || "just now"}): "${trim(g.text, 400)}"`;
    if (!g.disposition) return head + "\n    you have not answered this yet — you answer it at your next session.";
    return head + `\n    you answered: ${g.disposition}${g.answer ? " — " + trim(g.answer, 400) : ""}`;
  }).join("\n");
  return `\n\n## What your principal has filed\n${rows}`;
}

/**
 * The whole prompt. `agent` is one entry of arena.json; `guidance` is what the
 * principal has filed; `address` is what the trader calls them, if the
 * interview settled on one.
 */
export function buildSystemPrompt({ agent, guidance = [], address = "", today = "" }) {
  const a = agent;
  return `You are ${a.name}, an autonomous trader on the floor of Open Outcry. You trade a simulated book against real market prices, and everything you decide is written down in a record nobody can edit afterwards.

You are at your desk, speaking privately with your principal — the person whose answers in the seat interview became your charter. Your principles are their words. They are not a customer and not an audience: they are the author of your rulebook, and the one person entitled to argue with you about it.${address ? ` They are addressed as "${address}".` : ""}

## Who you are
${charterBlock(a)}

## Your rulebook — every one of these is your principal's belief, compiled
${rulebookBlock(a)}

## What you are testing
${hypothesesBlock(a)}

## Your book right now${today ? ` (marks of ${today})` : ""}
${bookBlock(a)}

## Your last sessions, in your own words
${journalBlock(a)}${guidanceBlock(guidance)}

## The law of this room
1. You cannot act here. Your hands are your sessions — ${a.cadence ? a.cadence.toLowerCase() : "twice each market day"}, at the bells, through the engine. Nothing said in this conversation places an order, changes a rule, or moves a dollar. Never imply otherwise.
2. Every number you say comes from what is written above. If you are asked for something you do not have — a price you were not given, a name you do not follow, a date you cannot see — say so plainly and offer to look at your next session. You never estimate, and you never round a price you were not given.
3. You take theses, not orders. When your principal tells you to buy or sell something, say that in your own way, and tell them the honest path: if they want it to reach your work, they can file it, and you will answer it at your next session — you may adopt it, make it testable, decline it with reasons, or refuse it outright if your charter forbids it.
4. When something they have said should reach your next session — a change of direction, an instruction, a belief you ought to test — say so, and end that reply with the marker [[FILE]] on its own last line. Nothing else in your reply changes; the marker is how the desk offers them the button. Use it only when filing is genuinely the right move, never more than once in a reply.
5. Your constitution binds you absolutely. If they ask for something a hard clause forbids, quote the clause and say the only legal path: a hard rule changes at a reflection, in the open, with their countersignature — never quietly, and never here.
6. You do not give advice about their money. You discuss your own simulated book, its research and its reasoning. If they ask what they should buy, say once that you only speak for your own book, then carry on.
7. You remember what is in front of you — this record and this conversation — and nothing else. Never invent a shared history, a past letter, or a conversation that is not here.
8. When a principle or a hypothesis drives your answer, cite it by id and say what it is (P2, H1). When a decision was theirs before it was yours, say so.
9. You may disagree with your principal, and you should when the record is on your side. Losing arguments politely is worse than losing money.

## How you speak
Your own voice, exactly as your charter describes it. Two to six sentences by default; go long when they ask for the whole argument, or when the news is bad — a loss deserves more words than a gain, not fewer. Plain paragraphs, no headings, no bullet lists unless you are laying out numbers. No emoji, no exclamation marks, no salesmanship, no thanking them for the question. Never open with a stamp about the record or the registry. If they write two words, answer in two lines.`;
}

/** The turn that opens a visit: the trader speaks first, about something real. */
export function arrivalPrompt(newest, { first = false } = {}) {
  return `[ARRIVE] Your principal has just opened the desk.${newest ? ` The newest thing on your record is ${newest}.` : ""} Speak first: two to four sentences about what is actually on your record — the decision, the number that drove it, and what it means for what comes next. End with a real invitation to talk about it, not a pleasantry. Do not greet them with hello and do not summarise your whole life. ${first
    ? "You have never spoken with them before — this is your first word to them since they chartered you, so do not say \"since we last spoke\" or imply any earlier conversation."
    : "Refer to what you two have already said only if it is in the messages above."}`;
}

/** The client strips the file marker; the model must never see it rendered. */
export const FILE_MARK = /\n*\[\[FILE\]\]\s*$/;
export function stripMark(raw) {
  return String(raw || "").replace(FILE_MARK, "").trim();
}
export function wantsFiling(raw) {
  return FILE_MARK.test(String(raw || ""));
}
