// Does the desk ever tell a principal they have no trader when it does not know?
//
// A principal wrote in to say his trader had disappeared. His screen said "No
// trader yet". What had actually happened is that the lookup failed and the page
// answered anyway — Firestore serves an empty local cache when it cannot reach the
// backend, and an empty cache is indistinguishable from an empty account unless
// you read snaps.metadata.fromCache.
//
// Run against the emulator rig (./test-seat.sh in another terminal), from a
// directory where puppeteer-core resolves:
//   node tools/test-desk-lookup.mjs
//
// Four cases:
//   CONTROL   — lookup succeeds, genuinely nothing on file → "No trader yet" (correct)
//   (the fourth, SEAT, is at the bottom)
//   DENIED    — lookup rejects (permission denied)          → must NOT claim "No trader yet"
//   OFFLINE   — backend unreachable, getDocs never settles  → must not hang forever
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:5002";
const RULES = "http://127.0.0.1:8080/emulator/v1/projects/open-outcry:securityRules";
const say = (...a) => console.log(...a);

const setRules = (content) => fetch(RULES, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }),
}).then((r) => r.ok || Promise.reject(new Error("rules PUT " + r.status)));

const OPEN = `rules_version='2';
service cloud.firestore { match /databases/{db}/documents {
  match /{document=**} { allow read, write: if request.auth != null; } } }`;
const DENY = `rules_version='2';
service cloud.firestore { match /databases/{db}/documents {
  match /{document=**} { allow read, write: if false; } } }`;

const word = async (page, ms = 25000) => {
  try {
    await page.waitForFunction(
      () => document.querySelector("#statusword")?.textContent?.trim()
            && document.querySelector("#statusword").textContent.trim() !== "—",
      { timeout: ms });
    return await page.$eval("#statusword", (e) => e.textContent.trim());
  } catch { return "(never rendered — the page hung)"; }
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();

await setRules(OPEN);
await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
await page.waitForSelector("#signinbox button.plain", { timeout: 15000 });
await (await page.$$("#signinbox button.plain")).at(-1).click();
await page.waitForFunction(() => !document.querySelector("#beginbox").hidden, { timeout: 20000 });
say("  signed in as an anonymous dev principal");

// 1. CONTROL
await page.goto(`${BASE}/desk/`, { waitUntil: "networkidle2" });
const control = await word(page);
say(`  CONTROL  lookup succeeds, nothing on file : "${control}"`);

// 2. DENIED — the lookup rejects
await setRules(DENY);
await page.goto(`${BASE}/desk/`, { waitUntil: "domcontentloaded" });
const denied = await word(page);
say(`  DENIED   lookup rejects                   : "${denied}"`);

// 3. OFFLINE — the backend is unreachable and getDocs never settles
await setRules(OPEN);
await page.setRequestInterception(true);
page.on("request", (r) => (r.url().includes("127.0.0.1:8080") ? r.abort() : r.continue()));
const t0 = Date.now();
await page.goto(`${BASE}/desk/`, { waitUntil: "domcontentloaded" });
const offline = await word(page, 30000);
say(`  OFFLINE  backend unreachable              : "${offline}"  (after ${Math.round((Date.now() - t0) / 1000)}s)`);
await page.screenshot({ path: "desk-unreachable.png" });

// 4. The seat page under the same condition: it must not invite a principal who
// may already own a trader into a fresh fifteen-minute interview.
await page.goto(`${BASE}/seat/`, { waitUntil: "domcontentloaded" });
let seat = "(nothing rendered)";
try {
  await page.waitForFunction(() =>
    (!document.querySelector("#beginbox")?.hidden && "INVITED to a new interview")
    || (!document.querySelector("#lookupfailed")?.hidden && "told the lookup failed"),
    { timeout: 25000 });
  seat = await page.evaluate(() =>
    (!document.querySelector("#beginbox").hidden && "INVITED to a new interview")
    || (!document.querySelector("#lookupfailed").hidden && "told the lookup failed"));
} catch { /* leave the marker */ }
say(`  SEAT     same condition, returning user  : ${seat}`);

const pass = seat === "told the lookup failed"
  && control === "No trader yet"
  && denied === "Can't reach your desk"
  && offline === "Can't reach your desk";
say("");
say(pass
  ? "  PASS — only a lookup that actually answered says the principal has no trader"
  : "  FAIL — see the three lines above");
await browser.close();
process.exit(pass ? 0 : 1);
