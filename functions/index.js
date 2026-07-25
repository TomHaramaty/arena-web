// Open Outcry — server-side pieces the static site cannot hold.
//
// ringFirstBell: the principal clicked "Run the first session" on the status
// card. Verify they own the application, mark the bell rung on the doc (the
// card streams stages from it), and fire the engine's first-bell workflow via
// repository_dispatch. The GitHub token lives in Secret Manager, never in the
// browser. The hourly ingest + daily close bell remain the safety net, so a
// failure here delays nothing beyond today.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const GH_TOKEN = defineSecret("GH_TOKEN");

exports.ringFirstBell = onCall(
  { region: "us-central1", secrets: [GH_TOKEN], cors: true },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const appId = String((req.data && req.data.appId) || "").trim();
    if (!appId || appId.length > 64) throw new HttpsError("invalid-argument", "No application named.");

    const ref = admin.firestore().collection("applications").doc(appId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "No such application.");
    const d = snap.data();
    if (d.uid !== req.auth.uid) throw new HttpsError("permission-denied", "Not your application.");
    if (d.status === "rejected") throw new HttpsError("failed-precondition", "The application was not accepted.");
    const stage = d.bell && d.bell.stage;
    if (stage && stage !== "failed") return { ok: true, already: true, stage };

    await ref.update({
      bell: { stage: "ringing", at: admin.firestore.FieldValue.serverTimestamp() },
    });
    const r = await fetch("https://api.github.com/repos/TomHaramaty/arena-engine/dispatches", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GH_TOKEN.value()}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "open-outcry-first-bell",
      },
      body: JSON.stringify({ event_type: "first-bell", client_payload: { app_id: appId } }),
    });
    if (r.status !== 204) {
      await ref.update({ "bell.stage": "failed" });
      console.error("dispatch failed", r.status, (await r.text()).slice(0, 300));
      throw new HttpsError("internal", "The bell did not reach the engine.");
    }
    return { ok: true };
  },
);
