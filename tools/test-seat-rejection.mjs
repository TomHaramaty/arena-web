// What happens to a charter the registry refuses?
//
// Until 2026-07-31: nothing good. The seat clears the interview the moment an
// application is written, and the status card had exactly two branches — seated,
// and "Application received … the charter is on the register". A refused charter
// rendered the second one. So a principal who lost a race for a name saw a page
// telling them their charter was on the register, forever, with the reasons the
// engine had written shown to nobody and their fifteen minutes already cleared.
//
// The packet is intact on the application doc the whole time. These cases prove
// it comes back.
//
// Run against the emulator rig (./test-seat.sh in another terminal), from a
// directory where puppeteer-core resolves:
//   node tools/test-seat-rejection.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from "fs";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:5002";
const FS = "http://127.0.0.1:8080/v1/projects/open-outcry/databases/(default)/documents";
const ADMIN = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const ARENA = "public/arena.json";

let pass = 0, fail = 0;
const ok = (cond, what) => { cond ? pass++ : fail++; console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); };

// The reserved list reaches the page through arena.json, which is a build
// artifact here — patch it, and put it back whatever happens.
const backup = ARENA + ".rigbak";
copyFileSync(ARENA, backup);
const arena = JSON.parse(readFileSync(ARENA, "utf8"));
arena.reserved = ["spy", "catalyst", "registrar"];
writeFileSync(ARENA, JSON.stringify(arena));

const PACKET = {
  name: "vector", archetype: "Contrarian", credo: "Buy what the crowd forgot.",
  universe: "US large caps", benchmark: { symbols: ["SPY"], label: "SPY" },
  max_position_pct: 20, class_pct: { crypto: 0, inverse_levered: 0 },
  constitution: ["Never short."], voice: "dry", address: "Principal",
  principles: [{ statement: "Cut losers early.", type: "exit", rigidity: "hard" },
               { statement: "Add on strength.", type: "entry", rigidity: "heuristic" }],
  hypotheses: [{ statement: "Gaps fill.", prediction: "60% fill", falsifier: "under 40%", expiry: "2026-12-31" }],
};

const toValue = (v) => {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
};

const putApp = (id, fields) => fetch(`${FS}/applications/${id}`, {
  method: "PATCH", headers: ADMIN,
  body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }),
}).then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(`seed ${r.status} ${t}`)))));

const listApps = () => fetch(`${FS}/applications?pageSize=50`, { headers: ADMIN })
  .then((r) => r.json()).then((j) => (j.documents || []));

const wipeApps = async () => {
  for (const d of await listApps()) {
    await fetch(`https://firestore.googleapis.com`.replace("https://firestore.googleapis.com", "http://127.0.0.1:8080")
      + "/v1/" + d.name, { method: "DELETE", headers: ADMIN });
  }
};

const statusWord = async (page, ms = 20000) => {
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector("#statusword");
      return el && el.textContent.trim() && !document.querySelector("#view-status").hidden;
    }, { timeout: ms });
    return await page.$eval("#statusword", (e) => e.textContent.trim());
  } catch { return "(never rendered)"; }
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

try {
  await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#signinbox button.plain", { timeout: 15000 });
  await (await page.$$("#signinbox button.plain")).at(-1).click();
  await page.waitForFunction(() => !document.querySelector("#beginbox").hidden, { timeout: 20000 });
  const uid = await page.evaluate(() => JSON.parse(localStorage.getItem("oo.principal") || "{}").uid
    || Object.keys(localStorage).length);
  const who = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/open-outcry/accounts:query",
    { method: "POST", headers: ADMIN, body: "{}" })
    .then((r) => r.json())
    .then((j) => (j.userInfo || []).sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0]?.localId);
  if (!who) throw new Error("no signed-in account in the auth emulator");
  console.log(`  signed in as ${who}${uid ? "" : ""}`);

  // ---- 1. a refusal that is only about the name
  console.log("\nCASE the name was taken");
  await wipeApps();
  await putApp("rejected1", {
    uid: who, status: "rejected", packet: PACKET,
    reasons: ["The name 'vector' is already registered. The floor does not need an echo."],
    blocked: ["name"],
  });
  await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
  const word = await statusWord(page);
  ok(word === "The name is taken", `the card says what happened: "${word}"`);
  const body = await page.$eval("#view-status", (e) => e.innerText);
  ok(!/on the register|countersigned\./i.test(body), "it does NOT claim the charter is on the register");
  ok(/already registered/.test(body), "the registrar's own words are shown verbatim");
  ok(await page.$("#newname") !== null, "a way back in is offered");

  // ---- 2. the guards on the new name
  console.log("\nCASE choosing the new name");
  // Degrades rather than throws: this rig is meant to be run against the OLD
  // code to prove it has teeth, and a stack trace there says less than four
  // named failures do.
  const type = async (v) => {
    if (!(await page.$("#newname"))) return { disabled: true, note: "(no rename control on this build)" };
    await page.$eval("#newname", (e) => { e.value = ""; });
    await page.type("#newname", v);
    return { disabled: await page.$eval("#btn-rename", (e) => e.disabled),
             note: await page.$eval("#renamenote", (e) => e.textContent.trim()) };
  };
  let r = await type("vector");
  ok(r.disabled && /just refused/.test(r.note), "the refused name itself is refused again");
  r = await type("spy");
  ok(r.disabled && /already spoken for/.test(r.note), "a reserved name is caught here, not at seating");
  r = await type("XX");
  ok(r.disabled && /lowercase word/.test(r.note), "a malformed name is explained");
  r = await type("nexus");
  ok(!r.disabled, "a free name is accepted");

  // ---- 3. the same charter, one word different
  console.log("\nCASE countersigning again");
  if (await page.$("#btn-rename")) await page.click("#btn-rename");
  await page.waitForFunction(() => document.querySelector("#statusword").textContent.includes("Application received"), { timeout: 15000 });
  const apps = await listApps();
  const fresh = apps.filter((d) => d.fields.status.stringValue === "submitted");
  ok(fresh.length === 1, `exactly one new application was written (${fresh.length})`);
  const p = fresh[0]?.fields.packet.mapValue.fields || {};
  ok(p.name?.stringValue === "nexus", `it carries the new name (${p.name?.stringValue})`);
  ok(p.credo?.stringValue === PACKET.credo, "every other word of the charter is unchanged");
  ok(p.principles?.arrayValue.values.length === 2, "the principles came with it");
  const old = apps.find((d) => d.name.endsWith("/rejected1"));
  ok(old?.fields.status.stringValue === "rejected", "the refused application is left exactly as it was");

  // ---- 4. reloading lands on the live application, not the refusal
  console.log("\nCASE coming back later");
  await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
  const back = await statusWord(page);
  ok(back === "Application received", `the newest application is what is shown: "${back}"`);

  // ---- 5. a refusal a rename cannot fix
  console.log("\nCASE refused for more than the name");
  await wipeApps();
  await putApp("rejected2", {
    uid: who, status: "rejected", packet: PACKET,
    reasons: ["The name 'vector' is already registered. The floor does not need an echo.",
              "Maximum single position must be at or below the arena ceiling of 35%."],
    blocked: [],
  });
  await page.goto(`${BASE}/seat/`, { waitUntil: "networkidle2" });
  const word2 = await statusWord(page);
  ok(word2 === "Not seated", `the card is honest without pretending it can fix it: "${word2}"`);
  ok(await page.$("#newname") === null, "no rename is offered, because a rename would not help");
  const body2 = await page.$eval("#view-status", (e) => e.innerText);
  ok(/hello@conviction-league.com/.test(body2), "it says how to reach a person");
  ok(/arena ceiling/.test(body2) && /already registered/.test(body2), "both reasons are shown");

  ok(errs.length === 0, `no page errors (${errs.join(" | ") || "none"})`);
} finally {
  await browser.close();
  copyFileSync(backup, ARENA);
  if (existsSync(backup)) unlinkSync(backup);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
