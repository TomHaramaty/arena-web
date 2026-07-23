// Open Outcry — the Seat Interview.
// One page, four states: landing → interview → charter review → application status.
// Everything runs client-side: Firebase Auth (identity), Firebase AI Logic
// (the Registrar, streamed), Firestore (the application). No backend.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, collection, query, where, limit,
  getDocs, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getAI, getGenerativeModel, GoogleAIBackend,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-ai.js";
import {
  buildSystemPrompt, buildTapeMessage, validatePacket, nextFirstBell, fmtBell,
  withRetries,
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
  draft: null,          // last parsed draft
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
    $("#statuslinks").innerHTML = `<a href="/">Watch ${esc(name)} on the floor →</a>`;
  } else {
    $("#statusword").textContent = "Application received";
    $("#statusdetail").innerHTML =
      `<b>${esc(name)}</b> is being seated. The charter is on the register; the record opens at the first bell.`;
    $("#statusbell").textContent = "First bell " + fmtBell(nextFirstBell());
    $("#statuslinks").innerHTML = `<a href="/">Watch the floor while you wait →</a>`;
  }
}

function watchApplication(id) {
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = onSnapshot(doc(db, "applications", id), (snap) => {
    if (snap.exists()) renderStatus(snap.data());
  }, (e) => console.warn("status listener:", e));
}

/* ---------------- interview persistence ---------------- */
const saveKey = () => "oo.seat.interview." + (state.user ? state.user.uid : "anon");
function saveInterview() {
  try {
    localStorage.setItem(saveKey(), JSON.stringify({
      history: state.history, tapeSent: state.tapeSent, done: state.done, ready: state.ready,
    }));
  } catch { /* quota — the interview just won't survive a refresh */ }
}
function loadInterview() {
  try { return JSON.parse(localStorage.getItem(saveKey()) || "null"); } catch { return null; }
}
function clearInterview() { localStorage.removeItem(saveKey()); }

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
  if (raw.startsWith("[TAPE]")) return addMsg("sys", null, "· the day's tape is placed on the desk ·");
  return addMsg("me", "PRINCIPAL", md(raw));
}

/* ---------------- the materialization panel ---------------- */
function daysUntil(iso) {
  const t = new Date(iso + "T00:00:00Z") - new Date();
  return Math.max(0, Math.round(t / 86400000));
}
function renderDraft() {
  const d = state.draft;
  const body = $("#draftbody");
  const count =
    (d ? (d.constitution || []).length + (d.principles || []).length + (d.hypotheses || []).length +
      ["name", "credo", "benchmark", "voice"].filter((k) => d[k]).length : 0);
  $("#draftcount").textContent = count ? `The draft — ${count} ${count === 1 ? "entry" : "entries"}` : "The draft — empty";
  if (!d || !count) {
    body.innerHTML = `<p class="dempty">Nothing on the register yet. It fills as you answer — name, credo, constitution, principles, hypotheses, benchmark.</p>`;
    return;
  }
  let h = "";
  h += `<div class="dsec"><span class="label">Agent</span><div class="dname">${d.name ? esc(d.name) : '<span class="dwait">unnamed</span>'}${d.archetype ? `<span class="arch">${esc(d.archetype)}</span>` : ""}</div></div>`;
  if (d.credo) h += `<div class="dsec"><span class="label">Credo</span><div class="dcredo">“${esc(d.credo)}”</div></div>`;
  if (d.benchmark && d.benchmark.label) h += `<div class="dsec"><span class="label">Benchmark</span><div class="dmono">${esc(d.benchmark.label)} — the lazy twin</div></div>`;
  if (d.universe) h += `<div class="dsec"><span class="label">Universe</span><div class="dmono">${esc(d.universe)}</div></div>`;
  if (d.max_position_pct) h += `<div class="dsec"><span class="label">Max position</span><div class="dmono">${esc(String(d.max_position_pct))}% of equity</div></div>`;
  if ((d.constitution || []).length) {
    h += `<div class="dsec"><span class="label">Constitution — enforced in code</span><ul class="dlist">` +
      d.constitution.map((c) => `<li>${esc(c)}</li>`).join("") + `</ul></div>`;
  }
  if ((d.principles || []).length) {
    h += `<div class="dsec"><span class="label">Principles</span>` + d.principles.map((p, i) => `
      <div class="dprin"><div class="tags"><span class="tag">P${i + 1}</span><span class="tag">${esc(p.type || "?")}</span><span class="tag ${p.rigidity === "hard" ? "hard" : ""}">${esc(p.rigidity || "?")}</span></div>
      <div class="stmt">${esc(p.statement || "")}</div>
      ${p.quote ? `<div class="quote">“${esc(p.quote)}” — the principal</div>` : ""}</div>`).join("") + `</div>`;
  }
  if ((d.hypotheses || []).length) {
    h += `<div class="dsec"><span class="label">Hypotheses — testing</span>` + d.hypotheses.map((x, i) => `
      <div class="dprin dhyp"><div class="tags"><span class="tag">H${i + 1}</span></div>
      <div class="stmt">${esc(x.statement || "")}</div>
      ${x.falsifier ? `<div class="quote">Falsified if: ${esc(x.falsifier)}</div>` : ""}
      ${x.expiry ? `<div class="clock">expires ${esc(x.expiry)} · ${daysUntil(x.expiry)} days on the clock</div>` : ""}</div>`).join("") + `</div>`;
  }
  if (d.voice) h += `<div class="dsec"><span class="label">Voice</span><div class="dcredo" style="font-size:13.5px">${esc(d.voice)}</div></div>`;
  body.innerHTML = h;
}

/* ---------------- the interview engine ---------------- */
function buildModel() {
  const sys = buildSystemPrompt({ rosterLines: rosterLines(), tapeLines: tapeLines(), today: today() });
  const mk = (id) => getGenerativeModel(ai, {
    model: id,
    systemInstruction: sys,
    generationConfig: { temperature: 0.9, maxOutputTokens: 2048 },
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

async function streamOnce(model, contents, textEl) {
  let raw = "";
  const result = await model.generateContentStream({ contents });
  for await (const chunk of result.stream) {
    raw += chunk.text();
    textEl.innerHTML = md(displayText(raw));
  }
  if (!raw.trim()) throw new Error("[503] the register returned an empty page");
  return raw;
}

/** Terminal failure of a turn: never lose the principal's words. */
function failTurn(userRaw, userEl, e) {
  const err = $("#chaterr");
  if (userRaw.startsWith("[TAPE]")) {
    if (userEl) userEl.remove();
    state.tapeSent = false; // the next Registrar reply re-triggers the hand-off
    err.textContent = "The line dropped while the tape was being read — say anything to resume.";
  } else if (userRaw === "[BEGIN]") {
    err.textContent = "The register did not answer the bell — say hello to knock again.";
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
    err.textContent = "The register did not answer — your words are kept; retry when ready. (" + ((e && e.message) || e) + ")";
  }
  err.hidden = false;
}

async function sendTurn(userRaw) {
  if (state.busy || state.done) return;
  if (state.undelivered) { state.undelivered.remove(); state.undelivered = null; }
  const userTurns = state.history.filter((h) => h.role === "user").length;
  if (userTurns >= MAX_TURNS) {
    addMsg("sys", null, "· the register closes — this interview has run its length ·");
    return;
  }
  setBusy(true);
  $("#chaterr").hidden = true;
  state.history.push({ role: "user", raw: userRaw });
  const userEl = renderUserMsg(userRaw);
  const bubble = renderModelMsg("");
  const textEl = bubble.querySelector(".text");
  const contents = state.history.map((h) => ({ role: h.role, parts: [{ text: h.raw }] }));
  let raw;
  try {
    // 3 attempts on transient errors (429/500/503): primary, primary again
    // after 2s, then the fallback flash model after 6s more.
    raw = await withRetries(
      (attempt) => streamOnce(attempt >= 2 ? state.fallback : state.model, contents, textEl),
      { onRetryWait: () => { textEl.innerHTML = `<span class="dwait">the line to the register is busy — holding…</span>`; } },
    );
  } catch (e) {
    console.error(e);
    bubble.remove();
    state.history.pop(); // the turn never reached the register
    failTurn(userRaw, userEl, e);
    setBusy(false);
    return;
  }
  state.history.push({ role: "model", raw });
  const side = parseSideChannel(raw);
  if (side) {
    if (side.draft && typeof side.draft === "object") { state.draft = side.draft; renderDraft(); }
    state.ready = !!side.ready;
    if (side.done) state.done = true;
  }
  // if this reply was the answer to the tape, restyle it as first words
  if (userRaw.startsWith("[TAPE]")) {
    bubble.className = "msg first";
    bubble.querySelector(".who").textContent =
      ((state.draft && state.draft.name) ? state.draft.name.toUpperCase() : "THE AGENT") + " — FIRST WORDS";
  }
  saveInterview();
  setBusy(false);
  bubble.scrollIntoView({ block: "end" });
  if (state.ready && !state.done && !state.tapeSent) {
    state.tapeSent = true;
    saveInterview();
    await sendTurn(buildTapeMessage(tapeLines(), today()));
    return;
  }
  if (state.done) {
    $("#composer").hidden = true;
    $("#finishbar").hidden = false;
  } else {
    $("#input").focus();
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
      renderModelMsg(h.raw, { first: lastUserRaw.startsWith("[TAPE]") });
      const side = parseSideChannel(h.raw);
      if (side && side.draft) state.draft = side.draft;
    }
  }
  renderDraft();
  if (state.done) { $("#composer").hidden = true; $("#finishbar").hidden = false; }
  else if (state.ready && !state.tapeSent) {
    // the charter was drafted but the hand-off was interrupted — resume it
    state.tapeSent = true;
    sendTurn(buildTapeMessage(tapeLines(), today()));
  }
}

async function beginInterview() {
  show("interview");
  buildModel();
  const saved = loadInterview();
  if (saved && (saved.history || []).length) { restoreInterview(saved); return; }
  await sendTurn("[BEGIN]");
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
    btn.disabled = false; btn.textContent = "Submit the application";
    const box = $("#charter-errors");
    box.hidden = false;
    box.innerHTML = `<span class="label">Submission failed</span><ul><li>${esc(e.message || String(e))}</li></ul>`;
  }
}

/* ---------------- boot ---------------- */
async function boot() {
  await Promise.all([loadFloor(), completeEmailLink()]);

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
    const saved = loadInterview();
    $("#btn-begin").textContent = saved && (saved.history || []).length ? "Resume the interview" : "Begin the interview";
    show("landing");
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
