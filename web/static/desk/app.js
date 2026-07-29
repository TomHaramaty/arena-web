// Conviction League — the desk: the principal's private room with their own trader.
// One page, four states: signed out → waiting for the first bell → the desk →
// (several traders, one principal). Runs client-side: Firebase Auth (identity),
// Firestore (the private thread and what gets filed), Firebase AI Logic (the
// trader speaking), /arena.json (everything it is allowed to know).
//
// The law of this room lives in trader.js: talk is private, filing is the one
// act that reaches the record, and nothing said here moves the book.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut,
  connectAuthEmulator, signInAnonymously,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, collection, query,
  where, getDocs, onSnapshot, serverTimestamp, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getAI, getGenerativeModel, GoogleAIBackend,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-ai.js";
import {
  initializeAppCheck, ReCaptchaV3Provider,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js";
import {
  getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import {
  buildSystemPrompt, arrivalPrompt, stripMark, parseTake, withRetries,
  nextFirstBell, fmtBell, originQuote, originDate, citationCount, daysUntil,
} from "./trader.js";
import { avatar, injectAvatarCSS, normalizeAvatar } from "../avatar.js";
import {
  cleanName, normalizeCredit, saveCreditSoon, creditFormHTML, bindCreditForm,
} from "../credit.js";
import { lineChart } from "../chart.js";
import { notePrincipal } from "../whoami.js";

const app = initializeApp({
  projectId: "open-outcry",
  appId: "1:56794274079:web:1fe7981df1430587e2782a",
  apiKey: "AIzaSyBKkynHLzgHrpTCM4JeShFUu8CMjJIQdbo",
  authDomain: "conviction-league.com",
  storageBucket: "open-outcry.firebasestorage.app",
  messagingSenderId: "56794274079",
});

// App Check attests that these calls come from this app rather than from a
// script that copied the config out of the served JavaScript. It matters most
// for AI Logic below: Firestore rules govern who may read a document, but
// nothing governs who may spend the project's inference budget.
// localhost is a registered reCAPTCHA domain, so the emulator QA rigs attest
// normally; the Node eval scripts have no browser and need a debug token.
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("6LdZOWstAAAAAFFN3gFIQYhYN4MBr1WCa1hrXwNH"),
  isTokenAutoRefreshEnabled: true,
});
const auth = getAuth(app);
const db = getFirestore(app);
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
if (IS_LOCAL) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
const ai = getAI(app, { backend: new GoogleAIBackend() });
const fns = getFunctions(app, "us-central1");
const MODEL_ID = "gemini-3.5-flash";
const FALLBACK_MODEL_ID = "gemini-3.5-flash-lite";

const CONTEXT_TURNS = 24;   // how much of the conversation the trader carries
const THREAD_CAP = 200;     // what the room keeps
const DAY_TURNS = 80;       // one principal's model calls per day, per browser

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const md = (s) => esc(s)
  .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)]|$)/gm, "$1<em>$2</em>")
  .replace(/`([^`\n]+)`/g, "<code>$1</code>");
const money = (v) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(2) + "%";
const dayLabel = (iso) => {
  const d = new Date(iso + "T12:00:00Z");
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
// journal entries carry a date, not a time: the close bell is when they land
const entryTime = (iso) => new Date(iso + "T20:40:00Z").getTime();

const state = {
  user: null,
  floor: null,
  apps: [],          // every application this principal has filed
  traders: [],       // [{id, app}] — seated, in floor order
  traderId: null,
  agent: null,       // the arena.json entry for the selected trader
  thread: [],        // [{role:'trader'|'you'|'sys', text, ts, basis?, gid?}]
  guidance: [],      // live docs from the guidance collection, this trader
  model: null, fallback: null,
  busy: false,
  taking: false,     // a note is being written to the record right now
  unsubGuidance: null,
  credit: { name: "", show: false }, // their own name on the floor, if they want it
};

const VIEWS = ["loading", "signin", "wait", "desk"];
function show(view) {
  for (const v of VIEWS) $("#view-" + v).hidden = v !== view;
  followTail = true;
  if (view === "desk" && $("#thread").firstElementChild) { scrollTail(false); updateTailBtn(); }
  else window.scrollTo({ top: 0 });
}

/* ---------------- the record ---------------- */
async function loadFloor() {
  try {
    const r = await fetch("/arena.json", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    state.floor = await r.json();
  } catch { state.floor = null; }
}
const agentOf = (id) => (state.floor ? (state.floor.agents || []).find((a) => a.id === id) : null);
const traderName = () => (state.agent && state.agent.name) || "your trader";
const packetOf = (t) => (t && t.app && t.app.data && t.app.data.packet) || {};
const addressOf = () => packetOf(state.traders.find((t) => t.id === state.traderId)).address || "";
const faceOf = (a) => normalizeAvatar((a && a.avatar) || {});

/* ---------------- auth ---------------- */
const EMAIL_KEY = "oo.seat.emailForSignIn";

function signinErrText(code) {
  if (code === "auth/invalid-action-code" || code === "auth/expired-action-code")
    return "That sign-in link has expired or was already used. Send a fresh one below.";
  if (code === "auth/invalid-email")
    return "That doesn't match the email the link was sent to. Check it and try again.";
  return "That sign-in link did not work. Send a fresh one below. (" + code + ")";
}

/* A click-through from an email sign-in link may land on a device that never
   stashed the address, so the confirm-and-retry happens in the page. */
async function completeEmailLink() {
  if (!isSignInWithEmailLink(auth, location.href)) return;
  show("signin");
  $("#signinbox").hidden = true;
  const box = $("#finishingbox"), statusEl = $("#finishingstatus");
  const form = $("#confirmemailform"), input = $("#confirmemailinput"), errEl = $("#finishingerr");
  box.hidden = false;

  const attempt = async (email) => {
    statusEl.hidden = false; form.hidden = true; errEl.hidden = true;
    try {
      await signInWithEmailLink(auth, email, location.href);
      localStorage.removeItem(EMAIL_KEY);
      history.replaceState(null, "", location.pathname + location.search);
      return true;
    } catch (e) { return e.code || String(e); }
  };

  return new Promise((resolve) => {
    const done = () => { box.hidden = true; $("#signinbox").hidden = false; resolve(); };
    const ask = (code) => {
      statusEl.hidden = true; form.hidden = false;
      if (code) {
        errEl.hidden = false;
        errEl.innerHTML = esc(signinErrText(code)) +
          ` <button type="button" class="plain errretry" id="signin-startover">Start over</button>`;
        $("#signin-startover").addEventListener("click", () => {
          history.replaceState(null, "", location.pathname + location.search);
          done();
        });
      }
      input.focus();
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      const r = await attempt(v);
      if (r === true) done(); else ask(r);
    });
    (async () => {
      const stored = localStorage.getItem(EMAIL_KEY);
      const r = stored ? await attempt(stored) : "need-email";
      if (r === true) done(); else ask(r === "need-email" ? null : r);
    })();
  });
}

/** The principal's own doc: created on first sign-in, and read for the one
 *  thing on it the panel needs — what the floor may print beside their traders.
 *  Awaited before anything renders, so the control never opens showing a
 *  preference that is not theirs. */
async function ensureUserDoc(user) {
  let data = null;
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) data = snap.data();
    else {
      await setDoc(ref, {
        displayName: user.displayName || null,
        email: user.email || null,
        createdAt: serverTimestamp(),
      });
    }
  } catch (e) { console.warn("users doc:", e); }
  state.credit = normalizeCredit(data && data.credit);
  // a name signed in with is a suggestion to accept, never consent already given
  if (!state.credit.name && user.displayName) {
    state.credit.name = cleanName(user.displayName);
  }
}

function renderAuthChip() {
  const chip = $("#authchip");
  if (!state.user) { chip.hidden = true; chip.innerHTML = ""; return; }
  chip.hidden = false;
  chip.innerHTML = `${esc(state.user.email || state.user.displayName || "signed in")} · <a href="#" id="signoutlink">sign out</a>`;
  $("#signoutlink").addEventListener("click", async (e) => {
    e.preventDefault();
    notePrincipal(null);
    await signOut(auth);
    location.reload();
  });
}

/* ---------------- which traders are this principal's ---------------- */
async function loadApplications(uid) {
  try {
    const snaps = await getDocs(query(collection(db, "applications"), where("uid", "==", uid)));
    return snaps.docs.map((d) => ({ id: d.id, data: d.data() }));
  } catch (e) { console.warn("applications:", e); return []; }
}

/* ---------------- the private thread ---------------- */
const threadRef = () => doc(db, "desks", state.user.uid + "_" + state.traderId);

async function loadThread() {
  state.thread = [];
  try {
    const snap = await getDoc(threadRef());
    if (snap.exists()) state.thread = (snap.data().messages || []).filter((m) => m && m.text);
  } catch (e) { console.warn("thread:", e); }
}

let saveTimer = null;
function saveThread() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await setDoc(threadRef(), {
        uid: state.user.uid,
        trader: state.traderId,
        messages: state.thread.slice(-THREAD_CAP),
        updatedAt: serverTimestamp(),
      });
    } catch (e) { console.warn("thread save:", e); }
  }, 400);
}

/* ---------------- what has been filed ---------------- */
function watchGuidance() {
  if (state.unsubGuidance) state.unsubGuidance();
  // one equality filter, then filtered here: no composite index to deploy
  state.unsubGuidance = onSnapshot(
    query(collection(db, "guidance"), where("uid", "==", state.user.uid)),
    (snaps) => {
      state.guidance = snaps.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((g) => g.trader === state.traderId);
      renderThread();
    },
    (e) => console.warn("guidance listener:", e));
}

const PER_DAY = 3;   // what the engine will take from one desk in a day
const isToday = (ts) => ts && ts.seconds &&
  new Date(ts.seconds * 1000).toDateString() === new Date().toDateString();

/* The trader carries things to its session itself: no button, no ceremony. It
   says in its own words what it is taking, and the desk writes that note to the
   record — the principal's own words wherever possible. Until the session
   starts, nothing is final: "leave it" pulls the note back before the engine
   has ever seen it. */
async function takeNote(take, msgIndex) {
  const lastYou = [...state.thread].reverse().find((m) => m.role === "you");
  const text = (take.author === "trader" ? take.text : (lastYou && lastYou.text) || "").trim();
  if (!text) return null;
  if (takenToday() >= PER_DAY) return "full";
  state.taking = true;
  try {
    const ref = await addDoc(collection(db, "guidance"), {
      uid: state.user.uid,
      trader: state.traderId,
      text: text.slice(0, 4000),
      author: take.author,
      status: "filed",
      createdAt: serverTimestamp(),
    });
    const m = state.thread[msgIndex];
    if (m) m.gid = ref.id;
    return ref.id;
  } catch (e) {
    console.error(e);
    return null;
  } finally {
    state.taking = false;
  }
}

const takenToday = () => state.guidance.filter(
  (x) => x.status !== "rejected" && isToday(x.createdAt)).length;

/** Before the session reads it, a note can still be pulled back. */
async function leaveIt(gid) {
  const g = guidanceOf(gid);
  try {
    await deleteDoc(doc(db, "guidance", gid));
    for (const m of state.thread) if (m.gid === gid) delete m.gid;
    // The trader has already said it was carrying this. Unless it is told
    // otherwise it will believe that for the rest of the conversation and
    // refuse to take the same thing twice — so the withdrawal is spoken.
    state.thread.push({ role: "stamp", text: "you took that note back", ts: Date.now() });
    state.thread.push({
      role: "sys", ts: Date.now(),
      text: `[NOTE] Your principal took back the note you said you were carrying${
        g && g.text ? ` ("${g.text.slice(0, 200)}")` : ""}. You are not carrying it. Do not raise it unless they do, and if they ask you to carry it after all, take it.`,
    });
    saveThread();
    renderThread();
  } catch (e) {
    console.error(e);
    showError("That note is already with " + traderName() + ". It answers it at the next session.");
  }
}

const guidanceOf = (gid) => state.guidance.find((g) => g.id === gid) || null;

function showError(msg) {
  const el = $("#chaterr");
  el.hidden = false;
  el.textContent = msg;
}

/* ---------------- the standing panel ---------------- */
/* The same instrument the floor uses, sized for a 340px column: the trader's
   equity against the benchmark it must beat, since launch. The floor keeps the
   ranges and the crosshair; the desk shows the shape. */
function drawBookChart(a) {
  const box = $("#pchart");
  if (!box) return;
  const series = [{ name: a.name, color: a.color, points: a.curve || [], fill: true }];
  if ((a.bench_curve || []).length) {
    series.push({ name: a.benchmark_label, color: "var(--muted)",
                  points: a.bench_curve, dashed: true });
  }
  lineChart(box, series, {
    aria: `${a.name} against ${a.benchmark_label} since launch`,
    size: { W: 320, H: 148, mL: 34, mR: 10, mT: 10, mB: 22 },
    endLabels: false,
  });
  const legend = $("#pchartkey");
  if (legend) {
    legend.innerHTML = series.map((s) =>
      `<span class="pkey"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
  }
}

function bookHTML(a) {
  const rows = [
    ["equity", money(a.equity)],
    ["since launch", `<span class="${a.ret >= 0 ? "up" : "dn"}">${pct(a.ret)}</span>`],
    [`vs ${esc(a.benchmark_label || "benchmark")}`, `<span class="${a.alpha >= 0 ? "up" : "dn"}">${pct(a.alpha)}</span>`],
    ["cash", (a.cash_pct * 100).toFixed(0) + "%"],
  ].map(([k, v]) => `<div class="prow"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
  const pos = (a.positions || []).map((p) => `
    <div class="ppos">
      <div class="prow"><span class="psym">${esc(p.symbol)}</span>
        <span class="v ${p.pl >= 0 ? "up" : "dn"}">${pct(p.pl)}</span></div>
      <div class="prow"><span class="k">${(p.weight * 100).toFixed(1)}% of the book</span>
        <span class="v">${money(p.value)}</span></div>
      ${p.thesis ? `<p class="pthesis">${esc(p.thesis)}</p>` : ""}
    </div>`).join("");
  return `<div class="pchart" id="pchart"></div><div class="pchartkey" id="pchartkey"></div>` + rows +
    (pos || `<p class="pempty" style="margin-top:10px">No positions open. The book is all cash.</p>`);
}

function wordsHTML(a) {
  const ps = (a.principles || []).filter((p) => p.status !== "retired");
  if (!ps.length) return `<p class="pempty">No rules yet.</p>`;
  const n = (a.journal || []).length;
  return ps.map((p) => {
    const q = originQuote(p.origin), d = originDate(p.origin);
    const c = citationCount(a, p.id);
    return `<div class="pword">
      <div class="ptags"><span class="tag">${esc(p.id)}</span>
        <span class="tag ${p.rigidity === "hard" ? "hard" : ""}">${esc(p.rigidity || "heuristic")}</span></div>
      <div class="pstmt">${esc(p.statement)}</div>
      ${q ? `<div class="pquote">“${esc(q)}” — you${d ? ", " + dayLabel(d) : ""}</div>` : ""}
      <div class="pwork">${c ? `it drove ${c} of ${n} sessions` : n ? `not yet cited in a session` : `waiting for its first session`}</div>
    </div>`;
  }).join("");
}

function clocksHTML(a) {
  const out = [];
  for (const h of a.hypotheses || []) {
    if (h.status === "falsified" || h.status === "promoted") continue;
    const dd = h.expiry ? daysUntil(h.expiry) : null;
    out.push(`<div class="pclock">
      <span class="tag">${esc(h.id)}</span> ${esc(h.statement)}
      ${h.falsifier ? `<span class="pwhen">falsified if ${esc(h.falsifier)}</span>` : ""}
      ${h.expiry ? `<span class="pwhen">${dd != null && dd >= 0 ? `${dd} days left · expires ${dayLabel(h.expiry)}` : `expired ${dayLabel(h.expiry)}`} · ${h.ev_for} for, ${h.ev_against} against</span>` : ""}
    </div>`);
  }
  for (const p of a.positions || []) {
    if (!p.review_by) continue;
    const dd = daysUntil(p.review_by);
    out.push(`<div class="pclock"><span class="tag">${esc(p.symbol)}</span> thesis review
      <span class="pwhen">${dd != null && dd >= 0 ? `in ${dd} days` : "overdue"} · ${dayLabel(p.review_by)}</span></div>`);
  }
  out.push(`<div class="pclock">Next session
    <span class="pwhen">${esc(fmtBell(nextFirstBell()))}</span></div>`);
  return out.join("");
}

function charterHTML(a) {
  const c = a.charter || {};
  const li = (xs) => `<ul>${(xs || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  return `<div class="pcharter">
    ${c.constitution ? `<p class="label" style="margin-top:4px">what binds it</p>${li(c.constitution)}` : ""}
    ${c.parameters ? li(c.parameters) : ""}
    ${(c.amendments || []).map((am) => `<div class="pamend"><b>${esc(am.date)} · ${esc(am.title)}</b><br>${esc(am.text)}</div>`).join("")}
  </div>`;
}

function renderPanel() {
  const a = state.agent;
  if (!a) return;
  const nSessions = (a.journal || []).length;
  const nRules = (a.principles || []).filter((p) => p.status !== "retired").length;
  const nTests = (a.hypotheses || []).filter((h) => h.status === "testing").length;
  $("#paneltitle").textContent = "the book · " + a.name;
  $("#panelbody").innerHTML = `
    <div class="pmast">
      ${avatar({ ...faceOf(a), name: a.name }, 64, { animate: true })}
      <div class="pname">${esc(a.name)}</div>
      <div class="parch">${esc(a.archetype || "")}</div>
      ${a.charter && a.charter.credo ? `<p class="pcredo">${esc(a.charter.credo)}</p>` : ""}
      <p class="pservice">seated ${dayLabel(a.launched)} · ${nSessions} ${nSessions === 1 ? "session" : "sessions"} · ${nRules} rules · ${nTests} in test</p>
    </div>
    <div class="psec"><span class="label">the book</span>${bookHTML(a)}</div>
    <div class="psec"><span class="label">your words at work</span>${wordsHTML(a)}</div>
    <div class="psec"><span class="label">on the clock</span>${clocksHTML(a)}</div>
    <div class="psec"><span class="label">the charter</span>
      <details class="pmore"><summary>what it may and may not do</summary>${charterHTML(a)}</details>
      <p class="footnote" style="margin-top:6px"><a href="/floor/#${esc(a.id)}">The whole record, and the chart with its ranges, on the floor →</a></p>
    </div>
    <div class="psec"><span class="label">your name on the floor</span>
      <p class="footnote" style="margin:-2px 0 8px">The floor names whoever chartered each trader. Yours to change or take off whenever you like; the floor follows within the hour.</p>
      <div id="credform">${creditFormHTML({ subject: a.name })}</div>
    </div>`;
  bindCreditForm($("#credform"), state.credit, (c) => {
    if (state.user) saveCreditSoon(db, state.user.uid, c);
  });
  drawBookChart(a);
}

/* ---------------- the thread ---------------- */
function entryCard(e, a) {
  const cites = [...new Set(((e.rationale || "") + " " + (e.actions || "")).match(/\b[PH]\d+\b/g) || [])];
  const first = (e.rationale || "").split(/\n\s*\n/)[0] || "";
  return `<div class="entry">
    <div class="ehead"><span>from the entry of ${esc(dayLabel(e.date))}</span>
      <span class="etype ${e.type === "trade" ? "trade" : ""}">${esc(e.type)}</span></div>
    <p class="etitle">${esc(e.title)}</p>
    ${first ? `<p class="esum">${md(first.length > 420 ? first.slice(0, 419) + "…" : first)}</p>` : ""}
    ${cites.length ? `<div class="ecites">${cites.map((c) => `<span class="cite">${esc(c)}</span>`).join("")}</div>` : ""}
    <a class="elink" href="/floor/#${esc(a.id)}">read the whole entry →</a>
  </div>`;
}

function charteredCard(a, packet) {
  const fr = packet.first_read || packet.first_words || "";
  return `<div class="entry">
    <div class="ehead"><span>chartered ${esc(dayLabel(a.launched))}</span></div>
    <p class="etitle">${esc(a.name)} took its seat with ${(a.principles || []).length} rules and ${(a.hypotheses || []).length} test in your words.</p>
    ${fr ? `<p class="esum">${md(fr.length > 600 ? fr.slice(0, 599) + "…" : fr)}</p>` : ""}
  </div>`;
}

function answerCard(g) {
  const label = {
    adopted: "adopted", converted: "made testable", declined: "declined, with reasons",
    refused: "refused, the charter forbids it",
  }[g.disposition] || g.disposition;
  return `<div class="answer">
    <div class="ahead">${esc(g.cid || "filed")} · ${esc(label)}</div>
    <p class="aquote">“${esc(g.text || "")}”</p>
    ${g.answer ? `<p class="atext">${md(g.answer)}</p>` : ""}
  </div>`;
}

/** The receipt for a note the trader took: quiet, one line, withdrawable until
    the session reads it. */
function takenLine(m) {
  if (m.notaken) {
    return `<div class="fileline">not carried · ${esc(traderName())} takes ${PER_DAY} a day; tomorrow</div>`;
  }
  const g = m.gid ? guidanceOf(m.gid) : null;
  if (!m.gid) return "";
  if (g && g.status === "rejected") {
    return `<div class="fileline">not carried${g.reason ? " · " + esc(g.reason) : ""}</div>`;
  }
  if (g && g.disposition) {
    return `<div class="fileline">${esc(g.cid || "")} · answered on the record</div>`;
  }
  const whose = g && g.author === "trader" ? "its own note" : "your words";
  return `<div class="fileline">carrying ${whose} to the next session · answers at
    ${esc(fmtBell(nextFirstBell()))}
    <button class="filebtn" data-leave="${esc(m.gid)}">leave it</button></div>`;
}

function msgHTML(m, i) {
  if (m.role === "stamp") return `<div class="msg stamp">${esc(m.text)}</div>`;
  if (m.role === "trader") {
    return `<div class="msg trader hasface">
      <div class="portrait" aria-hidden="true">${avatar({ ...faceOf(state.agent), name: traderName() }, 42, { animate: true })}</div>
      <div class="bubble"><div class="who">${esc(traderName())}</div><div class="text">${md(m.text)}</div>
        ${takenLine(m)}</div>
    </div>`;
  }
  return `<div class="msg me"><div class="who">you</div><div class="text">${md(m.text)}</div></div>`;
}

/** Everything that has happened, in one column, oldest first. */
function threadItems() {
  const a = state.agent, out = [];
  const packet = packetOf(state.traders.find((t) => t.id === state.traderId));
  if (a.launched) out.push({ t: entryTime(a.launched) - 1, html: charteredCard(a, packet) });
  for (const e of a.journal || []) out.push({ t: entryTime(e.date), html: entryCard(e, a) });
  state.thread.forEach((m, i) => {
    if (m.role === "sys") return;
    out.push({ t: m.ts || 0, html: msgHTML(m, i) });
  });
  for (const g of state.guidance) {
    if (!g.disposition) continue;
    const t = (g.answeredAt && g.answeredAt.seconds ? g.answeredAt.seconds * 1000 : Date.now());
    out.push({ t, html: answerCard(g) });
  }
  return out.sort((x, y) => x.t - y.t);
}

/** How you two met: the interview is the origin of every quote in the panel. */
function interviewHTML(packet) {
  if (!packet.transcript) return "";
  return `<details class="met"><summary>the interview that made ${esc(traderName())} →</summary>
    <div class="mettext">${md(packet.transcript)}</div></details>`;
}

function renderThread() {
  const el = $("#thread");
  const packet = packetOf(state.traders.find((t) => t.id === state.traderId));
  el.innerHTML = interviewHTML(packet) + threadItems().map((x) => x.html).join("");

  el.querySelectorAll("[data-leave]").forEach((b) =>
    b.addEventListener("click", () => leaveIt(b.dataset.leave)));
  tail(false);
}

/* ---------------- the trader speaking ---------------- */
function buildModel() {
  const sys = buildSystemPrompt({
    agent: state.agent,
    takenToday: takenToday(),
    perDay: PER_DAY,
    guidance: state.guidance.map((g) => ({
      cid: g.cid, text: g.text, disposition: g.disposition, answer: g.answer,
      author: g.author || "principal",
      date: g.createdAt && g.createdAt.seconds
        ? new Date(g.createdAt.seconds * 1000).toISOString().slice(0, 10) : "",
    })),
    address: addressOf(),
    today: (state.floor && state.floor.run_date) || "",
  });
  const mk = (id) => getGenerativeModel(ai, {
    model: id,
    systemInstruction: sys,
    generationConfig: { temperature: 0.85, maxOutputTokens: 1600 },
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

function dayBudgetSpent() {
  const key = "oo.desk.turns." + new Date().toISOString().slice(0, 10);
  const n = Number(localStorage.getItem(key) || 0);
  localStorage.setItem(key, String(n + 1));
  return n + 1 > DAY_TURNS;
}

async function streamOnce(model, contents, textEl) {
  let raw = "";
  const result = await model.generateContentStream({ contents });
  for await (const chunk of result.stream) {
    raw += chunk.text();
    textEl.innerHTML = md(stripMark(raw));
  }
  if (!raw.trim()) throw new Error("[503] empty reply");
  return raw;
}

/** One turn: the trader answers whatever is at the end of the thread. */
async function turn() {
  if (dayBudgetSpent()) {
    showError(`${traderName()} has done a lot of talking today. Pick this up tomorrow, or read the record on the floor.`);
    return;
  }
  setBusy(true);
  $("#chaterr").hidden = true;
  const bubble = document.createElement("div");
  bubble.className = "msg trader hasface";
  bubble.innerHTML = `<div class="portrait" aria-hidden="true">${avatar({ ...faceOf(state.agent), name: traderName() }, 42, { animate: true })}</div>
    <div class="bubble"><div class="who">${esc(traderName())}</div><div class="text"><span class="dwait">thinking…</span></div></div>`;
  $("#thread").appendChild(bubble);
  const textEl = bubble.querySelector(".text");
  tail(false);

  const contents = state.thread.slice(-CONTEXT_TURNS)
    .filter((m) => m.role !== "stamp")
    .map((m) => ({
      role: m.role === "trader" ? "model" : "user",
      parts: [{ text: m.text }],
    }));
  let raw;
  try {
    raw = await withRetries(
      (attempt) => streamOnce(attempt >= 1 ? state.fallback : state.model, contents, textEl),
      { onRetryWait: () => { textEl.innerHTML = `<span class="dwait">busy, retrying…</span>`; } });
  } catch (e) {
    console.error(e);
    bubble.remove();
    setBusy(false);
    showError(`${traderName()} can't get to its desk just now. Try again in a moment.`);
    return;
  }
  const text = stripMark(raw);
  state.thread.push({ role: "trader", text, ts: Date.now() });
  const take = parseTake(raw);
  if (take) {
    const r = await takeNote(take, state.thread.length - 1);
    if (r === "full") state.thread[state.thread.length - 1].notaken = true;
    if (r && r !== "full") buildModel();   // the day's count moved
  }
  saveThread();
  bubble.remove();
  renderThread();
  setBusy(false);
  $("#input").focus();
}

/** The trader speaks first when something real has happened since last time. */
async function maybeGreet() {
  const a = state.agent;
  const newest = (a.journal || [])[0];
  const basis = newest ? "entry:" + newest.date : a.launched ? "seat:" + a.launched : "";
  if (!basis) return;
  if (state.thread.some((m) => m.basis === basis)) return;
  // don't talk over a live conversation: only greet on a fresh arrival
  const last = state.thread[state.thread.length - 1];
  if (last && last.role === "you") return;

  const line = newest
    ? `your entry of ${newest.date}, "${newest.title}"`
    : `your charter, countersigned ${a.launched}`;
  const first = !state.thread.some((m) => m.role !== "sys");
  state.thread.push({ role: "sys", text: arrivalPrompt(line, { first }), ts: Date.now() });
  await turn();
  const t = state.thread[state.thread.length - 1];
  if (t && t.role === "trader") { t.basis = basis; saveThread(); }
}

/* ---------------- the waiting room ---------------- */
const BELL_ORDER = ["ringing", "seating", "first-session", "publishing", "done"];
function bellSteps(name) {
  return [
    { key: "ringing", label: "Ringing the opening bell" },
    { key: "seating", label: `Taking ${name}'s seat on the floor` },
    { key: "first-session", label: "Reading today's market and writing its first entry" },
    { key: "publishing", label: "Putting the entry on the floor" },
    { key: "done", label: `${name} is on the floor` },
  ];
}

function renderWait(appDoc) {
  const d = appDoc ? appDoc.data : null;
  const packet = (d && d.packet) || {};
  const name = packet.name || "your trader";
  const face = $("#statusface");
  face.innerHTML = packet.avatar
    ? avatar({ ...normalizeAvatar(packet.avatar), name }, 56, { animate: true }) : "";
  $("#statusrun").innerHTML = "";
  $("#statusbell").textContent = "";

  if (!d) {
    $("#statusword").textContent = "No trader yet";
    $("#statusdetail").innerHTML = "You haven't chartered a trader yet. The interview takes about fifteen minutes, and what you say in it becomes its rulebook.";
    $("#statuslinks").innerHTML = `<a href="/seat/">Take a seat →</a>`;
    return;
  }
  if (d.status === "rejected") {
    $("#statusword").textContent = "Not seated";
    $("#statusdetail").innerHTML = `The Registrar could not seat <b>${esc(name)}</b>.` +
      ((d.reasons || []).length ? `<ul>${d.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "");
    $("#statuslinks").innerHTML = `<a href="/seat/">Sit the interview again →</a>`;
    return;
  }
  $("#statusword").textContent = "Countersigned";
  const fr = packet.first_read;
  $("#statusdetail").innerHTML =
    `<b>${esc(name)}</b> is chartered. Its first session writes the first entry on its record. After that, this page is where it reports to you.` +
    (fr ? `<blockquote class="firstread"><span class="label">${esc(name)} · the first read</span>${md(fr)}</blockquote>` : "");
  const stage = d.bell && d.bell.stage;
  if (!stage || stage === "failed") {
    $("#statusbell").textContent = "Next bell " + fmtBell(nextFirstBell());
    $("#statusrun").innerHTML =
      (stage === "failed"
        ? `<p class="bellnote">The first session hit a problem. Nothing is lost; ${esc(name)} runs at the next bell regardless. You can try again now.</p>` : "") +
      `<button class="primary" id="btn-bell">Run the first session</button>
       <p class="bellnote">A few minutes, live. You'll watch each step below as it happens.</p>`;
    $("#btn-bell").addEventListener("click", () => ringBell(appDoc, name));
  } else {
    const ci = BELL_ORDER.indexOf(stage), isDone = stage === "done";
    $("#statusrun").innerHTML = `<ol class="bellsteps">${bellSteps(esc(name)).map((s, i) => {
      const st = (isDone || i < ci) ? "done" : i === ci ? "active" : "pending";
      return `<li class="bellstep ${st}"><span class="mk"></span><span class="lbl">${s.label}</span></li>`;
    }).join("")}</ol>` +
      (isDone ? "" : `<p class="bellnote">This runs live and takes a few minutes. You can leave this page and come back.</p>`);
  }
  $("#statuslinks").innerHTML = `<a href="/floor/">Watch the floor while you wait →</a>`;
}

async function ringBell(appDoc, name) {
  const btn = $("#btn-bell");
  if (btn) { btn.disabled = true; btn.textContent = "The bell is rung…"; }
  try {
    await httpsCallable(fns, "ringFirstBell")({ appId: appDoc.id });
  } catch (e) {
    console.error(e);
    if (btn) { btn.disabled = false; btn.textContent = "Run the first session"; }
    const p = document.createElement("p");
    p.className = "err";
    p.textContent = "That didn't go through. Try again. (" + (e.message || e) + ")";
    $("#statusrun").appendChild(p);
  }
}

function watchApplication(id) {
  onSnapshot(doc(db, "applications", id), async (snap) => {
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === "seated" && d.agent_id) {
      // The desk cannot open on a trader the published record does not carry
      // yet, and the roster this page loaded can predate publication — so read
      // it again on every update, or a waiting room opened early never lets go.
      await loadFloor();
      if (agentOf(d.agent_id)) { await openPrincipal(); return; }
    }
    renderWait({ id, data: d });
  }, (e) => console.warn("application listener:", e));
}

/* ---------------- several traders, one principal ---------------- */
function renderSwitcher() {
  const el = $("#switcher");
  if (state.traders.length < 2) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = state.traders.map((t) => {
    const a = agentOf(t.id);
    if (!a) return "";
    return `<button class="swface" type="button" data-t="${esc(a.id)}"
      aria-current="${a.id === state.traderId}">
      ${avatar({ ...faceOf(a), name: a.name }, 28)}
      <span class="swname">${esc(a.name)}</span>
      <span class="swret ${a.ret >= 0 ? "up" : "dn"}">${pct(a.ret)}</span></button>`;
  }).join("");
  el.querySelectorAll("[data-t]").forEach((b) =>
    b.addEventListener("click", () => selectTrader(b.dataset.t)));
}

function syncUrl() {
  const one = state.traders.length < 2;
  history.replaceState(null, "", location.pathname +
    (one ? "" : "?t=" + encodeURIComponent(state.traderId)));
}

async function selectTrader(id) {
  if (id === state.traderId) return;
  state.traderId = id;
  state.agent = agentOf(id);
  syncUrl();
  await openDesk();
}

async function openDesk() {
  document.title = `${state.agent.name} · Conviction League`;
  state.guidance = [];   // the new trader's notes arrive with its own listener
  $("#topline").textContent = "the desk";
  // the promise stays on every screen; the mechanic behind it is the first
  // thing the trader explains on arrival, so a phone need not carry it too
  $("#composernote").innerHTML =
    `This conversation is yours. It isn't published, and nothing said here moves the book.
     <span class="long">When <b>${esc(state.agent.name)}</b> decides something said here should change what it does,
     it carries that to its next session, tells you, and answers it on the record.</span>`;
  $("#input").placeholder = `Say something to ${state.agent.name}…`;
  renderSwitcher();
  renderPanel();
  await loadThread();
  watchGuidance();
  renderThread();
  show("desk");
  buildModel();
  await maybeGreet();
}

/** Route the signed-in principal: the desk if anything is seated, else the
    waiting room (or the invitation, if they have never sat an interview). */
async function openPrincipal() {
  state.apps = await loadApplications(state.user.uid);
  state.traders = state.apps
    .filter((a) => a.data.status === "seated" && a.data.agent_id && agentOf(a.data.agent_id))
    .map((a) => ({ id: a.data.agent_id, app: a }));

  const first = state.traders[0];
  notePrincipal(state.user && (first || state.apps.length)
    ? { uid: state.user.uid, status: first ? "seated" : "pending",
        trader: first ? first.id : "", name: first ? (agentOf(first.id) || {}).name || first.id : "" }
    : null);

  if (!state.traders.length) {
    /* A trader takes its seat in the record about a minute before the floor is
       rebuilt with it, and the desk can only open on what the record publishes.
       That minute is a waiting room, not an empty account — so a seated trader
       the floor has not caught up with is the one to wait on, and the listener
       opens the desk the moment it lands. */
    const pending = state.apps.find((a) => a.data.status === "seated")
      || state.apps.find((a) => a.data.status !== "seated") || null;
    renderWait(pending);
    show("wait");
    if (pending) watchApplication(pending.id);
    return;
  }
  const want = new URLSearchParams(location.search).get("t");
  const picked = state.traders.find((t) => t.id === want) || state.traders[0];
  state.traderId = picked.id;
  state.agent = agentOf(picked.id);
  syncUrl();
  await openDesk();
}

/* ---------------- following the live edge (the seat's controller) ---------------- */
const TAIL_SLACK = 72;
const TAIL_GAP = 16;
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
let followTail = true;

function footHeight() {
  let foot = 0;
  const under = (el) => Math.round(window.innerHeight - el.getBoundingClientRect().top);
  const sheet = $("#panelcol");
  if (sheet && getComputedStyle(sheet).position === "fixed") foot = under(sheet);
  for (const el of [$("#footbar")]) {
    if (!el || el.hidden || getComputedStyle(el).position !== "sticky") continue;
    foot = Math.max(foot, under(el));
  }
  return Math.max(0, Math.min(foot, window.innerHeight));
}
function tailGap() {
  const last = $("#thread").lastElementChild;
  if (!last) return 0;
  return Math.round(last.getBoundingClientRect().bottom -
    (window.innerHeight - footHeight() - TAIL_GAP));
}
const atTail = () => tailGap() <= TAIL_SLACK;
function scrollTail(smooth) {
  const d = tailGap();
  if (d <= 0) return;
  window.scrollBy({ top: d, behavior: smooth && !REDUCED.matches ? "smooth" : "auto" });
}
function tail(smooth) {
  if (followTail) scrollTail(smooth);
  updateTailBtn();
}
function updateTailBtn() {
  const btn = $("#btn-tail");
  if (!btn) return;
  document.documentElement.style.setProperty("--foot", footHeight() + "px");
  btn.hidden = $("#view-desk").hidden || followTail || tailGap() <= TAIL_SLACK;
}
function installScroll() {
  let queued = false;
  const onGesture = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; followTail = atTail(); updateTailBtn(); });
  };
  const SCROLL_KEYS = ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "];
  addEventListener("wheel", onGesture, { passive: true });
  addEventListener("touchmove", onGesture, { passive: true });
  addEventListener("keydown", (e) => {
    if (e.target !== $("#input") && SCROLL_KEYS.includes(e.key)) onGesture();
  });
  addEventListener("scroll", () => {
    if (!followTail && atTail()) followTail = true;
    updateTailBtn();
  }, { passive: true });
  addEventListener("resize", () => tail(false), { passive: true });
  const ro = new ResizeObserver(() => tail(false));
  ro.observe($("#thread"));
  ro.observe($("#footbar"));
  $("#btn-tail").addEventListener("click", () => {
    followTail = true;
    scrollTail(true);
    updateTailBtn();
    $("#input").focus();
  });
}

/* ---------------- boot ---------------- */
function wire() {
  $("#btn-google").addEventListener("click", async () => {
    $("#signinerr").hidden = true;
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) {
      if (e.code === "auth/popup-closed-by-user") return;
      $("#signinerr").hidden = false;
      $("#signinerr").textContent = "Sign-in failed. (" + e.code + ")";
    }
  });
  $("#emailform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#emailinput").value.trim();
    if (!email) return;
    try {
      await sendSignInLinkToEmail(auth, email, { url: location.origin + "/desk/", handleCodeInApp: true });
      localStorage.setItem(EMAIL_KEY, email);
      $("#emailsent").hidden = false;
    } catch (err) {
      $("#signinerr").hidden = false;
      $("#signinerr").textContent = "Could not send the link. (" + err.code + ")";
    }
  });

  const input = $("#input");
  function submitComposer() {
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = "";
    input.style.height = "";
    followTail = true;
    state.thread.push({ role: "you", text, ts: Date.now() });
    saveThread();
    renderThread();
    turn();
  }
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); submitComposer(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitComposer(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  $("#paneltoggle").addEventListener("click", () => {
    const col = $("#panelcol");
    const open = col.classList.toggle("open");
    $("#paneltoggle").setAttribute("aria-expanded", String(open));
    $("#panelcaret").textContent = open ? "▾" : "▴";
  });

  if (IS_LOCAL) {
    const dev = document.createElement("button");
    dev.type = "button";
    dev.className = "plain";
    dev.style.cssText = "border-style:dashed;margin-top:4px";
    dev.textContent = "Dev sign-in · local test, no email";
    dev.addEventListener("click", () => signInAnonymously(auth).catch((e) => {
      $("#signinerr").hidden = false;
      $("#signinerr").textContent = "Dev sign-in failed. (" + (e.code || e) + ")";
    }));
    $("#signinbox").appendChild(dev);
  }
}

async function boot() {
  injectAvatarCSS();
  installScroll();
  wire();
  await Promise.all([loadFloor(), completeEmailLink()]);

  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    renderAuthChip();
    if (user) {
      // retention: tie the session to the signed-in principal — uid only,
      // never email. The retry covers the deferred analytics script racing auth.
      if (window.umami) window.umami.identify(user.uid);
      else setTimeout(() => window.umami?.identify(user.uid), 2000);
    }
    if (!user) { show("signin"); return; }
    await ensureUserDoc(user);
    await openPrincipal();
  });
}

boot();
