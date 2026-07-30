// Render each trader's avatar to a PNG for use in email.
//
// avatar.js draws SVG at runtime. Gmail strips inline SVG and blocks data: URI
// images, so a letter can only carry a face as a hosted raster. This renders
// the SAME module the floor uses — no second drawing of the art — at 3x for
// retina, onto the letter's paper colour (email has no transparency story
// worth relying on).
//
// A newly chartered trader has no face until this runs, and its letter would
// carry a broken image. The deploy workflow runs `--missing` on every publish, so
// that is no longer anyone's job to remember — the forms below are for fixing or
// re-rendering a face by hand.
//
//   node tools/gen-avatars.mjs           # every trader on the record
//   node tools/gen-avatars.mjs vector    # only this one — leaves shipped PNGs untouched
//   node tools/gen-avatars.mjs --missing # only traders with no PNG yet (what CI runs)
//
// Naming a trader that isn't on the record exits 1 rather than reporting "0
// avatars", which reads like success and is how a stale data/arena.json wasted an
// afternoon: git pull before blaming the generator.
//
// The same face rendered twice by the same Chrome is byte-identical, but CI's
// Chrome and yours are not each other's: glide came out 3881 bytes here and 5544
// in CI, same art. So render the ones you mean — a bare run rewrites all 21 PNGs
// with no visible change and buries the one that mattered.
//
// Needs puppeteer-core and a local Chrome; this repo has no root npm project,
// so install it somewhere and symlink node_modules here, or set CHROME=.
import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = path.join(WEB, "web", "static");
const OUT = path.join(STATIC, "avatars");
const PAPER = "#fcfcfb";       // letter card background
const DISPLAY = 48;            // rendered size in the letter
const SCALE = 3;               // retina
const PORT = 5210;

fs.mkdirSync(OUT, { recursive: true });

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  // the stage must be served from the SAME origin as avatar.js, or the dynamic
  // import is blocked — about:blank via setContent is not the same origin
  if (url === "/__stage") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<!doctype html><body style="margin:0;background:${PAPER}"><div id="stage"></div></body>`);
  }
  const f = path.join(STATIC, url);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
  res.end(fs.readFileSync(f));
}).listen(PORT);

// Optional id filter, so backfilling one newly seated face never churns the
// PNGs already shipped.
const argv = process.argv.slice(2);
const missingOnly = argv.includes("--missing");
const only = argv.filter((a) => a !== "--missing");
const agents = JSON.parse(fs.readFileSync(path.join(WEB, "data", "arena.json"), "utf8"))
  .agents.filter((a) => (!only.length || only.includes(a.id))
    && (!missingOnly || !fs.existsSync(path.join(OUT, `${a.id}.png`))));

// Nothing to draw: say so and don't pay for a browser. The deploy runs this on
// every publish, and on all but a handful of them every face already exists.
if (!agents.length) {
  console.log(only.length && !missingOnly
    ? `no such trader on the record: ${only.join(", ")}`
    : "every trader already has a face — nothing to render");
  server.close();
  process.exit(only.length && !missingOnly ? 1 : 0);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 400, deviceScaleFactor: SCALE });
await page.goto(`http://127.0.0.1:${PORT}/__stage`, { waitUntil: "domcontentloaded" });

let made = 0;
for (const a of agents) {
  if (!a.avatar) { console.log(`  skip ${a.id} — no avatar on the record`); continue; }
  await page.evaluate(async (params, id, px, paper, port) => {
    const OO = await import(`http://127.0.0.1:${port}/avatar.js`);
    OO.injectAvatarCSS(document);
    const el = document.getElementById("stage");
    el.setAttribute("style", `width:${px}px;height:${px}px;background:${paper};display:block;`);
    // static, no mood: a letter is a document, and the face must not imply a
    // P&L the letter's own numbers do not state
    el.innerHTML = OO.avatar({ ...params, name: id }, px, {});
  }, a.avatar, a.id, DISPLAY, PAPER, PORT);
  const el = await page.$("#stage");
  await el.screenshot({ path: path.join(OUT, `${a.id}.png`), omitBackground: false });
  made++;
  console.log(`  ${a.id}.png  ${a.avatar.base}/${a.avatar.costume}`);
}

await browser.close();
server.close();
const sizes = fs.readdirSync(OUT).map((f) => fs.statSync(path.join(OUT, f)).size);
console.log(`\n${made} avatars → web/static/avatars/  (largest ${Math.max(...sizes)} bytes)`);
