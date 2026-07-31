// Can a principal discard an interview and begin again — and can that go wrong
// in a way that costs them the interview they still have?
//
// Until 2026-07-31 there was no way to start over at all: the interview state was
// sticky, and a principal who wanted a clean slate had to ask someone with
// database access. The dangerous half of adding one is the ORDER — clear this
// device first, fail to delete the mirror, and the interview resurrects on the
// next visit, which is worse than not clearing at all.
//
// Run against the emulator rig (./test-seat.sh in another terminal), from a
// directory where puppeteer-core resolves:
//   node tools/test-seat-startover.mjs
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:5002";
const FS = "http://127.0.0.1:8080/v1/projects/open-outcry/databases/(default)/documents";
const ADMIN = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const say = (...a) => console.log(...a);
const results = [];
const check = (name, got, want) => {
  const ok = got === want;
  results.push(ok);
  say(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? `: ${got}` : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

// accounts:query, not GET /accounts — the latter answers 200 with an empty body
// for anonymous users, and then everything below silently addresses drafts/undefined
const newestUid = () => fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/open-outcry/accounts:query",
  { method: "POST", headers: ADMIN, body: "{}" }).then((r) => r.json())
  .then((j) => (j.userInfo || []).sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0]?.localId);

const seedDraft = (uid, turns) => fetch(`${FS}/drafts/${uid}`, {
  method: "PATCH", headers: ADMIN,
  body: JSON.stringify({ fields: {
    history: { arrayValue: { values: Array.from({ length: turns }, () => (
      { mapValue: { fields: { role: { stringValue: "user" }, raw: { stringValue: "x" } } } })) } },
    ready: { booleanValue: false }, done: { booleanValue: false } } }),
}).then((r) => (r.ok ? r : Promise.reject(new Error("seed " + r.status))));

const draftExists = (uid) => fetch(`${FS}/drafts/${uid}`, { headers: ADMIN }).then((r) => r.status === 200);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("dialog", (d) => d.accept());          // the confirm()

const beginText = () => page.$eval("#btn-begin", (e) => e.textContent.trim());
const startOverShown = () => page.$eval("#btn-startover", (e) => !e.hidden);
const landing = async () => {
  await page.waitForFunction(() => !document.querySelector("#beginbox")?.hidden, { timeout: 20000 });
};

// sign in
await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
await page.waitForSelector("#signinbox button.plain", { timeout: 15000 });
await (await page.$$("#signinbox button.plain")).at(-1).click();
await landing();
const uid = await newestUid();
say(`  signed in as ${uid}`);

// 1. nothing to discard — the control must not be offered at all
check("fresh principal is invited to begin", await beginText(), "Begin the interview");
check("fresh principal is offered no start-over", await startOverShown(), false);

// 2. an interview on file (mirror only — as if sat on another device)
await seedDraft(uid, 14);
await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
await landing();
await page.waitForFunction(() => !document.querySelector("#btn-startover")?.hidden, { timeout: 15000 });
check("an interview on file is offered a resume", await beginText(), "Resume the interview");
check("an interview on file is offered a start-over", await startOverShown(), true);

// 3. THE FAILURE PATH FIRST, while there is something to lose: with the backend
//    unreachable the mirror cannot be deleted, so nothing at all may be deleted.
const blockFirestore = (r) => (r.url().includes("127.0.0.1:8080") ? r.abort() : r.continue());
await page.setRequestInterception(true);
page.on("request", blockFirestore);
await page.click("#btn-startover");
await page.waitForFunction(                       // landingError() writes into #signinerr
  () => (document.querySelector("#signinerr")?.textContent || "").includes("nothing was deleted"),
  { timeout: 20000 }).catch(() => {});
const saidNothingDeleted = await page.$eval("#signinerr",
  (e) => (e.textContent || "").includes("nothing was deleted"));
page.off("request", blockFirestore);
await page.setRequestInterception(false);
check("a failed start-over says nothing was deleted", saidNothingDeleted, true);
check("a failed start-over leaves the interview on the server", await draftExists(uid), true);
await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
await landing();
await page.waitForFunction(() => !document.querySelector("#btn-startover")?.hidden, { timeout: 15000 }).catch(() => {});
check("a failed start-over leaves the interview resumable", await beginText(), "Resume the interview");

// 4. the real thing
await page.click("#btn-startover");
await page.waitForFunction(() => document.querySelector("#btn-startover")?.hidden === true, { timeout: 20000 });
check("start-over leaves nothing to resume", await beginText(), "Begin the interview");
check("start-over hides itself afterwards", await startOverShown(), false);
check("start-over deletes the interview on the server", await draftExists(uid), false);
check("start-over clears this device too", await page.evaluate((u) =>
  localStorage.getItem("oo.seat.interview." + u) === null, uid), true);

// 5. and it must not come back — the whole point of deleting the mirror first
await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
await landing();
await new Promise((r) => setTimeout(r, 1500));            // let the mirror read settle
check("the interview does not resurrect on the next visit", await beginText(), "Begin the interview");
check("and is still not offered a start-over", await startOverShown(), false);

await browser.close();
const failed = results.filter((r) => !r).length;
say("");
say(failed ? `  FAIL — ${failed} of ${results.length}` : `  PASS — all ${results.length} checks`);
process.exit(failed ? 1 : 0);
