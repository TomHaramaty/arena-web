// One job: a principal who already has a trader should never be invited to
// create one. The static pages (the landing, the floor) cannot ask Firebase who
// is signed in without pulling the whole SDK onto the top of the funnel — so the
// authenticated surfaces leave a small note behind, and this reads it.
//
// The note is a hint, never a source of truth: if it is stale the CTA points at
// /desk, which shows sign-in or the waiting room, whichever is actually true.
// Anything unexpected leaves the page exactly as rendered.

export const KEY = "oo.principal";

export function readPrincipal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && p.uid ? p : null;
  } catch { return null; }
}

/** Called by /desk and /seat, which know the truth. */
export function notePrincipal(p) {
  try {
    if (!p || !p.uid) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(p));
  } catch { /* private browsing: the CTA simply stays as rendered */ }
}

function apply(p) {
  const seated = p.status === "seated" && p.name;
  const label = "Go to your desk";
  const sub = seated ? `${p.name} is on the floor` : "your first session is waiting";
  for (const el of document.querySelectorAll('[data-cta="seat"]')) {
    el.setAttribute("href", "/desk/");
    const small = el.querySelector(".btnsub");
    if (small) {
      el.textContent = label;
      const s = document.createElement("span");
      s.className = "btnsub";
      s.textContent = sub;
      el.appendChild(s);
    } else {
      el.textContent = el.textContent.trim().endsWith("→") ? label + " →" : label;
    }
  }
}

const principal = readPrincipal();
if (principal) apply(principal);
