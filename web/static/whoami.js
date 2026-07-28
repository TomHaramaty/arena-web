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
  const mine = seated ? `${p.name}'s desk` : "Your desk";

  // The way back in and the invitation are the same door once we know who this
  // is: the sign-in link steps aside rather than sitting beside its own twin.
  for (const el of document.querySelectorAll('[data-cta="signin"]')) el.hidden = true;

  for (const el of document.querySelectorAll('[data-cta="seat"]')) {
    el.setAttribute("href", "/desk/");
    const small = el.querySelector(".btnsub");
    if (small) {
      // a page-body button has room to say what is waiting
      el.textContent = "Go to your desk";
      const s = document.createElement("span");
      s.className = "btnsub";
      s.textContent = seated ? `${p.name} is on the floor` : "your first session is waiting";
      el.appendChild(s);
    } else {
      // a header link says whose desk it is, and keeps its arrow if it had one
      el.textContent = el.textContent.trim().endsWith("→") ? mine + " →" : mine;
    }
  }
}

const principal = readPrincipal();
if (principal) apply(principal);
