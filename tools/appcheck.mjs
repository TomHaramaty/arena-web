/* App Check attestation for the Node rigs.
 *
 * WHY THIS EXISTS. `/seat` and `/desk` call Firebase AI Logic straight from the
 * browser, and the only thing standing between the public API key in the served
 * JS and anyone spending the project's Gemini budget is App Check. Turning
 * enforcement on closes that hole and, as a side effect, shuts out every caller
 * that is not a real browser — including `tools/evals/run.mjs` and
 * `tools/interview-harness.mjs`, which are the only checks that exist on the
 * Registrar prompt, the most tuned surface in the product.
 *
 * A debug token is the sanctioned way through. It is registered against the web
 * app in the Firebase console, exchanged here for a short-lived App Check
 * token, and sent as `X-Firebase-AppCheck` on every model call.
 *
 * THE TOKEN IS A CREDENTIAL. It is read from the environment and must never be
 * committed, printed, or pasted into a rig. Anyone holding it can attest as
 * this app.
 *
 *   export APPCHECK_DEBUG_TOKEN=<the uuid from the console>
 *   node tools/evals/run.mjs
 *
 * Without it, `appCheckHeaders()` returns nothing at all and the rigs behave
 * exactly as they always have. That is deliberate: while enforcement is off the
 * rigs must keep working untouched, so this can ship and be verified before the
 * switch is thrown rather than in the same anxious minute.
 */

const PROJECT = "open-outcry";
const APP_ID = "1:56794274079:web:1fe7981df1430587e2782a";
const EXCHANGE =
  `https://firebaseappcheck.googleapis.com/v1/projects/${PROJECT}/apps/${APP_ID}:exchangeDebugToken`;

let cached = null; // { token, expiresAt }

/** Exchange the debug token for an App Check token, reusing it until it is
 *  nearly expired. A rig makes hundreds of model calls; one exchange serves
 *  them all, and re-exchanging per call would be its own rate limit. */
async function appCheckToken() {
  const debug = process.env.APPCHECK_DEBUG_TOKEN;
  if (!debug) return null;
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const r = await fetch(EXCHANGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ debugToken: debug }),
  });
  const d = await r.json();
  if (!r.ok || !d.token) {
    // Say which failure this is. An unregistered token and an unreachable
    // service look identical from the call site and are not the same problem.
    throw new Error(
      `App Check debug exchange failed (HTTP ${r.status}). ` +
      `Check the token is registered against this app in the Firebase console. ` +
      JSON.stringify(d).slice(0, 200)
    );
  }
  // ttl arrives as a duration string, e.g. "3600s".
  const ttl = parseInt(String(d.ttl || "3600s"), 10) * 1000;
  cached = { token: d.token, expiresAt: Date.now() + ttl };
  return d.token;
}

/** Headers to merge into a model call. Empty when no debug token is set. */
export async function appCheckHeaders() {
  const t = await appCheckToken();
  return t ? { "X-Firebase-AppCheck": t } : {};
}

/** One line for a rig to print at startup, so a run's transcript records
 *  whether it was attesting. A silent rig that stops attesting is how the
 *  eval suite dies quietly the day enforcement goes on. */
export function appCheckStatus() {
  return process.env.APPCHECK_DEBUG_TOKEN
    ? "App Check: attesting with a debug token"
    : "App Check: no debug token set (fine while enforcement is off)";
}
