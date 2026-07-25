// Open Outcry — the Seat Interview.
// One page, four states: landing → interview → charter review → application status.
// Everything runs client-side: Firebase Auth (identity), Firebase AI Logic
// (the Registrar, streamed), Firestore (the application). No backend.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, collection, query,
  where, limit, getDocs, onSnapshot, serverTimestamp, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getAI, getGenerativeModel, GoogleAIBackend,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-ai.js";
import {
  buildSystemPrompt, buildTapeMessage, validatePacket, nextFirstBell, fmtBell,
  withRetries, OPENING, NAME_RE, PRINCIPLE_TYPES,
} from "./registrar.js";

const app = initializeApp({
  projectId: "open-outcry",
  appId: "1:56794274079:web:1fe7981df1430587e2782a",
  apiKey: "AIzaSyBKkynHLzgHrpTCM4JeShFUu8CMjJIQdbo",
  authDomain: "open-outcry.firebaseapp.com",
  storageBucket: "open-outcry.firebasestorage.app",
  messagingSenderId: "56794274079",
});
const auth = getAuth(app);
const db = getFirestore(app);
// Local test rig: on localhost, auth and the database are emulators — no real
// accounts, no production data. The Registrar (AI Logic) stays real.
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
const ai = getAI(app, { backend: new GoogleAIBackend() });
const MODEL_ID = "gemini-3.5-flash";
// Same contract, same prompt — used only for the last retry when the primary
// model keeps returning transient errors (free-tier congestion).
const FALLBACK_MODEL_ID = "gemini-3.5-flash-lite";

const MAX_TURNS = 48;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
// minimal markdown: bold, italics, inline code — nothing else.
const md = (s) => esc(s)
  .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)]|$)/gm, "$1<em>$2</em>")
  .replace(/`([^`\n]+)`/g, "<code>$1</code>");

const state = {
  user: null,
  floor: null,          // arena.json (or null if unreachable)
  floorNames: [],
  model: null,
  fallback: null,
  undelivered: null,    // a PRINCIPAL bubble awaiting redelivery
  history: [],          // [{role:'user'|'model', raw}]
  draft: null,          // accumulated draft (deltas merged in)
  streaming: false,     // a model turn is in flight (composer may already be unlocked)
  queued: null,         // {raw, el} — one message sent while the tail was still streaming
  needsRepair: false,   // last side-channel failed to parse; next turn requests a full draft
  ready: false,
  done: false,
  tapeSent: false,
  busy: false,
  appDoc: null,         // {id, data}
  unsubscribe: null,
};

/* ---------------- view switching ---------------- */
const VIEWS = ["loading", "landing", "interview", "finish", "status"];
function show(view) {
  for (const v of VIEWS) $("#view-" + v).hidden = v !== view;
  window.scrollTo({ top: 0 });
}

/* ---------------- floor data ---------------- */
async function loadFloor() {
  try {
    const r = await fetch("/arena.json", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    state.floor = await r.json();
    state.floorNames = state.floor.agents.map((a) => a.id.toLowerCase());
  } catch {
    state.floor = null;
    state.floorNames = [];
  }
}
function rosterLines() {
  if (!state.floor) return "(roster unavailable this session — rely on general differentiation)";
  return state.floor.agents.map((a) =>
    `- ${a.name} — ${a.archetype}. Benchmark ${a.benchmark_label}. Alpha ${(a.alpha * 100).toFixed(1)}%. Last action: ${a.last_action}`
  ).join("\n");
}
function tapeLines() {
  if (!state.floor) return "(tape unavailable)";
  const marks = {};
  for (const a of state.floor.agents) for (const p of a.positions || []) marks[p.symbol] = p.mark;
  const rows = Object.entries(marks).sort().map(([s, m]) => `${s} ${m}`);
  return rows.join("\n") || "(no open marks today)";
}
function today() {
  return (state.floor && state.floor.run_date) || new Date().toISOString().slice(0, 10);
}

/* The Specimen: one real principle from the record, and what it became. */
function renderSpecimen() {
  if (!state.floor) return;
  const agent = state.floor.agents.find((a) => a.id === "ballast") ||
    state.floor.agents.find((a) => (a.principles || []).some((p) => /["“]/.test(p.origin || "")));
  if (!agent) return;
  const prins = agent.principles || [];
  const p = prins.find((x) => x.rigidity === "hard" && /["“]/.test(x.origin || "")) ||
    prins.find((x) => /["“]/.test(x.origin || ""));
  if (!p) return;
  const qm = (p.origin || "").match(/["“](.+?)["”]\)?\s*$/);
  const dm = (p.origin || "").match(/\d{4}-\d{2}-\d{2}/);
  $("#specimenbody").innerHTML = `
    <div class="dname" style="font-size:17px;margin-top:10px">${esc(agent.id)}<span class="arch">${esc(agent.archetype)}</span></div>
    <div class="dprin" style="margin-top:10px">
      <div class="tags"><span class="tag">${esc(p.id || "P")}</span><span class="tag">${esc(p.type || "")}</span><span class="tag ${p.rigidity === "hard" ? "hard" : ""}">${esc(p.rigidity || "")}</span></div>
      <div class="stmt">${esc(p.statement)}</div>
      ${qm ? `<div class="quote">“${esc(qm[1])}” — the principal${dm ? ", " + esc(dm[0]) : ""}</div>` : ""}
    </div>
    <p class="specbecame">Said in an interview${dm ? " on " + esc(dm[0]) : ""}; now a ${esc(p.rigidity || "")} rule ${esc(agent.id)} can never argue past alone. Every rule on this floor carries the words that made it.</p>`;
  $("#specimen").hidden = false;
}

/* ---------------- auth ---------------- */
const EMAIL_KEY = "oo.seat.emailForSignIn";

async function completeEmailLink() {
  if (!isSignInWithEmailLink(auth, location.href)) return;
  let email = localStorage.getItem(EMAIL_KEY);
  if (!email) email = window.prompt("Confirm the email you used to request the sign-in link:");
  if (!email) return;
  try {
    await signInWithEmailLink(auth, email, location.href);
    localStorage.removeItem(EMAIL_KEY);
    history.replaceState(null, "", location.pathname);
  } catch (e) {
    landingError("That sign-in link did not work — request a fresh one. (" + e.code + ")");
  }
}

async function ensureUserDoc(user) {
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        displayName: user.displayName || null,
        email: user.email || null,
        createdAt: serverTimestamp(),
      });
    }
  } catch (e) { console.warn("users doc:", e); }
}

function landingError(msg) { const el = $("#signinerr"); el.textContent = msg; el.hidden = !msg; }

function renderAuthChip() {
  const chip = $("#authchip");
  if (!state.user) { chip.hidden = true; chip.innerHTML = ""; return; }
  chip.hidden = false;
  chip.innerHTML = `${esc(state.user.email || state.user.displayName || "signed in")} · <a href="#" id="signoutlink">sign out</a>`;
  $("#signoutlink").addEventListener("click", async (e) => {
    e.preventDefault();
    await signOut(auth);
    location.reload();
  });
}

/* ---------------- application lookup / status ---------------- */
async function findApplication(uid) {
  try {
    const q = query(collection(db, "applications"), where("uid", "==", uid), limit(1));
    const snaps = await getDocs(q);
    if (snaps.empty) return null;
    const d = snaps.docs[0];
    return { id: d.id, data: d.data() };
  } catch (e) { console.warn("application lookup:", e); return null; }
}

function renderStatus(appData) {
  const name = (appData.packet && appData.packet.name) || "your agent";
  const seated = appData.status === "seated";
  const dot = $("#statusdot");
  dot.classList.toggle("done", seated);
  if (seated) {
    $("#statusword").textContent = "Seated";
    $("#statusdetail").innerHTML =
      `<b>${esc(name)}</b> holds a seat on the floor. Its record is public from its first entry onward — every trade, every rule, every reflection.`;
    $("#statusbell").textContent = "";
    $("#statuslinks").innerHTML = `<a href="/floor/">Watch ${esc(name)} on the floor →</a>`;
  } else {
    $("#statusword").textContent = "Application received";
    $("#statusdetail").innerHTML =
      `<b>${esc(name)}</b> is being seated. The charter is on the register; the record opens at the first bell.`;
    $("#statusbell").textContent = "First bell " + fmtBell(nextFirstBell());
    $("#statuslinks").innerHTML = `<a href="/floor/">Watch the floor while you wait →</a>`;
  }
}

function watchApplication(id) {
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = onSnapshot(doc(db, "applications", id), (snap) => {
    if (snap.exists()) renderStatus(snap.data());
  }, (e) => console.warn("status listener:", e));
}

/* ---------------- interview persistence ----------------
   Two copies: localStorage (instant) and drafts/{uid} in Firestore (survives
   a cleared cache, a crash, another device). Mirrored once per completed
   model turn — never per keystroke. Restore takes whichever history is
   longer. Abandoned mirrors double as per-beat funnel data. */
const saveKey = () => "oo.seat.interview." + (state.user ? state.user.uid : "anon");
const draftRef = () => doc(db, "drafts", state.user.uid);
function saveInterview() {
  const data = {
    history: state.history, tapeSent: state.tapeSent, done: state.done, ready: state.ready,
  };
  try { localStorage.setItem(saveKey(), JSON.stringify(data)); } catch { /* quota — the mirror still has it */ }
  if (state.user) {
    setDoc(draftRef(), { ...data, updatedAt: serverTimestamp() })
      .catch((e) => console.warn("draft mirror:", e));
  }
}
function loadInterview() {
  try { return JSON.parse(localStorage.getItem(saveKey()) || "null"); } catch { return null; }
}
async function loadInterviewMirror() {
  if (!state.user) return null;
  try {
    const snap = await getDoc(draftRef());
    return snap.exists() ? snap.data() : null;
  } catch (e) { console.warn("draft mirror read:", e); return null; }
}
/** Local vs mirrored copy: the longer history wins. */
function pickSaved(local, remote) {
  const len = (s) => (s && s.history ? s.history.length : 0);
  if (!len(local) && !len(remote)) return null;
  return len(remote) > len(local) ? remote : local;
}
function clearInterview() {
  localStorage.removeItem(saveKey());
  if (state.user) deleteDoc(draftRef()).catch(() => {});
}

/* ---------------- chat rendering ---------------- */
function displayText(raw) {
  // hide the machine channel: cut at the first fence
  const i = raw.indexOf("```");
  return (i === -1 ? raw : raw.slice(0, i)).trim();
}
function parseSideChannel(raw) {
  const m = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!m.length) return null;
  try { return JSON.parse(m[m.length - 1][1]); } catch { return null; }
}
function addMsg(cls, who, html) {
  const log = $("#chatlog");
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.innerHTML = (who ? `<div class="who">${esc(who)}</div>` : "") + (cls === "sys" ? html : `<div class="text">${html}</div>`);
  log.appendChild(el);
  el.scrollIntoView({ block: "end" });
  return el;
}
function renderModelMsg(raw, { first = false } = {}) {
  const who = first ? ((state.draft && state.draft.name ? state.draft.name.toUpperCase() : "THE AGENT") + " — FIRST WORDS") : "REGISTRAR";
  return addMsg(first ? "first" : "reg", who, md(displayText(raw)));
}
function renderUserMsg(raw) {
  if (raw === "[BEGIN]") return null;
  if (raw.startsWith("[TAPE]")) {
    const dm = raw.match(/\d{4}-\d{2}-\d{2}/);
    return addMsg("sys", null, `· the tape — marks of ${dm ? esc(dm[0]) : "the last session"} — is placed on the desk ·`);
  }
  return addMsg("me", "PRINCIPAL", md(raw));
}

/* ---------------- the materialization panel ---------------- */
function daysUntil(iso) {
  const t = new Date(iso + "T00:00:00Z") - new Date();
  return Math.max(0, Math.round(t / 86400000));
}
/* The checklist header: honest progress, derived from the same requirements
   validatePacket enforces. Answers "how much longer?" without the Registrar
   breaking character — no fake progress, only what the charter still needs. */
function checklistItems(d) {
  const n = d || {};
  const prins = (n.principles || []).filter((x) =>
    x && x.statement && PRINCIPLE_TYPES.includes(x.type) && ["hard", "heuristic"].includes(x.rigidity)).length;
  const hyps = (n.hypotheses || []).filter((h) =>
    h && h.statement && h.prediction && h.falsifier && /^\d{4}-\d{2}-\d{2}$/.test(h.expiry || "")).length;
  const mp = Number(n.max_position_pct);
  return [
    ["name", NAME_RE.test(n.name || "")],
    ["credo", !!n.credo],
    [`principles ${prins}/2`, prins >= 2],
    [`hypothesis ${hyps}/1`, hyps >= 1],
    ["benchmark", !!(n.benchmark && Array.isArray(n.benchmark.symbols) && n.benchmark.symbols.length && n.benchmark.label)],
    ["limits", !!(n.universe && mp > 0 && mp <= 35 && (n.constitution || []).length)],
    ["voice", !!n.voice],
  ];
}
function renderChecklist() {
  $("#draftcount").innerHTML = checklistItems(state.draft).map(([label, ok]) =>
    `<span class="chk ${ok ? "on" : ""}">${esc(label)} ${ok ? "✓" : "—"}</span>`).join("");
}
function renderDraft() {
  const d = state.draft;
  const body = $("#draftbody");
  renderChecklist();
  const count =
    (d ? (d.constitution || []).length + (d.principles || []).length + (d.hypotheses || []).length +
      ["name", "credo", "benchmark", "voice"].filter((k) => d[k]).length : 0);
  if (!d || !count) {
    body.innerHTML = `<p class="dempty">Nothing on the register yet. It fills as you answer — name, credo, constitution, principles, hypotheses, benchmark.</p>`;
    return;
  }
  let h = "";
  h += `<div class="dsec" data-sec="name"><span class="label">Agent</span><div class="dname">${d.name ? esc(d.name) : '<span class="dwait">unnamed</span>'}${d.archetype ? `<span class="arch">${esc(d.archetype)}</span>` : ""}</div></div>`;
  if (d.credo) h += `<div class="dsec" data-sec="credo"><span class="label">Credo</span><div class="dcredo">“${esc(d.credo)}”</div></div>`;
  if (d.benchmark && d.benchmark.label) h += `<div class="dsec" data-sec="benchmark"><span class="label">Benchmark</span><div class="dmono">${esc(d.benchmark.label)} — the lazy twin</div></div>`;
  if (d.universe) h += `<div class="dsec" data-sec="universe"><span class="label">Universe</span><div class="dmono">${esc(d.universe)}</div></div>`;
  if (d.max_position_pct) h += `<div class="dsec" data-sec="limits"><span class="label">Max position</span><div class="dmono">${esc(String(d.max_position_pct))}% of equity</div></div>`;
  if ((d.constitution || []).length) {
    h += `<div class="dsec" data-sec="constitution"><span class="label">Constitution — enforced in code</span><ul class="dlist">` +
      d.constitution.map((c) => `<li>${esc(c)}</li>`).join("") + `</ul></div>`;
  }
  if ((d.principles || []).length) {
    h += `<div class="dsec" data-sec="principles"><span class="label">Principles</span>` + d.principles.map((p, i) => `
      <div class="dprin"><div class="tags"><span class="tag">P${i + 1}</span><span class="tag">${esc(p.type || "?")}</span><span class="tag ${p.rigidity === "hard" ? "hard" : ""}">${esc(p.rigidity || "?")}</span></div>
      <div class="stmt">${esc(p.statement || "")}</div>
      ${p.quote ? `<div class="quote">“${esc(p.quote)}” — the principal</div>` : ""}</div>`).join("") + `</div>`;
  }
  if ((d.hypotheses || []).length) {
    h += `<div class="dsec" data-sec="hypotheses"><span class="label">Hypotheses — testing</span>` + d.hypotheses.map((x, i) => `
      <div class="dprin dhyp"><div class="tags"><span class="tag">H${i + 1}</span></div>
      <div class="stmt">${esc(x.statement || "")}</div>
      ${x.falsifier ? `<div class="quote">Falsified if: ${esc(x.falsifier)}</div>` : ""}
      ${x.expiry ? `<div class="clock">expires ${esc(x.expiry)} · ${daysUntil(x.expiry)} days on the clock</div>` : ""}</div>`).join("") + `</div>`;
  }
  if (d.voice) h += `<div class="dsec" data-sec="voice"><span class="label">Voice</span><div class="dcredo" style="font-size:13.5px">${esc(d.voice)}</div></div>`;
  body.innerHTML = h;
}

/* Inscription lines: computed by the client from the diff between consecutive
   parsed drafts — never authored by the model, so the line is true by
   construction. On mobile this IS the materialization (the sheet is closed);
   tapping a line opens the sheet at that entry. */
function draftInscriptions(prev, next) {
  const p = prev || {}, lines = [];
  const push = (text, sec) => lines.push({ text, sec });
  if (next.name && next.name !== p.name) push(`name set — ${next.name}`, "name");
  if (next.credo && next.credo !== p.credo) push(p.credo ? "credo revised" : "credo added to the draft", "credo");
  const pb = (p.benchmark && p.benchmark.label) || "", nb = (next.benchmark && next.benchmark.label) || "";
  if (nb && nb !== pb) push(`benchmark set — ${nb}`, "benchmark");
  if (next.universe && next.universe !== p.universe) push("universe set", "universe");
  if (next.max_position_pct && next.max_position_pct !== p.max_position_pct)
    push(`limit set — max position ${next.max_position_pct}%`, "limits");
  const pc = (p.constitution || []).length, nc = (next.constitution || []).length;
  if (nc > pc) push(nc - pc === 1 ? "constitution — clause added" : `constitution — ${nc - pc} clauses added`, "constitution");
  const pp = p.principles || [], np = next.principles || [];
  np.forEach((x, i) => {
    if (!x || !x.statement) return;
    const old = pp[i];
    if (!old) push(`P${i + 1} added to the draft — ${x.type || "?"}, ${x.rigidity || "?"}`, "principles");
    else if (JSON.stringify(old) !== JSON.stringify(x)) push(`P${i + 1} amended`, "principles");
  });
  const ph = p.hypotheses || [], nh = next.hypotheses || [];
  nh.forEach((x, i) => {
    if (!x || !x.statement) return;
    if (!ph[i]) push(`H${i + 1} added to the draft${x.expiry ? ` — expires ${x.expiry}` : ""}`, "hypotheses");
    else if (JSON.stringify(ph[i]) !== JSON.stringify(x)) push(`H${i + 1} amended`, "hypotheses");
  });
  if (next.voice && next.voice !== p.voice) push("voice recorded", "voice");
  return lines;
}
function renderInscriptions(prev, next) {
  for (const { text, sec } of draftInscriptions(prev, next)) {
    const el = addMsg("sys inscribe", null, `· ${esc(text)} ·`);
    el.addEventListener("click", () => {
      const col = $("#draftcol");
      if (window.matchMedia("(max-width: 899px)").matches && !col.classList.contains("open")) {
        col.classList.add("open");
        $("#drafttoggle").setAttribute("aria-expanded", "true");
        $("#draftcaret").textContent = "▾";
      }
      const target = $(`#draftbody [data-sec="${sec}"]`);
      if (target) target.scrollIntoView({ block: "nearest" });
    });
  }
}

/* ---------------- the interview engine ---------------- */
function buildModel() {
  const sys = buildSystemPrompt({ rosterLines: rosterLines(), tapeLines: tapeLines(), today: today() });
  const mk = (id) => getGenerativeModel(ai, {
    model: id,
    systemInstruction: sys,
    // 4096: the full-draft snapshot turns (ready / first words / repair) must
    // never truncate — a cut-off side channel is a soft-locked interview.
    generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
  });
  state.model = mk(MODEL_ID);
  state.fallback = mk(FALLBACK_MODEL_ID);
}

function setBusy(b) {
  state.busy = b;
  $("#composer").dataset.busy = String(b);
  $("#send").disabled = b;
  $("#input").disabled = b;
}

async function streamOnce(model, contents, textEl, onProseDone) {
  let raw = "";
  let proseDone = false;
  const result = await model.generateContentStream({ contents });
  for await (const chunk of result.stream) {
    raw += chunk.text();
    textEl.innerHTML = md(displayText(raw));
    // the visible reply ends at the first fence; the rest is the machine tail
    if (!proseDone && raw.includes("```")) { proseDone = true; if (onProseDone) onProseDone(); }
  }
  if (!raw.trim()) throw new Error("[503] empty reply");
  return raw;
}

/** Terminal failure of a turn: never lose the principal's words. */
function failTurn(userRaw, userEl, e) {
  const err = $("#chaterr");
  err.innerHTML = "";
  if (userRaw.startsWith("[TAPE]")) {
    if (userEl) userEl.remove();
    state.tapeSent = false;
    err.append("The connection dropped while your agent was reading the tape. ");
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "plain errretry"; btn.textContent = "Retry";
    btn.addEventListener("click", () => {
      err.hidden = true;
      state.tapeSent = true;
      sendTurn(buildTapeMessage(tapeLines(), today()));
    });
    err.append(btn);
  } else {
    if (userEl) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "undelivered";
      btn.textContent = "not delivered — retry";
      btn.addEventListener("click", () => {
        const input = $("#input");
        if (input.value.trim() === userRaw) { input.value = ""; input.style.height = ""; }
        sendTurn(userRaw); // sendTurn removes the undelivered bubble itself
      });
      userEl.appendChild(btn);
      state.undelivered = userEl;
    }
    const input = $("#input");
    if (!input.value) input.value = userRaw; // fallback: the words come home
    err.textContent = "That didn't send — your message is kept. Retry when ready. (" + ((e && e.message) || e) + ")";
  }
  err.hidden = false;
}

async function sendTurn(userRaw) {
  if (state.busy || state.done) return;
  // prose is on screen but the machine tail is still streaming: take the
  // message now, hold it until the turn's history entry lands.
  if (state.streaming) {
    if (state.queued) return;
    state.queued = { raw: userRaw, el: renderUserMsg(userRaw) };
    setBusy(true);
    return;
  }
  const queuedEl = state.queued && state.queued.raw === userRaw ? state.queued.el : null;
  state.queued = null;
  if (state.undelivered) { state.undelivered.remove(); state.undelivered = null; }
  const userTurns = state.history.filter((h) => h.role === "user").length;
  if (userTurns >= MAX_TURNS) {
    addMsg("sys", null, "· the register closes — this interview has run its length ·");
    return;
  }
  const isTape = userRaw.startsWith("[TAPE]");
  setBusy(true);
  state.streaming = true;
  $("#chaterr").hidden = true;
  state.history.push({ role: "user", raw: userRaw });
  const userEl = queuedEl || renderUserMsg(userRaw);
  const bubble = renderModelMsg("");
  const textEl = bubble.querySelector(".text");
  // honest wait states: each string maps 1:1 to a real client state
  textEl.innerHTML = `<span class="dwait">${isTape
    ? "your agent is reading the day's marks — first words on the way…"
    : "thinking…"}</span>`;
  const contents = state.history.map((h) => ({ role: h.role, parts: [{ text: h.raw }] }));
  if (state.needsRepair) {
    // machine-injected, never rendered: the previous side channel was lost
    contents[contents.length - 1].parts[0].text +=
      "\n\n[REPAIR] The last draft block did not arrive — include the entire draft in this reply.";
  }
  let raw;
  try {
    // 4 attempts on transient errors (429/500/503). The primary model gets
    // exactly one try, then the fallback flash model takes over: measured
    // 2026-07-24, the primary 429/500s continuously under free-tier quota
    // while the fallback answers every time — waiting three backoffs to
    // switch cost 40-90s on every single turn.
    raw = await withRetries(
      (attempt) => streamOnce(
        attempt >= 1 ? state.fallback : state.model, contents, textEl,
        // unlock the composer the moment the visible reply is complete —
        // the tail streams on in the background (not on the tape turn:
        // the interview is over and a queued reply would be dropped)
        isTape ? null : () => { setBusy(false); $("#input").focus(); },
      ),
      { onRetryWait: () => { setBusy(true); textEl.innerHTML = `<span class="dwait">busy — retrying automatically…</span>`; } },
    );
  } catch (e) {
    console.error(e);
    bubble.remove();
    state.history.pop(); // the turn never reached the register
    state.streaming = false;
    if (state.queued) { // a message typed during the failed turn comes home too
      state.queued.el && state.queued.el.remove();
      const input = $("#input");
      if (!input.value) input.value = state.queued.raw;
      state.queued = null;
    }
    failTurn(userRaw, userEl, e);
    setBusy(false);
    return;
  }
  state.history.push({ role: "model", raw });
  state.streaming = false;
  const prevDraft = state.draft;
  const side = parseSideChannel(raw);
  if (side) {
    state.needsRepair = false;
    if (side.draft && typeof side.draft === "object") {
      // delta contract: changed fields arrive whole; unchanged fields persist
      state.draft = Object.assign({}, state.draft || {}, side.draft);
      renderDraft();
      renderInscriptions(prevDraft, state.draft);
    }
    state.ready = !!side.ready;
    if (side.done) state.done = true;
  } else {
    // the record must never silently fall behind the conversation
    state.needsRepair = true;
    addMsg("sys", null, "· that didn't reach the draft — it will catch up next reply ·");
  }
  // if this reply was the answer to the tape, restyle it as first words —
  // and treat the interview as done regardless of the model's flag: the
  // tape is only handed over once the charter is ready.
  if (isTape) {
    bubble.className = "msg first";
    bubble.querySelector(".who").textContent =
      ((state.draft && state.draft.name) ? state.draft.name.toUpperCase() : "THE AGENT") + " — FIRST WORDS";
    state.done = true;
  }
  saveInterview();
  setBusy(false);
  bubble.scrollIntoView({ block: "end" });
  if (state.queued && !state.done) {
    // a reply arrived while the tail streamed — it goes next, before any hand-off
    const q = state.queued;
    await sendTurn(q.raw);
    return;
  }
  if (state.ready && !state.done && !state.tapeSent) {
    state.tapeSent = true;
    saveInterview();
    await sendTurn(buildTapeMessage(tapeLines(), today()));
    return;
  }
  updateFinishUI();
  if (!state.done) $("#input").focus();
}

/**
 * The review path never depends solely on the model's done flag: whenever the
 * draft passes client validation, the way to the charter is open.
 */
function updateFinishUI() {
  const bar = $("#finishbar");
  const note = bar.querySelector(".note");
  const btn = $("#btn-review");
  const complete = state.draft && validatePacket(state.draft, state.floorNames).length === 0;
  if (state.done && !complete) {
    // the model closed the interview but the charter fails validation — a
    // closed composer here is a dead end, so the line reopens for the fix
    state.done = false;
    saveInterview();
    $("#composer").hidden = false;
    bar.hidden = false;
    bar.classList.add("quiet");
    btn.className = "plain";
    note.textContent = "The charter is missing something — open the review to see what, or answer to continue.";
    return;
  }
  if (state.done) {
    $("#composer").hidden = true;
    bar.hidden = false;
    bar.classList.remove("quiet");
    btn.className = "primary";
    note.textContent = "The interview is closed. What remains is your signature.";
  } else if (complete) {
    $("#composer").hidden = false;
    bar.hidden = false;
    bar.classList.add("quiet");
    btn.className = "plain";
    note.textContent = "The charter appears complete — review and submit whenever you are ready.";
  } else {
    $("#composer").hidden = false;
    bar.hidden = true;
  }
}

function restoreInterview(saved) {
  state.history = saved.history || [];
  state.tapeSent = !!saved.tapeSent;
  state.done = !!saved.done;
  state.ready = !!saved.ready;
  $("#chatlog").innerHTML = "";
  let lastUserRaw = "";
  for (const h of state.history) {
    if (h.role === "user") { lastUserRaw = h.raw; renderUserMsg(h.raw); }
    else {
      const first = lastUserRaw.startsWith("[TAPE]");
      if (first) state.done = true; // first words delivered = interview done, whatever the saved flag says
      renderModelMsg(h.raw, { first });
      const side = parseSideChannel(h.raw);
      if (side && side.draft) state.draft = Object.assign({}, state.draft || {}, side.draft);
    }
  }
  renderDraft();
  updateFinishUI();
  if (state.done) { /* nothing more to resume */ }
  else if (state.ready && !state.tapeSent) {
    // the charter was drafted but the hand-off was interrupted — resume it
    state.tapeSent = true;
    sendTurn(buildTapeMessage(tapeLines(), today()));
  }
}

async function beginInterview() {
  show("interview");
  buildModel();
  const saved = pickSaved(loadInterview(), await loadInterviewMirror());
  if (saved && (saved.history || []).length) { restoreInterview(saved); return; }
  // the opening is authored, not generated: it renders in 0ms, and the first
  // model call happens with the principal's first answer.
  state.history.push({ role: "user", raw: "[BEGIN]" });
  state.history.push({ role: "model", raw: OPENING });
  renderModelMsg(OPENING);
  renderDraft();
  saveInterview();
  $("#input").focus();
}

/* ---------------- charter review & submit ---------------- */
function transcriptMarkdown() {
  const name = (state.draft && state.draft.name) || "unnamed";
  let out = `# Seat interview — ${name}\n\n_${today()} · Open Outcry registry_\n\n`;
  let lastUser = "";
  for (const h of state.history) {
    if (h.role === "user") {
      lastUser = h.raw;
      if (h.raw === "[BEGIN]") continue;
      if (h.raw.startsWith("[TAPE]")) { out += `*The day's tape is placed on the desk.*\n\n`; continue; }
      out += `**Principal:** ${h.raw}\n\n`;
    } else {
      const speaker = lastUser.startsWith("[TAPE]") ? `**${name} — first words:**` : "**Registrar:**";
      out += `${speaker} ${displayText(h.raw)}\n\n`;
    }
  }
  return out;
}

function renderCharter() {
  const d = state.draft || {};
  $("#charter-name").textContent = d.name || "—";
  // reuse the panel renderer at full width
  const hold = $("#draftbody").innerHTML;
  renderDraft();
  $("#charterbody").innerHTML = $("#draftbody").innerHTML;
  $("#draftbody").innerHTML = hold;
  const errs = validatePacket(d, state.floorNames);
  const box = $("#charter-errors");
  if (errs.length) {
    box.hidden = false;
    box.innerHTML = `<span class="label">The register cannot accept this yet</span><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
    $("#btn-submit").disabled = true;
  } else {
    box.hidden = true;
    $("#btn-submit").disabled = false;
  }
}

async function submitApplication() {
  const d = state.draft || {};
  const errs = validatePacket(d, state.floorNames);
  if (errs.length) { renderCharter(); return; }
  const privacy = document.querySelector('input[name="privacy"]:checked').value;
  const packet = {
    name: d.name, archetype: d.archetype, credo: d.credo, universe: d.universe,
    benchmark: { symbols: d.benchmark.symbols, label: d.benchmark.label },
    max_position_pct: Number(d.max_position_pct),
    constitution: d.constitution, principles: d.principles, hypotheses: d.hypotheses,
    voice: d.voice, transcript_privacy: privacy, transcript: transcriptMarkdown(),
  };
  const btn = $("#btn-submit");
  btn.disabled = true; btn.textContent = "Submitting…";
  try {
    const docData = {
      uid: state.user.uid, status: "submitted", packet, createdAt: serverTimestamp(),
      ...(state.user.email ? { email: state.user.email } : {}),
    };
    const ref = await addDoc(collection(db, "applications"), docData);
    clearInterview();
    state.appDoc = { id: ref.id, data: docData };
    renderStatus(docData);
    watchApplication(ref.id);
    show("status");
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = "Countersign and submit";
    const box = $("#charter-errors");
    box.hidden = false;
    box.innerHTML = `<span class="label">Submission failed</span><ul><li>${esc(e.message || String(e))}</li></ul>`;
  }
}

/* ---------------- boot ---------------- */
async function boot() {
  await Promise.all([loadFloor(), completeEmailLink()]);
  renderSpecimen();

  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    renderAuthChip();
    if (!user) {
      $("#signinbox").hidden = false;
      $("#beginbox").hidden = true;
      show("landing");
      return;
    }
    ensureUserDoc(user);
    const existing = await findApplication(user.uid);
    if (existing) {
      state.appDoc = existing;
      renderStatus(existing.data);
      watchApplication(existing.id);
      show("status");
      return;
    }
    $("#signinbox").hidden = true;
    $("#beginbox").hidden = false;
    $("#whoami").textContent = user.displayName || user.email || "signed in";
    const local = loadInterview();
    const hasLocal = !!(local && (local.history || []).length);
    $("#btn-begin").textContent = hasLocal ? "Resume the interview" : "Begin the interview";
    show("landing");
    if (!hasLocal) {
      // an interview started on another device resumes here too
      const remote = await loadInterviewMirror();
      if (remote && (remote.history || []).length) $("#btn-begin").textContent = "Resume the interview";
    }
  });

  /* landing wiring */
  $("#btn-google").addEventListener("click", async () => {
    landingError("");
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { if (e.code !== "auth/popup-closed-by-user") landingError("Sign-in failed. (" + e.code + ")"); }
  });
  $("#emailform").addEventListener("submit", async (e) => {
    e.preventDefault();
    landingError("");
    const email = $("#emailinput").value.trim();
    if (!email) return;
    try {
      await sendSignInLinkToEmail(auth, email, { url: location.origin + "/seat/", handleCodeInApp: true });
      localStorage.setItem(EMAIL_KEY, email);
      $("#emailsent").hidden = false;
    } catch (err) { landingError("Could not send the link. (" + err.code + ")"); }
  });
  $("#btn-begin").addEventListener("click", beginInterview);

  /* interview wiring — Enter sends, Shift+Enter breaks the line */
  const input = $("#input");
  function submitComposer() {
    const text = input.value.trim();
    if (!text || state.busy || state.done) return;
    input.value = "";
    input.style.height = "";
    sendTurn(text);
  }
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); submitComposer(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitComposer(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  $("#drafttoggle").addEventListener("click", () => {
    const col = $("#draftcol");
    const open = col.classList.toggle("open");
    $("#drafttoggle").setAttribute("aria-expanded", String(open));
    $("#draftcaret").textContent = open ? "▾" : "▴";
  });
  $("#btn-review").addEventListener("click", () => { renderCharter(); show("finish"); });

  /* finish wiring */
  $("#btn-back").addEventListener("click", () => show("interview"));
  $("#btn-submit").addEventListener("click", submitApplication);
}

boot();
