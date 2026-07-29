// Conviction League — who is named on the floor.
//
// The floor names whoever chartered each trader. Whether that is a person's
// name or nothing at all is the principal's own call, so it is not a clause of
// any charter: it lives on their user doc, where both the seat and the desk can
// write it, and the engine (jobs/credit.py) carries it into the floor's next
// build. Anonymous is the default and the fallback — a name is published only
// when someone has asked for it.
//
// cleanName mirrors jobs/credit.clean_name; the engine sanitizes again on the
// way in, so this is the courtesy, not the guard.

import {
  doc, setDoc,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

export const MAX_NAME = 60;
const LINKY = /https?:\/\/|www\.|\S+\.(?:com|net|org|io|xyz|co|ai)\b/i;
const ANON = { name: "", show: false };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** A person's name as it will be printed on a public page: one line, no
 *  control characters, no link bait, 60 characters at most. */
export function cleanName(raw) {
  const s = [...String(raw ?? "")]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/[<>]/g, " ")            // a name is never markup
    .replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return LINKY.test(s) ? "" : s;
}

export function normalizeCredit(c) {
  if (!c || typeof c !== "object") return { ...ANON };
  const name = cleanName(c.name);
  return { name, show: !!(name && c.show === true) };
}

export function saveCredit(db, uid, credit) {
  return setDoc(doc(db, "users", uid), { credit: normalizeCredit(credit) },
                { merge: true });
}

/** Debounced save — the control writes as it is typed in, with no submit. */
let timer = null;
export function saveCreditSoon(db, uid, credit, ms = 700) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    saveCredit(db, uid, credit).catch((e) => console.warn("credit save:", e));
  }, ms);
}

/** The control, identical wherever it is offered so the promise cannot drift.
 *  `subject` is what the name would sit beside — a trader's name, or "your
 *  trader" before there is one. */
export function creditFormHTML({ subject = "your trader", id = "cred" } = {}) {
  return `<label class="credopt"><input type="checkbox" id="${id}-show">
      <span><b>Show my name beside ${esc(subject)}</b>
      <span class="d">— on the public floor, where anyone can read it.</span></span></label>
    <div class="credrow">
      <input type="text" id="${id}-name" maxlength="${MAX_NAME}" autocomplete="name"
             placeholder="Your full name" aria-label="Your full name">
      <span class="credprev" id="${id}-prev"></span>
    </div>`;
}

/* The control's own look travels with it, so the seat and the desk cannot
   drift apart; the card around it is each page's own chrome. */
const CREDIT_CSS = `
.credopt { display: flex; gap: 10px; align-items: flex-start; padding: 4px 0 10px; cursor: pointer; font-size: 14px; line-height: 1.45; }
.credopt input { margin-top: 3px; accent-color: var(--ink); width: 16px; height: 16px; flex: none; }
.credopt b { font-weight: 600; }
.credopt .d { font-size: 13px; color: var(--ink2); }
.credrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 4px 0 2px; }
.credrow input[type="text"] {
  /* 16px minimum: any smaller and iOS Safari zooms the viewport on focus */
  flex: 1 1 210px; min-width: 0; padding: 9px 11px; font: inherit; font-size: 16px;
  color: var(--ink); background: var(--page); border: 1px solid var(--border);
  border-radius: 8px; min-height: 44px;
}
.credrow input[type="text"]:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
.credprev { font-size: 12px; color: var(--muted); flex: 1 1 190px; }
.credprev.on { color: var(--ink2); }
@media (max-width: 560px) { .credrow input[type="text"] { flex-basis: 100%; } }`;

export function injectCreditCSS(doc = document) {
  if (doc.getElementById("oo-credit-css")) return;
  const s = doc.createElement("style");
  s.id = "oo-credit-css";
  s.textContent = CREDIT_CSS;
  doc.head.appendChild(s);
}

/** Wire the control to a `{name, show}` state object; `onChange` receives the
 *  cleaned value to save. Returns a render function for outside changes. */
export function bindCreditForm(root, state, onChange, id = "cred") {
  injectCreditCSS(root.ownerDocument || document);
  const box = root.querySelector(`#${id}-show`);
  const input = root.querySelector(`#${id}-name`);
  const prev = root.querySelector(`#${id}-prev`);
  const render = () => {
    box.checked = !!state.show;
    if (input.value !== state.name) input.value = state.name;
    const n = cleanName(state.name);
    prev.textContent = !state.show ? "not shown — your trader is listed on its own"
      : n ? `chartered by ${n}`
      : "add your name and the floor will show it";
    prev.classList.toggle("on", !!(state.show && n));
  };
  const changed = () => {
    state.name = input.value.slice(0, MAX_NAME);
    // A ticked box with an empty field is a request, not a name: keep the tick,
    // let the preview say what is missing, and save nothing publishable yet.
    state.show = box.checked;
    render();
    const n = cleanName(state.name);
    onChange({ name: n, show: state.show && !!n });
  };
  box.addEventListener("change", changed);
  input.addEventListener("input", changed);
  render();
  return render;
}
