// Conviction League — the Seat Interview.
// One page, four states: landing → interview → charter review → application status.
// Runs client-side: Firebase Auth (identity), Firebase AI Logic (the Registrar,
// streamed), Firestore (the application). One Cloud Function (ringFirstBell,
// functions/index.js) fires the engine's first-bell workflow on request.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut,
  connectAuthEmulator, signInAnonymously,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, collection, query,
  where, limit, getDocs, onSnapshot, serverTimestamp, connectFirestoreEmulator,
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
  buildSystemPrompt, buildTapeMessage, buildWakeMessage, validatePacket,
  validateWakeMinimum, nextFirstBell, fmtBell, withRetries, OPENING, NAME_RE,
  PRINCIPLE_TYPES,
} from "./registrar.js";
import {
  avatar, headOnly, registrar as registrarAvatar, injectAvatarCSS, normalizeAvatar,
  PALS, BASES, COSTUMES, DETAILS, DETAIL_LABELS, ARCHETYPE,
} from "../avatar.js";
import { notePrincipal } from "../whoami.js";
import {
  cleanName, normalizeCredit, saveCredit, saveCreditSoon, creditFormHTML, bindCreditForm,
} from "../credit.js";

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
// Local staging: on localhost, auth and the database are emulators — no real
// accounts, no production data, no email round-trip. The Registrar (AI Logic)
// stays real, so latency and conversation quality are the genuine article.
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
if (IS_LOCAL) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
const ai = getAI(app, { backend: new GoogleAIBackend() });
const fns = getFunctions(app, "us-central1");
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

/* The picker's opening offer is a random Member, not a constant one.
   A fixed default made every unedited trader the same fox in a suit, and —
   because the same four values are also normalizeAvatar's fallback and the
   engine's DEFAULT_AVATAR — a face nobody touched was indistinguishable from
   one somebody chose. Rolling it means the floor reads as a cast, and
   state.avatarChosen answers the other half honestly.

   Rolled once per page load and persisted by the first saveInterview (which
   runs on every model turn, long before the picker is ever seen on the review
   screen), so the principal can never watch their agent's face change. */
function randomAvatar() {
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  return {
    base: pick(BASES),
    color: Math.floor(Math.random() * PALS.length),
    costume: pick(COSTUMES),
    acc: pick(["none", ...DETAILS]),
  };
}

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
  autoRepaired: false,  // the one automatic [REPAIR] turn around the handoff was spent
  machineNote: "",      // one-shot machine note appended to the next turn's contents
  wakeReadyTurns: 0,    // consecutive Act-I turns where the wake minimum passed with no handoff
  lastOptions: [],      // labels offered on the pending question (restore)
  tapped: [],           // every label sent by tap this session — never quotable
  pendingRigidity: null, // a rigidity the principal just tapped, not yet in the draft
  choicesHintShown: false,
  handoffSeen: false,   // the Registrar closed the file; the creation moment ran
  ready: false,
  done: false,
  tapeSent: false,
  busy: false,
  appDoc: null,         // {id, data}
  unsubscribe: null,
  avatar: randomAvatar(),  // the seat picker's opening offer — see randomAvatar
  avatarChosen: false,     // did the principal actually touch it? see onFacePick
  updates: { cadence: "daily", floor_digest: true }, // the updates card (letters, when they ship)
  credit: { name: "", show: false }, // the principal's own name on the floor
};

/* ---------------- view switching ---------------- */
const VIEWS = ["loading", "landing", "playbill", "interview", "finish", "status"];
function show(view) {
  for (const v of VIEWS) $("#view-" + v).hidden = v !== view;
  // the stage rail rides above the chat and the review, nowhere else
  $("#stagerail").hidden = view !== "interview" && view !== "finish";
  renderStageRail();
  // force a synchronous reflow before any scroll: the outgoing view's sticky
  // chrome (composer, finish bar) can otherwise leave stale composited paint
  // over the incoming view (observed on the review screen, 2026-07-29)
  void document.body.offsetHeight;
  // the interview opens where it was left off — at the live edge, not at the
  // top of a transcript the principal has already read
  followTail = true;
  if (view === "interview" && $("#chatlog").firstElementChild) { scrollTail(false); updateTailBtn(); }
  else window.scrollTo({ top: 0 });
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
  if (!state.floor) return "(roster unavailable this session; rely on general differentiation)";
  return state.floor.agents.map((a) =>
    `- ${a.name}: ${a.archetype}. Benchmark ${a.benchmark_label}. Alpha ${(a.alpha * 100).toFixed(1)}%. Last action: ${a.last_action}`
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
  // Prefer the newest interview-born member with a quotable origin; the
  // specimen should show the floor as it grows, not one pinned agent.
  const quotable = (a) => (a.principles || []).some((p) => /["“]/.test(p.origin || ""));
  const agent = [...state.floor.agents].reverse().find(quotable) ||
    state.floor.agents.find(quotable);
  if (!agent) return;
  const prins = agent.principles || [];
  const p = prins.find((x) => x.rigidity === "hard" && /["“]/.test(x.origin || "")) ||
    prins.find((x) => /["“]/.test(x.origin || ""));
  if (!p) return;
  const qm = (p.origin || "").match(/["“](.+?)["”]\)?\s*$/);
  const dm = (p.origin || "").match(/\d{4}-\d{2}-\d{2}/);
  $("#specimen").innerHTML = `
    <div class="spectop">
      <span class="label">What a seat becomes</span>
      <span class="specwho">${esc(agent.id)}</span>
    </div>
    <div class="specbody">
      <div class="tags"><span class="tag">${esc(p.id || "P")}</span><span class="tag">${esc(p.type || "")}</span><span class="tag ${p.rigidity === "hard" ? "hard" : ""}">${esc(p.rigidity || "")}</span></div>
      <p class="stmt">${esc(p.statement)}</p>
      ${qm ? `<p class="specq">“${esc(qm[1])}” — the principal${dm ? ", " + esc(dm[0]) : ""}</p>` : ""}
    </div>`;
  $("#specimen").hidden = false;
}

/* ---------------- auth ---------------- */
const EMAIL_KEY = "oo.seat.emailForSignIn";

function signinErrText(code) {
  if (code === "auth/invalid-action-code" || code === "auth/expired-action-code")
    return "That sign-in link has expired or was already used. Send a fresh one below.";
  if (code === "auth/invalid-email")
    return "That doesn't match the email the link was sent to. Check it and try again.";
  return "That sign-in link did not work. Send a fresh one below. (" + code + ")";
}

// Complete a click-through from an email sign-in link. The link can open on a
// different origin/device than the request (so the email we stashed in
// localStorage isn't here) — so instead of window.prompt we drive an in-page
// confirm + retry, and resolve only once signed in or the principal starts
// over. Runs before boot wires up onAuthStateChanged, so it owns the view.
async function completeEmailLink() {
  if (!isSignInWithEmailLink(auth, location.href)) return;
  show("landing");
  $("#signinbox").hidden = true;
  $("#beginbox").hidden = true;
  const box = $("#finishingbox"), statusEl = $("#finishingstatus");
  const form = $("#confirmemailform"), input = $("#confirmemailinput"), errEl = $("#finishingerr");
  box.hidden = false;

  const attempt = async (email) => {
    statusEl.hidden = false; form.hidden = true; errEl.hidden = true;
    try {
      await signInWithEmailLink(auth, email, location.href);
      localStorage.removeItem(EMAIL_KEY);
      history.replaceState(null, "", location.pathname);
      return true;
    } catch (e) { return e.code || String(e); }
  };

  return new Promise((resolve) => {
    const done = () => { box.hidden = true; resolve(); };
    const ask = (code) => {
      statusEl.hidden = true; form.hidden = false;
      if (code) {
        errEl.hidden = false;
        errEl.innerHTML = esc(signinErrText(code)) +
          ` <button type="button" class="plain errretry" id="signin-startover">Start over</button>`;
        $("#signin-startover").addEventListener("click", () => {
          history.replaceState(null, "", location.pathname);
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
 *  thing on it the review screen needs — what the floor may print beside their
 *  trader. Nothing is shown unless they ask for it there; a name they signed in
 *  with is a suggestion to accept, never consent already given. */
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
  if (!state.credit.name && user.displayName) {
    state.credit.name = cleanName(user.displayName);
  }
}

function landingError(msg) { const el = $("#signinerr"); el.textContent = msg; el.hidden = !msg; }

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
  // the landing and the floor read this to stop inviting a principal who
  // already has a trader to create another one
  if (state.user) {
    notePrincipal({ uid: state.user.uid, status: seated ? "seated" : "pending",
                    trader: appData.agent_id || "", name });
  }
  const stage = appData.bell && appData.bell.stage;
  const dot = $("#statusdot");
  /* A trader takes its seat in the record about a minute before the floor is
     rebuilt with it, so "seated" is not permission to send the principal
     anywhere yet. The exits open when the floor can actually show it: the bell
     reached done (the engine holds that stage back until the published floor
     serves the trader), there was no bell to wait for, or the roster this page
     loaded already has it. Until then the card stays on the run. */
  const running = !!stage && stage !== "done" && stage !== "failed";
  const onFloor = state.floorNames.includes(String(appData.agent_id || "").toLowerCase());
  const exitsOpen = !stage || stage === "done" || onFloor;
  dot.classList.toggle("done", seated && !running);
  // the member portrait the principal built — shown once there's a face to show
  const av = appData.packet && appData.packet.avatar;
  const face = $("#statusface");
  if (face) face.innerHTML = av ? avatar({ ...normalizeAvatar(av), name }, 56, { animate: true }) : "";
  if (seated) {
    $("#statusword").textContent = running ? "First session" : "Seated";
    $("#statusdetail").innerHTML = running
      ? `<b>${esc(name)}</b> has its seat. It is working through its first session now. The steps below are live.`
      : `<b>${esc(name)}</b> holds a seat on the floor. Every trade, rule, and reflection is kept on the record from its first entry onward.`;
    $("#statusbell").textContent = "";
    // the seat is finished; the desk is where this account lives from now on
    $("#statuslinks").innerHTML = exitsOpen
      ? `<a href="/desk/?t=${encodeURIComponent(appData.agent_id || name)}">Go to your desk →</a>` +
        ` &nbsp;·&nbsp; <a href="/floor/">Watch ${esc(name)} on the floor →</a>`
      : `<a href="/floor/">Watch the floor while you wait →</a>`;
  } else {
    $("#statusword").textContent = "Application received";
    const fr = appData.packet && appData.packet.first_read;
    $("#statusdetail").innerHTML =
      `<b>${esc(name)}</b> is countersigned. The charter is on the register.` +
      (fr ? `<blockquote class="firstread"><span class="label">${esc(name)} · the first read</span>${md(fr)}</blockquote>` : "");
    $("#statusbell").textContent = stage ? "" : "Next bell " + fmtBell(nextFirstBell());
    $("#statuslinks").innerHTML = `<a href="/floor/">Watch the floor while you wait →</a>`;
  }
  renderBellUI(appData, name);
}

/* "Run the first session": the principal starts the real first run and
   watches it happen. Stages stream from the application doc (ringing →
   seating → first-session → done); each is written by the engine only when
   that step is actually underway. The UI shows them as a stepper so the
   principal can see the whole process advance to completion. */
const BELL_ORDER = ["ringing", "seating", "first-session", "publishing", "done"];
function bellSteps(name) {
  return [
    { key: "ringing",       label: "Ringing the opening bell" },
    { key: "seating",       label: `Taking ${name}'s seat on the floor` },
    { key: "first-session", label: "Reading today's market and writing its first entry" },
    { key: "publishing",    label: "Putting the entry on the floor" },
    { key: "done",          label: `${name} is on the floor` },
  ];
}
function renderBellUI(appData, name) {
  const el = $("#statusrun");
  if (!el) return;
  const stage = appData.bell && appData.bell.stage;
  if (appData.status === "rejected") { el.innerHTML = ""; return; }

  // Seated some other way (e.g. the hourly ingest), with no launched run to show.
  if (appData.status === "seated" && !stage) { el.innerHTML = ""; return; }

  // Not launched yet, or a prior attempt failed → the launcher.
  if (!stage || stage === "failed") {
    el.innerHTML =
      (stage === "failed"
        ? `<p class="bellnote">The first session hit a problem. Nothing is lost; ${esc(name)} runs at the next bell regardless. You can try again now.</p>`
        : "") +
      `<button class="primary" id="btn-bell">Run the first session</button>
       <p class="bellnote">A few minutes, live. You'll watch each step below as it happens.</p>`;
    $("#btn-bell").addEventListener("click", () => ringBell(name));
    return;
  }

  // Launched → the stepper. Completed steps check off; the current one pulses.
  const ci = BELL_ORDER.indexOf(stage);
  const isDone = stage === "done";
  const rows = bellSteps(esc(name)).map((s, i) => {
    const st = (isDone || i < ci) ? "done" : i === ci ? "active" : "pending";
    return `<li class="bellstep ${st}"><span class="mk"></span><span class="lbl">${s.label}</span></li>`;
  }).join("");
  el.innerHTML =
    `<ol class="bellsteps">${rows}</ol>` +
    (isDone ? "" : `<p class="bellnote">This runs live and takes a few minutes. You can leave this page and come back.</p>`);
}

async function ringBell(name) {
  const btn = $("#btn-bell");
  if (btn) { btn.disabled = true; btn.textContent = "The bell is rung…"; }
  try {
    await httpsCallable(fns, "ringFirstBell")({ appId: state.appDoc.id });
    // stages take over from here via the doc listener
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
    history: state.history, tapeSent: state.tapeSent, done: state.done,
    ready: state.ready, handoffSeen: state.handoffSeen, tapped: state.tapped,
    // `chosen` nests INSIDE avatar deliberately: the drafts rule is a hasOnly
    // on top-level keys, so a new one here would silently break the mirror.
    avatar: { ...state.avatar, chosen: state.avatarChosen }, updates: state.updates,
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
/* ---------------- the scroll ----------------
   The page itself scrolls and the composer rides sticky over its foot, so the
   live edge of the conversation is not the bottom of the document — it is the
   line just above the composer. Everything here measures against that line, so
   a reply never streams in behind it.

   The log follows the newest words while the principal is already reading at
   the edge, and stops the moment they scroll up to re-read: only a gesture
   (wheel, drag, a scrolling key) may break the follow, never a programmatic
   scroll — so a streaming reply can never yank the page out from under them.
   Sending re-attaches: you asked, you want to see the answer. */
const TAIL_SLACK = 72; // within this of the edge still counts as being at it
const TAIL_GAP = 16;   // the newest line rests this far above the composer
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
let followTail = true;

/** Height of the chrome resting on the foot of the viewport: the composer or
 *  the finish bar, and the draft sheet they sit above on mobile. */
function footHeight() {
  let foot = 0;
  const under = (el) => Math.round(window.innerHeight - el.getBoundingClientRect().top);
  const sheet = $("#draftcol");
  if (sheet && getComputedStyle(sheet).position === "fixed") foot = under(sheet);
  for (const el of [$("#composer"), $("#finishbar")]) {
    if (!el || el.hidden || getComputedStyle(el).position !== "sticky") continue;
    foot = Math.max(foot, under(el));
  }
  return Math.max(0, Math.min(foot, window.innerHeight));
}
/** How far the newest content sits below the live edge (negative: above it). */
function tailGap() {
  const last = $("#chatlog").lastElementChild;
  if (!last) return 0;
  return Math.round(last.getBoundingClientRect().bottom -
    (window.innerHeight - footHeight() - TAIL_GAP));
}
const atTail = () => tailGap() <= TAIL_SLACK;
function scrollTail(smooth) {
  const d = tailGap();
  if (d <= 0) return; // the edge is already in view; never scroll backwards
  window.scrollBy({ top: d, behavior: smooth && !REDUCED.matches ? "smooth" : "auto" });
}
/** New words arrived: follow them if the principal is still at the edge. */
function tail(smooth) {
  if (followTail) scrollTail(smooth);
  updateTailBtn();
}
function updateTailBtn() {
  const btn = $("#btn-tail");
  if (!btn) return;
  document.documentElement.style.setProperty("--foot", footHeight() + "px");
  // the finish bar stacks above the composer (see seat.css); it needs the
  // composer's live height, which grows under a long draft answer
  const comp = $("#composer");
  document.documentElement.style.setProperty("--composer-h",
    (comp && !comp.hidden ? Math.round(comp.getBoundingClientRect().height) : 0) + "px");
  btn.hidden = $("#view-interview").hidden || followTail || tailGap() <= TAIL_SLACK;
}
function installScroll() {
  let queued = false;
  // read the position *after* the browser has applied the gesture's scroll
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
  // programmatic scrolls may only ever re-attach — including momentum landing
  // back at the edge after a flick
  addEventListener("scroll", () => {
    if (!followTail && atTail()) followTail = true;
    updateTailBtn();
  }, { passive: true });
  addEventListener("resize", () => tail(false), { passive: true });
  // A streamed reply grows the log a few words at a time; follow every frame of
  // it, and re-measure when the composer itself grows under a long answer. The
  // correction runs inside the observer callback, before paint: deferring it a
  // frame let a fresh line flash below the composer first (QA 2026-07-27).
  // Scrolling resizes nothing, so this cannot loop the observer.
  const ro = new ResizeObserver(() => tail(false));
  ro.observe($("#chatlog"));
  ro.observe($("#composer"));
  $("#btn-tail").addEventListener("click", () => {
    followTail = true;
    scrollTail(true);
    updateTailBtn();
    if (!state.done) $("#input").focus();
  });
}

function addMsg(cls, who, html, portrait) {
  const log = $("#chatlog");
  const el = document.createElement("div");
  el.className = "msg " + cls + (portrait ? " hasface" : "");
  const bubble = (who ? `<div class="who">${esc(who)}</div>` : "") +
    (cls.startsWith("sys") ? html : `<div class="text">${html}</div>`);
  el.innerHTML = portrait
    ? `<div class="portrait" aria-hidden="true">${portrait}</div><div class="bubble">${bubble}</div>`
    : bubble;
  log.appendChild(el);
  tail(false);
  return el;
}
/* The portrait beside a spoken bubble: the Registrar's engraved line while it
   holds the file, the member's own face once the agent has woken and speaks. */
function speakerPortrait(kind) {
  if (kind === "registrar") return registrarAvatar(42);
  if (kind === "agent" || kind === "firstwords" || kind === "firstread")
    return avatar({ ...state.avatar, name: agentName() }, 42, { animate: true });
  return null;
}
/* The stage rail: where the principal stands in the making of a trader.
   Derived, never asserted — the same flags that gate the machinery light it. */
function renderStageRail() {
  const el = $("#stagerail");
  if (!el) return;
  const onFinish = !$("#view-finish").hidden;
  const idx = state.done ? (onFinish ? 3 : 2) : state.handoffSeen ? 1 : 0;
  el.innerHTML = ["the interview", "your trader wakes", "the first read", "countersign"]
    .map((n, i) => `<span class="st${i < idx ? " past" : ""}${i === idx ? " now" : ""}">${n}</span>`)
    .join(`<span class="stsep">·</span>`);
}

/* The playbill: one screen of orientation before the chat begins. */
function renderPlaybill() {
  $("#pb-registrar").innerHTML = registrarAvatar(40) || "";
  // the rolled face is a teaser, not a claim: the picker decides at the end
  $("#pb-face").innerHTML = avatar({ ...state.avatar, name: "?" }, 40, {}) || "";
  window.umami?.track("playbill_view");   // funnel; no-op when analytics is absent
}

/* Two acts: the Registrar until the [WAKE] message, the agent after it. */
const agentPhase = () => state.history.some((h) => h.role === "user" && h.raw === "[WAKE]");
const agentName = () => (state.draft && state.draft.name) || "your agent";
function whoLabel(kind) {
  const n = agentName().toUpperCase();
  if (kind === "firstwords") return n + " · FIRST WORDS";
  if (kind === "firstread") return n + " · THE FIRST READ";
  if (kind === "agent") return n;
  return "REGISTRAR";
}
function renderModelMsg(raw, { kind = "registrar" } = {}) {
  return addMsg(kind === "firstread" ? "first" : "reg", whoLabel(kind),
    md(displayText(raw)), speakerPortrait(kind));
}
function renderUserMsg(raw) {
  if (raw === "[BEGIN]" || raw.startsWith("[REPAIR]")) return null;
  if (raw === "[WAKE]") {
    addMsg("sys divider", null, "· the Registrar closes the file ·");
    return addMsg("sys divider", null, `· from here, you are speaking with ${esc(agentName())} ·`);
  }
  if (raw.startsWith("[TAPE]")) {
    const dm = raw.match(/\d{4}-\d{2}-\d{2}/);
    return addMsg("sys", null, `· the tape, marks of ${dm ? esc(dm[0]) : "the last session"}, is placed on the desk ·`);
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
  const items = [
    ["name", NAME_RE.test(n.name || "")],
    ["credo", !!n.credo],
    [`principles ${prins}/2`, prins >= 2],
    ["benchmark", !!(n.benchmark && Array.isArray(n.benchmark.symbols) && n.benchmark.symbols.length && n.benchmark.label)],
    ["limits", !!(n.universe && mp > 0 && mp <= 35 && (n.constitution || []).length)],
    ["voice", !!n.voice],
  ];
  // the hypothesis is the agent's to draft — its row appears only in Act II,
  // so Act I never shows a requirement the Registrar will not ask for
  if (agentPhase() || state.handoffSeen) items.splice(3, 0, [`hypothesis ${hyps}/1`, hyps >= 1]);
  return items;
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
    body.innerHTML = `<p class="dempty">Nothing in the draft yet. It fills as you answer: name, credo, constitution, principles, hypotheses, benchmark.</p>`;
    return;
  }
  let h = "";
  h += `<div class="dsec" data-sec="name"><span class="label">Agent</span><div class="dname">${d.name ? esc(d.name) : '<span class="dwait">unnamed</span>'}${d.archetype ? `<span class="arch">${esc(d.archetype)}</span>` : ""}</div></div>`;
  if (d.address) h += `<div class="dsec" data-sec="address"><span class="label">It calls you</span><div class="dmono">${esc(d.address)}</div></div>`;
  if (d.credo) h += `<div class="dsec" data-sec="credo"><span class="label">Credo</span><div class="dcredo">“${esc(d.credo)}”</div></div>`;
  if (d.benchmark && d.benchmark.label) h += `<div class="dsec" data-sec="benchmark"><span class="label">Benchmark</span><div class="dmono">${esc(d.benchmark.label)} · what it must beat</div></div>`;
  if (d.universe) h += `<div class="dsec" data-sec="universe"><span class="label">Universe</span><div class="dmono">${esc(d.universe)}</div></div>`;
  if (d.research && typeof d.research === "string") h += `<div class="dsec" data-sec="research"><span class="label">How it researches</span><div class="dmono">${esc(d.research)}</div></div>`;
  if (d.horizon && typeof d.horizon === "string") h += `<div class="dsec" data-sec="horizon"><span class="label">Horizon</span><div class="dmono">${esc(d.horizon)}</div></div>`;
  if (d.max_position_pct) h += `<div class="dsec" data-sec="limits"><span class="label">Max position</span><div class="dmono">${esc(String(d.max_position_pct))}% of equity</div></div>`;
  if (d.class_pct) {
    const cp = normalizeClassPct(d.class_pct);
    h += `<div class="dsec" data-sec="limits"><span class="label">Markets it may enter</span><div class="dmono">` +
      `Crypto: ${cp.crypto ? `up to ${cp.crypto}% of equity` : "not permitted"}<br>` +
      `Inverse &amp; leveraged ETFs: ${cp.inverse_levered ? `up to ${cp.inverse_levered}% of equity` : "not permitted"}` +
      `</div></div>`;
  }
  if ((d.constitution || []).length) {
    h += `<div class="dsec" data-sec="constitution"><span class="label">Constitution · enforced in code</span><ul class="dlist">` +
      d.constitution.map((c) => `<li>${esc(c)}</li>`).join("") + `</ul></div>`;
  }
  if ((d.principles || []).length) {
    h += `<div class="dsec" data-sec="principles"><span class="label">Principles</span>` + d.principles.map((p, i) => `
      <div class="dprin"><div class="tags"><span class="tag">P${i + 1}</span><span class="tag">${esc(p.type || "?")}</span><span class="tag ${p.rigidity === "hard" ? "hard" : ""}">${esc(p.rigidity || "?")}</span>${p.origin === "adopted" ? `<span class="tag">adopted</span>` : ""}</div>
      <div class="stmt">${esc(p.statement || "")}</div>
      ${p.quote ? `<div class="quote">“${esc(p.quote)}” — the principal</div>`
        : p.origin === "adopted" ? `<div class="quote">adopted at charter: proposed here, taken by the principal</div>` : ""}</div>`).join("") + `</div>`;
  }
  if ((d.hypotheses || []).length) {
    h += `<div class="dsec" data-sec="hypotheses"><span class="label">Hypotheses · testing</span>` + d.hypotheses.map((x, i) => `
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
  if (next.name && next.name !== p.name) push(`name set: ${next.name}`, "name");
  if (next.credo && next.credo !== p.credo) push(p.credo ? "credo revised" : "credo added to the draft", "credo");
  const pb = (p.benchmark && p.benchmark.label) || "", nb = (next.benchmark && next.benchmark.label) || "";
  if (nb && nb !== pb) push(`benchmark set: ${nb}`, "benchmark");
  if (next.universe && next.universe !== p.universe) push("universe set", "universe");
  if (next.max_position_pct && next.max_position_pct !== p.max_position_pct)
    push(`limit set: max position ${next.max_position_pct}%`, "limits");
  if (next.class_pct) {
    const nc2 = normalizeClassPct(next.class_pct), pc2 = normalizeClassPct(p.class_pct);
    if (nc2.crypto !== pc2.crypto)
      push(nc2.crypto ? `crypto opened: up to ${nc2.crypto}%` : "crypto closed off", "limits");
    if (nc2.inverse_levered !== pc2.inverse_levered)
      push(nc2.inverse_levered
        ? `inverse & leveraged ETFs opened: up to ${nc2.inverse_levered}%`
        : "inverse & leveraged ETFs closed off", "limits");
  }
  const pc = (p.constitution || []).length, nc = (next.constitution || []).length;
  if (nc > pc) push(nc - pc === 1 ? "constitution: clause added" : `constitution: ${nc - pc} clauses added`, "constitution");
  const pp = p.principles || [], np = next.principles || [];
  np.forEach((x, i) => {
    if (!x || !x.statement) return;
    const old = pp[i];
    if (!old) push(`P${i + 1} added to the draft: ${x.type || "?"}${x.rigidity ? ", " + x.rigidity : ""}${x.origin === "adopted" ? ", adopted" : ""}`, "principles");
    else if (JSON.stringify(old) !== JSON.stringify(x)) push(`P${i + 1} amended`, "principles");
  });
  const ph = p.hypotheses || [], nh = next.hypotheses || [];
  nh.forEach((x, i) => {
    if (!x || !x.statement) return;
    if (!ph[i]) push(`H${i + 1} added to the draft${x.expiry ? `, expires ${x.expiry}` : ""}`, "hypotheses");
    else if (JSON.stringify(ph[i]) !== JSON.stringify(x)) push(`H${i + 1} amended`, "hypotheses");
  });
  if (next.voice && next.voice !== p.voice) push("voice recorded", "voice");
  if (next.address && next.address !== p.address) push(`address recorded: "${next.address}"`, "address");
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

/* ---------------- answer chips ----------------
   The law: chips decide ABOUT the record; prose IS the record. The model may
   offer 2–4 selectable answers for enumerable decisions; the composer never
   closes, and a tap sends the label verbatim as the principal's own message —
   the record keeps what was said, not what was offered. */
function validOptions(side) {
  const o = side && side.options;
  if (!Array.isArray(o) || o.length < 2 || o.length > 4) return null;
  const out = [];
  for (const it of o) {
    if (!it || typeof it.label !== "string" || !it.label.trim() || it.label.length > 48) return null;
    if (it.hint != null && typeof it.hint !== "string") return null;
    out.push({ label: it.label.trim(), hint: String(it.hint || "").trim().slice(0, 120) });
  }
  return out;
}
/* The rigidity round-trip, made deterministic.

   The prompt tells the Registrar to omit a principle's rigidity until the
   principal has chosen, then fill it in a turn later. Nothing enforces that
   second step, and when it is skipped validatePacket fails on "principle N has
   no rigidity decision" — permanently. The principal reaches the end of a
   fifteen-minute interview and the charter will not close. Observed on three
   separate personas across two full eval runs.

   So the tap itself becomes the record. Nothing here is invented: it writes
   only a value the principal actually selected, and only onto a principle that
   carries no rigidity at all. If the model does its job, this is a no-op.

   Deliberately not mirrored to drafts/{uid}: a reload between the tap and the
   reply loses the pending value, which degrades to exactly today's behaviour
   and costs no Firestore rules change. */
const RIGIDITY = { "hard rule": "hard", heuristic: "heuristic" };
function rigidityOptions(labels) {
  const vals = labels.map((l) => RIGIDITY[l.trim().toLowerCase()]);
  // every option must be a rigidity AND both values present — otherwise this is
  // some other question that merely happens to use one of the words
  return vals.every(Boolean) && new Set(vals).size === 2;
}
function applyPendingRigidity() {
  const v = state.pendingRigidity;
  if (!v) return;
  state.pendingRigidity = null;               // one tap, one application
  const ps = (state.draft || {}).principles;
  if (!Array.isArray(ps)) return;
  for (let i = ps.length - 1; i >= 0; i--) {  // the newest one still undecided
    const p = ps[i];
    if (p && !["hard", "heuristic"].includes(p.rigidity)) { p.rigidity = v; return; }
  }
}

function clearChoices() {
  state.lastOptions = [];
  document.querySelectorAll("#chatlog .choices").forEach((n) => {
    n.classList.add("fading");
    setTimeout(() => n.remove(), 140);
  });
}
function renderChoices(opts) {
  state.lastOptions = opts.map((o) => o.label);
  const isRigidity = rigidityOptions(state.lastOptions);
  const wrap = document.createElement("div");
  wrap.className = "choices";
  for (const o of opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice";
    b.innerHTML = `<span class="clabel">${esc(o.label)}</span>` +
      (o.hint ? `<span class="chint">${esc(o.hint)}</span>` : "");
    b.addEventListener("click", () => {
      state.tapped.push(o.label);
      if (isRigidity) state.pendingRigidity = RIGIDITY[o.label.trim().toLowerCase()];
      sendTurn(o.label);
    });
    wrap.appendChild(b);
  }
  $("#chatlog").appendChild(wrap);
  if (!state.choicesHintShown) {
    state.choicesHintShown = true;
    addMsg("sys", null, "· tap an answer, or write your own below ·");
  }
  tail(false);
}

/* ---------------- the creation moment ----------------
   The one choreographed sequence in the product. Nothing here is interactive
   and nothing is claimed: the charter on screen is the charter, the settle is
   the existing transition vocabulary, the pulse is the product's entire
   budget of sparkle, and the only wait afterward is a real model call. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runCreationMoment({ instant = false } = {}) {
  setBusy(true);
  const wait = (ms) => (instant ? Promise.resolve() : sleep(ms));
  await wait(600);
  const line = addMsg("sys inscribe", null, "· the charter is drafted, every rule cites your words ·");
  line.addEventListener("click", () => {
    const col = $("#draftcol");
    if (window.matchMedia("(max-width: 899px)").matches && !col.classList.contains("open")) {
      col.classList.add("open");
      $("#drafttoggle").setAttribute("aria-expanded", "true");
      $("#draftcaret").textContent = "▾";
    }
  });
  if (!instant) {
    // the settle pass: each panel section lights once, top to bottom
    const secs = [...document.querySelectorAll("#draftbody .dsec")];
    secs.forEach((s, i) => setTimeout(() => {
      s.classList.add("lit");
      setTimeout(() => s.classList.remove("lit"), 700);
    }, 300 + i * 150));
    await wait(500 + secs.length * 150);
  }
  const d = state.draft || {};
  addMsg("ceremony", null,
    `<div class="cname">${esc(d.name || "")}</div>` +
    (d.archetype ? `<div class="carch">${esc(d.archetype)}</div>` : ""));
  // the one moment worth pulling the page to, follow or no follow
  followTail = true;
  scrollTail(true);
  await wait(2200); // the single play-once pulse lives on .cname in CSS
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
    err.append(`The connection dropped during the first read. `);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "plain errretry"; btn.textContent = "Retry";
    btn.addEventListener("click", () => {
      err.hidden = true;
      state.tapeSent = true;
      sendTurn(buildTapeMessage(tapeLines(), today()));
    });
    err.append(btn);
  } else if (userRaw === "[WAKE]") {
    // both dividers come down; a retry redraws them
    if (userEl) {
      const prev = userEl.previousElementSibling;
      if (prev && prev.classList.contains("divider")) prev.remove();
      userEl.remove();
    }
    err.append(`The connection dropped while ${agentName()} was reading its charter. `);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "plain errretry"; btn.textContent = "Retry";
    btn.addEventListener("click", () => { err.hidden = true; sendTurn("[WAKE]"); });
    err.append(btn);
  } else if (userRaw.startsWith("[REPAIR]")) {
    // the automatic repair failed — fall back to the honest line; the next
    // real turn carries the repair note
    state.needsRepair = true;
    addMsg("sys", null, "· that didn't reach the draft, it will catch up next reply ·");
    return;
  } else {
    if (userEl) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "undelivered";
      btn.textContent = "not delivered · retry";
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
    err.textContent = "That didn't send. Your message is kept. Retry when ready. (" + ((e && e.message) || e) + ")";
  }
  err.hidden = false;
}

async function sendTurn(userRaw) {
  // done does NOT close the line: the charter is amendable until countersign,
  // and the post-read composer exists exactly for that. Only busy blocks.
  // (A done-guard here silently swallowed every post-read amendment — first
  // real user hit it 2026-07-29: typed the change, Send did nothing.)
  if (state.busy) return;
  followTail = true; // sending is a request to be at the live edge
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
  // machine messages ([BEGIN]/[WAKE]/[TAPE]/[REPAIR]) never count against the length
  const userTurns = state.history.filter((h) => h.role === "user" && !h.raw.startsWith("[")).length;
  if (userTurns >= MAX_TURNS) {
    addMsg("sys", null, "· the interview has run its length, review the charter below ·");
    return;
  }
  const isTape = userRaw.startsWith("[TAPE]");
  const isWake = userRaw === "[WAKE]";
  clearChoices();
  setBusy(true);
  state.streaming = true;
  $("#chaterr").hidden = true;
  state.history.push({ role: "user", raw: userRaw });
  const userEl = queuedEl || renderUserMsg(userRaw);
  const inAgentPhase = agentPhase();
  const replyKind = isTape ? "firstread" : isWake ? "firstwords" : inAgentPhase ? "agent" : "registrar";
  const bubble = renderModelMsg("", { kind: replyKind === "firstread" ? "agent" : replyKind });
  const textEl = bubble.querySelector(".text");
  // honest wait states: each string maps 1:1 to a real client state
  textEl.innerHTML = `<span class="dwait">${isWake
    ? esc(agentName()) + " is reading its charter…"
    : isTape
      ? esc(agentName()) + " is reading the day's marks…"
      : "thinking…"}</span>`;
  const contents = state.history.map((h) => ({ role: h.role, parts: [{ text: h.raw }] }));
  if (state.needsRepair && !userRaw.startsWith("[REPAIR]")) {
    // machine-injected, never rendered: the previous side channel was lost
    contents[contents.length - 1].parts[0].text +=
      "\n\n[REPAIR] The last draft block did not arrive. Include the entire draft in this reply.";
  }
  if (state.machineNote) {
    contents[contents.length - 1].parts[0].text += "\n\n[NOTE] " + state.machineNote;
    state.machineNote = "";
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
      { onRetryWait: () => { setBusy(true); textEl.innerHTML = `<span class="dwait">busy, retrying automatically…</span>`; } },
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
      // backstop for the chips law: text that arrived by tap never enters a
      // quote field — quotes hold only words the principal actually typed.
      // Checked against every tapped label of the session, not just the last
      // question's: the model has quoted a tap one turn late (QA 2026-07-25).
      if (state.tapped.length && Array.isArray(side.draft.principles)) {
        const tapped = new Set(state.tapped.map((l) => l.trim().toLowerCase()));
        for (const p of side.draft.principles) {
          if (p && p.quote && tapped.has(String(p.quote).trim().toLowerCase())) delete p.quote;
        }
      }
      // delta contract: changed fields arrive whole; unchanged fields persist
      state.draft = Object.assign({}, state.draft || {}, side.draft);
      // after the merge, not before: when the reply omits `principles` because
      // nothing else about them changed, the undecided one is only reachable
      // on the merged draft
      applyPendingRigidity();
      renderDraft();
      renderInscriptions(prevDraft, state.draft);
    }
    state.ready = !!side.ready;
    if (side.done) state.done = true;
  } else {
    // the record must never silently fall behind the conversation. Around the
    // handoff, one automatic repair keeps the ceremony from stalling on a
    // dropped packet; everywhere else the honest line appears and the next
    // turn carries the repair note.
    if (!inAgentPhase && !state.handoffSeen && !state.autoRepaired &&
        validateWakeMinimum(state.draft, state.floorNames).length === 0) {
      state.autoRepaired = true;
      state.needsRepair = false;
      saveInterview();
      setBusy(false);
      await sendTurn("[REPAIR] The last draft block did not arrive. Include the entire draft in this reply.");
      return;
    }
    state.needsRepair = true;
    addMsg("sys", null, "· that didn't reach the draft, it will catch up next reply ·");
  }
  // Act II: an agreed test must reach the record. If the tap that accepted it
  // produced no hypothesis (observed in QA: "locked into the charter", nothing
  // emitted), one machine turn demands the emission instead of dead air.
  if (inAgentPhase && !state.done && !state.ready &&
      /^agreed\b/i.test(userRaw) && state.tapped.includes(userRaw) &&
      !((state.draft || {}).hypotheses || []).length) {
    saveInterview();
    setBusy(false);
    await sendTurn("[REPAIR] The agreed test did not arrive in the machine block. Emit the ENTIRE draft including the hypothesis now, and set ready if COMPLETION is satisfied.");
    return;
  }
  // the tape reply is the first read: restyled, and the interview is done
  // regardless of the model's flag — the tape is only handed over at ready.
  if (isTape) {
    bubble.className = "msg first";
    bubble.querySelector(".who").textContent = whoLabel("firstread");
    state.done = true;
  }
  saveInterview();
  setBusy(false);
  tail(false);
  if (state.queued) {
    // a reply arrived while the tail streamed — it goes next, before any
    // hand-off. Post-read it is an amendment, and amendments are legal.
    const q = state.queued;
    await sendTurn(q.raw);
    return;
  }
  // THE HANDOFF: the Registrar closed the file. The client is the authority —
  // the ceremony runs only if the wake minimum actually stands in the draft.
  if (side && side.handoff && !inAgentPhase && !state.handoffSeen && !state.done) {
    if (validateWakeMinimum(state.draft, state.floorNames).length === 0) {
      state.handoffSeen = true;
      saveInterview();
      await runCreationMoment();
      setBusy(false); // the ceremony's lock ends where the wake call begins
      await sendTurn("[WAKE]");
      return;
    }
    addMsg("sys", null, "· the charter is missing something, the Registrar continues ·");
    state.machineNote = "The handoff was early. The wake minimum is not complete in the compiled draft. Continue the interview as the Registrar until it is.";
  }
  // if the wake minimum stands for three turns and the Registrar never closes,
  // ask for the handoff by machine note rather than stranding Act I
  if (!agentPhase() && !state.handoffSeen && !state.done) {
    if (validateWakeMinimum(state.draft, state.floorNames).length === 0) {
      state.wakeReadyTurns++;
      if (state.wakeReadyTurns >= 3 && !state.machineNote) {
        state.wakeReadyTurns = 0;
        state.machineNote = "The wake minimum is complete. Close the file in two sentences and set handoff: true in this reply's machine block, with the entire draft.";
      }
    } else state.wakeReadyTurns = 0;
  }
  if (state.ready && agentPhase() && !state.done && !state.tapeSent) {
    state.tapeSent = true;
    saveInterview();
    await sendTurn(buildTapeMessage(tapeLines(), today()));
    return;
  }
  // options render last: never before the question completed, never on a
  // finished interview, never under a queued reply
  const opts = side && !state.done && !state.queued ? validOptions(side) : null;
  if (opts) renderChoices(opts);
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
  const errs = state.draft ? validatePacket(state.draft, state.floorNames) : ["no draft was compiled"];
  const complete = errs.length === 0;
  const name = agentName();
  if (state.done && !complete) {
    // the model closed the interview but the charter fails validation — a
    // closed composer here is a dead end, so the line reopens for the fix
    state.done = false;
    saveInterview();
    $("#composer").hidden = false;
    bar.hidden = false;
    bar.classList.add("quiet");
    btn.className = "plain";
    note.textContent = "Still needed: " + errs.slice(0, 2).join(" · ");
    return;
  }
  if (state.done) {
    // The charter is the principal's until they countersign it, so the line
    // stays open: anything in it can still be changed by saying so.
    $("#composer").hidden = false;
    bar.hidden = false;
    bar.classList.remove("quiet");
    btn.className = "primary";
    note.textContent = `${name} is drafted and has spoken. Tell it what to change, or countersign to put it on the floor.`;
  } else if (complete && !agentPhase()) {
    // a complete charter with no handoff yet (single-act fallback path)
    $("#composer").hidden = false;
    bar.hidden = false;
    bar.classList.add("quiet");
    btn.className = "plain";
    note.textContent = "The charter appears complete. Review and submit whenever you are ready.";
  } else {
    // in Act II the tape follows ready on its own; no bar until it lands
    $("#composer").hidden = false;
    bar.hidden = true;
  }
  $("#input").placeholder = agentPhase() ? `Answer ${name}…` : "Answer the Registrar…";
  renderStageRail();
}

function restoreInterview(saved) {
  state.history = saved.history || [];
  state.tapeSent = !!saved.tapeSent;
  state.done = !!saved.done;
  state.ready = !!saved.ready;
  state.handoffSeen = !!saved.handoffSeen;
  state.tapped = Array.isArray(saved.tapped) ? saved.tapped : [];
  // normalizeAvatar returns only the four render values, so state.avatar stays
  // clean and `chosen` is read back alongside it.
  if (saved.avatar) {
    state.avatar = normalizeAvatar(saved.avatar);
    state.avatarChosen = saved.avatar.chosen === true;
  }
  if (saved.updates) state.updates = normalizeUpdates(saved.updates);
  // the draft first: renderUserMsg("[WAKE]") and the who-labels need the name
  const tapped = new Set(state.tapped.map((l) => l.trim().toLowerCase()));
  for (const h of state.history) {
    if (h.role !== "model") continue;
    const side = parseSideChannel(h.raw);
    if (!side || !side.draft) continue;
    if (tapped.size && Array.isArray(side.draft.principles)) {
      for (const p of side.draft.principles) {
        if (p && p.quote && tapped.has(String(p.quote).trim().toLowerCase())) delete p.quote;
      }
    }
    state.draft = Object.assign({}, state.draft || {}, side.draft);
  }
  $("#chatlog").innerHTML = "";
  let lastUserRaw = "";
  let woke = false;
  let lastSide = null;
  for (const h of state.history) {
    if (h.role === "user") {
      lastUserRaw = h.raw;
      if (h.raw === "[WAKE]") woke = true;
      renderUserMsg(h.raw);
    } else {
      const kind = lastUserRaw.startsWith("[TAPE]") ? "firstread"
        : lastUserRaw === "[WAKE]" ? "firstwords"
        : woke ? "agent" : "registrar";
      if (kind === "firstread") state.done = true; // the read landed = done, whatever the saved flag says
      renderModelMsg(h.raw, { kind });
      lastSide = parseSideChannel(h.raw);
    }
  }
  renderDraft();
  updateFinishUI();
  if (state.done) return;
  if (state.handoffSeen && !woke) {
    // the file was closed but the wake never went out — no re-ceremony
    runCreationMoment({ instant: true }).then(() => { setBusy(false); sendTurn("[WAKE]"); });
    return;
  }
  if (state.ready && woke && !state.tapeSent) {
    // the charter was complete but the tape hand-over was interrupted — resume it
    state.tapeSent = true;
    sendTurn(buildTapeMessage(tapeLines(), today()));
    return;
  }
  // the pending question's options come back with it
  const opts = lastSide ? validOptions(lastSide) : null;
  if (opts) renderChoices(opts);
}

async function beginInterview() {
  show("interview");
  window.umami?.track("interview_started");   // funnel; no-op when analytics is absent
  buildModel();
  const saved = pickSaved(loadInterview(), await loadInterviewMirror());
  if (saved && (saved.history || []).length) { restoreInterview(saved); return; }
  // the opening is authored, not generated: it renders in 0ms, and the first
  // model call happens with the principal's first answer.
  state.history.push({ role: "user", raw: "[BEGIN]" });
  state.history.push({ role: "model", raw: OPENING });
  renderModelMsg(OPENING);
  // the authored opening carries the door chips; replies render theirs in
  // sendTurn, but the seeded turn never passes through it
  const doorOpts = validOptions(parseSideChannel(OPENING));
  if (doorOpts) renderChoices(doorOpts);
  renderDraft();
  saveInterview();
  $("#input").focus();
}

/* ---------------- charter review & submit ---------------- */
function transcriptMarkdown() {
  const name = (state.draft && state.draft.name) || "unnamed";
  let out = `# Seat interview: ${name}\n\n_${today()} · Conviction League registry_\n\n`;
  let lastUser = "";
  let woke = false;
  for (const h of state.history) {
    if (h.role === "user") {
      lastUser = h.raw;
      if (h.raw === "[BEGIN]" || h.raw.startsWith("[REPAIR]")) continue;
      if (h.raw === "[WAKE]") { woke = true; out += `*The Registrar closes the file. From here, ${name} speaks for itself.*\n\n`; continue; }
      if (h.raw.startsWith("[TAPE]")) { out += `*The day's tape is placed on the desk.*\n\n`; continue; }
      out += `**Principal:** ${h.raw}\n\n`;
    } else {
      if (lastUser.startsWith("[REPAIR]")) continue; // machine repair turns stay out of the readable record
      const speaker = lastUser.startsWith("[TAPE]") ? `**${name}, the first read:**`
        : lastUser === "[WAKE]" ? `**${name}, first words:**`
        : woke ? `**${name}:**` : "**Registrar:**";
      out += `${speaker} ${displayText(h.raw)}\n\n`;
    }
  }
  return out;
}
/** The model reply that followed a machine message — the birth keepsakes. */
function replyAfter(prefix) {
  for (let i = 0; i < state.history.length - 1; i++) {
    if (state.history[i].role === "user" && state.history[i].raw.startsWith(prefix) &&
        state.history[i + 1].role === "model") return displayText(state.history[i + 1].raw);
  }
  return "";
}

/* The seat picker — a small build moment on the review screen. Four choices
   (base × colour × costume × detail) feed the four values that ride onto the
   agent record and render its avatar on every surface. Pure preview; no seat is
   taken until the charter is countersigned. */
const COSTUME_SHORT = { suit: "wall st", gilet: "fin bro", professor: "professor",
  pit: "pit", hoodie: "quant", banker: "old money" };
function renderFacePicker() {
  const a = state.avatar;
  const name = (state.draft && state.draft.name) || "your agent";
  $("#face-name").textContent = name;
  $("#facestage").innerHTML = avatar({ ...a, name }, 150, { animate: true });
  $("#facearch").textContent = ARCHETYPE[a.costume];
  const opt = (inner, on, ds) =>
    `<button type="button" class="fopt${on ? " sel" : ""}" ${ds}>${inner}</button>`;
  $("#opt-base").innerHTML = BASES.map((b) =>
    opt(headOnly({ base: b, color: a.color }, 0, false), b === a.base, `data-base="${b}"`)).join("");
  $("#opt-color").innerHTML = PALS.map((p, i) =>
    opt("", i === a.color, `data-color="${i}" style="background:${p[0]}" aria-label="${p[2]}"`).replace('class="fopt', 'class="fopt sw')).join("");
  $("#opt-costume").innerHTML = COSTUMES.map((c) =>
    opt(`<span class="fmini">${avatar({ ...a, costume: c, name }, 42)}</span><span class="fdl mono">${COSTUME_SHORT[c]}</span>`, c === a.costume, `data-costume="${c}"`).replace('class="fopt', 'class="fopt dress')).join("");
  $("#opt-detail").innerHTML = ["none", ...DETAILS].map((d2) =>
    opt(`<span class="fmini">${avatar({ ...a, acc: d2, name }, 42)}</span><span class="fdl mono">${DETAIL_LABELS[d2]}</span>`, d2 === a.acc, `data-detail="${d2}"`).replace('class="fopt', 'class="fopt dress')).join("");
}
function onFacePick(e) {
  const t = e.target.closest("[data-base],[data-color],[data-costume],[data-detail]");
  if (!t) return;
  const a = state.avatar;
  if (t.dataset.base) a.base = t.dataset.base;
  else if (t.dataset.color) a.color = Number(t.dataset.color);
  else if (t.dataset.costume) a.costume = t.dataset.costume;
  else if (t.dataset.detail) a.acc = t.dataset.detail;
  // The face on the record is now known to be the principal's own doing.
  if (!state.avatarChosen) {
    state.avatarChosen = true;
    window.umami?.track("avatar_picked");  // funnel; no-op when analytics is absent
  }
  saveInterview();
  renderFacePicker();
}

/* The updates card — chrome, not chat. The agent never promises letters (its
   capability whitelist forbids it); the product states the roadmap plainly and
   stores the choice for the email feature to honor when letters ship. */
function renderUpdatesCard() {
  const name = (state.draft && state.draft.name) || "your agent";
  $("#upd-name").textContent = name;
  $("#upd-name2").textContent = name;
  const u = state.updates;
  const r = document.querySelector(`input[name="updcadence"][value="${u.cadence}"]`);
  if (r) r.checked = true;
  $("#upd-floor").checked = !!u.floor_digest;
}
/* The name card — the principal's own line, not the trader's. It is not part of
   the packet: it lives on their user doc, is theirs to change from the desk
   forever after, and is saved as it is typed so countersigning never depends on
   it. Off unless asked for. */
let renderCreditForm = null;
function renderNameCard() {
  const name = (state.draft && state.draft.name) || "your agent";
  $("#cred-agent").textContent = name;
  const holder = $("#credform");
  if (holder.dataset.subject !== name) {
    holder.dataset.subject = name;
    holder.innerHTML = creditFormHTML({ subject: name });
    renderCreditForm = bindCreditForm(holder, state.credit, (c) => {
      if (state.user) saveCreditSoon(db, state.user.uid, c);
    });
  } else if (renderCreditForm) renderCreditForm();
}

function onUpdatesChange() {
  const r = document.querySelector('input[name="updcadence"]:checked');
  state.updates = normalizeUpdates({
    cadence: r ? r.value : "daily",
    floor_digest: $("#upd-floor").checked,
  });
  saveInterview();
}

function renderCharter() {
  const d = state.draft || {};
  $("#charter-name").textContent = d.name || "—";
  renderFacePicker();
  renderNameCard();
  renderUpdatesCard();
  // reuse the panel renderer at full width
  const hold = $("#draftbody").innerHTML;
  renderDraft();
  $("#charterbody").innerHTML = $("#draftbody").innerHTML;
  $("#draftbody").innerHTML = hold;
  addChangeLinks();
  const errs = validatePacket(d, state.floorNames);
  const box = $("#charter-errors");
  if (errs.length) {
    box.hidden = false;
    box.innerHTML = `<span class="label">The charter isn't complete yet</span><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
    $("#btn-submit").disabled = true;
  } else {
    box.hidden = true;
    $("#btn-submit").disabled = false;
  }
}

/* Nothing on the charter is final until it is countersigned, so every block on
   the review carries the way to change it: back to the conversation, with the
   sentence started. The change itself is made where every other entry was made
   — in the interview, by saying so. */
function addChangeLinks() {
  for (const sec of $("#charterbody").querySelectorAll(".dsec")) {
    const label = sec.querySelector(".label");
    if (!label || label.querySelector(".changeit")) continue;
    const what = label.textContent.trim().toLowerCase();
    const b = document.createElement("button");
    b.type = "button";
    b.className = "changeit";
    b.textContent = "change";
    b.addEventListener("click", () => amendFromReview(what));
    label.appendChild(b);
  }
}

function amendFromReview(what) {
  show("interview");
  $("#composer").hidden = false;
  const input = $("#input");
  input.value = `I want to change the ${what}: `;
  input.style.height = "";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/* The updates preference: a closed vocabulary with safe defaults. Nothing is
   sent until letters ship; the stored choice is the email feature's input. */
function normalizeUpdates(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    cadence: ["daily", "weekly", "off"].includes(src.cadence) ? src.cadence : "daily",
    floor_digest: src.floor_digest !== false,
  };
}

/**
 * Class ceilings, as percent of equity. A market the interview never opened
 * stays at zero — the engine treats an unchartered class as forbidden, not as
 * unlimited, and this must not be the place that quietly widens it.
 */
function normalizeClassPct(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const cls of ["crypto", "inverse_levered"]) {
    const n = Number(src[cls]);
    out[cls] = Number.isFinite(n) && n > 0 ? Math.min(n, 35) : 0;
  }
  return out;
}

async function submitApplication() {
  const d = state.draft || {};
  const errs = validatePacket(d, state.floorNames);
  if (errs.length) { renderCharter(); return; }
  window.umami?.track("countersigned");   // funnel; no-op when analytics is absent
  const privacy = document.querySelector('input[name="privacy"]:checked').value;
  const firstWords = replyAfter("[WAKE]");
  const firstRead = replyAfter("[TAPE]");
  const packet = {
    name: d.name, archetype: d.archetype, credo: d.credo, universe: d.universe,
    benchmark: { symbols: d.benchmark.symbols, label: d.benchmark.label },
    max_position_pct: Number(d.max_position_pct),
    class_pct: normalizeClassPct(d.class_pct),
    constitution: d.constitution, principles: d.principles, hypotheses: d.hypotheses,
    voice: d.voice, address: (d.address || "Principal").slice(0, 20),
    avatar: { ...normalizeAvatar(state.avatar), chosen: state.avatarChosen },
    updates: normalizeUpdates(state.updates),
    ...(typeof d.research === "string" && d.research ? { research: d.research.slice(0, 400) } : {}),
    ...(typeof d.horizon === "string" && d.horizon ? { horizon: d.horizon.slice(0, 120) } : {}),
    ...(firstWords ? { first_words: firstWords } : {}),
    ...(firstRead ? { first_read: firstRead } : {}),
    transcript_privacy: privacy, transcript: transcriptMarkdown(),
  };
  const btn = $("#btn-submit");
  btn.disabled = true; btn.textContent = "Submitting…";
  // the name card saves as it is typed; flush it here so a name entered in the
  // last second before countersigning is not left in a pending timer
  saveCredit(db, state.user.uid, state.credit).catch((e) => console.warn("credit:", e));
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
  injectAvatarCSS();
  installScroll();
  await Promise.all([loadFloor(), completeEmailLink()]);
  renderSpecimen();

  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    renderAuthChip();
    if (user) {
      // retention: tie the session to the signed-in principal — uid only,
      // never email. The retry covers the deferred analytics script racing auth.
      if (window.umami) window.umami.identify(user.uid);
      else setTimeout(() => window.umami?.identify(user.uid), 2000);
    }
    if (!user) {
      $("#signinbox").hidden = false;
      $("#beginbox").hidden = true;
      show("landing");
      return;
    }
    await ensureUserDoc(user);
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
  // a fresh interview passes through the playbill once; a resume goes
  // straight back into the room (orientation on re-entry is friction)
  $("#btn-begin").addEventListener("click", async () => {
    const saved = pickSaved(loadInterview(), await loadInterviewMirror());
    if (saved && (saved.history || []).length) return beginInterview();
    renderPlaybill();
    show("playbill");
  });
  $("#btn-meet").addEventListener("click", beginInterview);

  // Local staging only: one-click sign-in, so testing needs no second email and
  // no sign-in link. Anonymous — a fresh principal each time the emulator is
  // restarted. Never rendered anywhere but localhost.
  if (IS_LOCAL) {
    const dev = document.createElement("button");
    dev.type = "button";
    dev.className = "plain";
    dev.style.cssText = "border-style:dashed;margin-top:4px";
    dev.textContent = "Dev sign-in · local test, no email";
    dev.addEventListener("click", async () => {
      landingError("");
      try { await signInAnonymously(auth); }
      catch (e) { landingError("Dev sign-in failed. (" + (e.code || e) + ")"); }
    });
    $("#signinbox").appendChild(dev);
  }

  /* interview wiring — Enter sends, Shift+Enter breaks the line */
  const input = $("#input");
  function submitComposer() {
    const text = input.value.trim();
    if (!text || state.busy) return;
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
  $("#btn-review").addEventListener("click", () => { renderCharter(); show("finish"); window.umami?.track("review_reached"); });

  /* finish wiring */
  $("#btn-back").addEventListener("click", () => show("interview"));
  $("#btn-submit").addEventListener("click", submitApplication);
  document.querySelector(".facecontrols").addEventListener("click", onFacePick);
  document.querySelector(".updatescard").addEventListener("change", onUpdatesChange);
}

boot();
