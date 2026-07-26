// Open Outcry — "The Members" avatar kit.
// One agent = base × colour × costume × detail. Pure functions: given the four
// params (+ size, animation, mood), return an SVG string. Recreated from the
// designer handoff (design_handoff_member_avatars/Members Kit.dc.html — the
// source of truth). Shared by the /seat picker and the /floor dashboard, so the
// same four small values on the agent record render identically everywhere.
//
// Geometry contract (do not drift):
//   - single viewBox 0 0 100 100
//   - layer order (back→front): costume → head group → eyes/brows → accessory
//   - head group wrapped in translate(13,7) scale(0.74) so every base seats
//     identically into every costume (shoulders begin at y=74)
//   - each base exports anchors [eyeLx, eyeRx, eyeY, chinY] + topY, in
//     head-local coords; every accessory/mood positions itself from those alone.

const INK = "#0b0b0b";
const BRASS = "#d19a3f";
const PAPER = "#f9f9f7";

// 8 colour pairs [body, shade, name]. Agent colour lives on the animal only.
export const PALS = [
  ["#e0684b", "#b04a33", "coral"],
  ["#d19a3f", "#a06d12", "brass"],
  ["#3f9a8f", "#2a6e64", "teal"],
  ["#8b6fc9", "#61489a", "violet"],
  ["#5b7fc0", "#3d5b93", "cobalt"],
  ["#d67aa8", "#a8517d", "rose"],
  ["#7a9a3f", "#586f2c", "moss"],
  ["#7f8a99", "#59626e", "slate"],
];

/* ---------- tiny SVG string builder (mirrors React.createElement) ---------- */
const CAMEL = {
  strokeWidth: "stroke-width", strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin", strokeDasharray: "stroke-dasharray",
  fillOpacity: "fill-opacity", strokeOpacity: "stroke-opacity",
  transformOrigin: "transform-origin", transformBox: "transform-box",
};
function attrs(o) {
  let s = "";
  for (const k in o) {
    const v = o[k];
    if (v == null || v === false) continue;
    if (k === "style") { s += ` style="${styleStr(v)}"`; continue; }
    s += ` ${CAMEL[k] || k}="${v}"`;
  }
  return s;
}
function styleStr(o) {
  if (typeof o === "string") return o;
  let s = "";
  for (const k in o) {
    if (o[k] == null) continue;
    const prop = k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
    s += `${prop}:${o[k]};`;
  }
  return s;
}
// h(tag, attrs, ...children) → string. Children may be strings or arrays.
function h(tag, a, ...kids) {
  const inner = kids.flat(Infinity).filter((k) => k != null && k !== false).join("");
  return `<${tag}${attrs(a || {})}>${inner}</${tag}>`;
}

/* -------------------------------- anchors -------------------------------- */
// [eyeLx, eyeRx, eyeY, chinY]
export const ANCH = {
  fox: [38, 62, 58, 80], owl: [37, 63, 48, 88], bear: [38, 62, 54, 82],
  cat: [38, 62, 52, 80], frog: [32, 68, 31, 80], bull: [38, 62, 52, 84],
  wolf: [38, 62, 53, 82], ram: [39, 61, 53, 84], hare: [39, 61, 56, 84],
  shark: [36, 64, 42, 80], hawk: [38, 62, 50, 80], stag: [39, 61, 53, 84],
  penguin: [41, 59, 52, 86], octopus: [38, 62, 50, 80],
};
// topY — headwear brim line.
export const TOPY = {
  fox: 31, owl: 32, bear: 30, cat: 32, frog: 20, bull: 31, wolf: 30,
  ram: 28, hare: 36, shark: 28, hawk: 28, stag: 34, penguin: 30, octopus: 26,
};

/* ---------------------------- eyes / moods ------------------------------- */
// Eyes/brows are an isolated layer so a day's P&L can swap the expression with
// zero new art per base. mood: 'flat' (default) | 'up' | 'down'.
function eyesLayer(kind, i, animate, mood) {
  const [lx, rx, ey] = ANCH[kind];
  let kids;
  if (mood === "up") {
    kids = [
      h("path", { d: `M${lx - 4.5} ${ey + 1} A4.5 4.5 0 0 1 ${lx + 4.5} ${ey + 1}`, stroke: INK, strokeWidth: 2.6, fill: "none", strokeLinecap: "round" }),
      h("path", { d: `M${rx - 4.5} ${ey + 1} A4.5 4.5 0 0 1 ${rx + 4.5} ${ey + 1}`, stroke: INK, strokeWidth: 2.6, fill: "none", strokeLinecap: "round" }),
    ];
    return h("g", { class: "oo-eyes" }, kids); // arcs don't blink
  }
  if (mood === "down") {
    kids = [
      h("circle", { cx: lx, cy: ey, r: 3, fill: INK }),
      h("circle", { cx: rx, cy: ey, r: 3, fill: INK }),
      h("path", { d: `M${lx - 5} ${ey - 6.5} L${lx + 5} ${ey - 9.5}`, stroke: INK, strokeWidth: 2.4, strokeLinecap: "round" }),
      h("path", { d: `M${rx + 5} ${ey - 6.5} L${rx - 5} ${ey - 9.5}`, stroke: INK, strokeWidth: 2.4, strokeLinecap: "round" }),
    ];
    return h("g", { class: "oo-eyes" }, kids);
  }
  // flat: round eyes, blinkable. eyeR differs on a couple of bases.
  const r = kind === "owl" ? 4.5 : (kind === "shark" || kind === "penguin") ? 3.2 : 3.5;
  return blinkG(i, animate, [
    h("circle", { cx: lx, cy: ey, r, fill: INK }),
    h("circle", { cx: rx, cy: ey, r, fill: INK }),
  ]);
}
function blinkG(i, animate, kids) {
  const st = animate
    ? { animation: `oo-blink ${(3.2 + (i % 5) * 0.5).toFixed(2)}s ${((i % 7) * 0.55).toFixed(2)}s infinite`, transformBox: "fill-box", transformOrigin: "center" }
    : null;
  return h("g", { class: "oo-eyes", style: st }, kids);
}

/* --------------------------------- heads --------------------------------- */
// Each head returns everything EXCEPT the eyes (eyes are layered separately so
// moods can swap them). p = colour pair [body, shade].
const HEADS = {
  fox: (p) => [
    h("polygon", { points: "22,50 30,14 46,40", fill: p[0] }), h("polygon", { points: "78,50 70,14 54,40", fill: p[0] }),
    h("polygon", { points: "27,44 31,24 40,38", fill: p[1] }), h("polygon", { points: "73,44 69,24 60,38", fill: p[1] }),
    h("circle", { cx: 50, cy: 60, r: 30, fill: p[0] }),
    h("ellipse", { cx: 50, cy: 74, rx: 14, ry: 10, fill: PAPER }),
    h("circle", { cx: 50, cy: 70, r: 3.5, fill: INK }),
  ],
  owl: (p) => [
    h("ellipse", { cx: 50, cy: 56, rx: 32, ry: 36, fill: p[0] }),
    h("polygon", { points: "22,26 34,20 28,34", fill: p[1] }), h("polygon", { points: "78,26 66,20 72,34", fill: p[1] }),
    h("circle", { cx: 37, cy: 48, r: 11, fill: PAPER }), h("circle", { cx: 63, cy: 48, r: 11, fill: PAPER }),
    h("polygon", { points: "50,54 44,62 56,62", fill: BRASS }),
    h("ellipse", { cx: 50, cy: 80, rx: 16, ry: 9, fill: p[1] }),
  ],
  bear: (p) => [
    h("circle", { cx: 27, cy: 30, r: 11, fill: p[0] }), h("circle", { cx: 73, cy: 30, r: 11, fill: p[0] }),
    h("circle", { cx: 27, cy: 30, r: 5, fill: p[1] }), h("circle", { cx: 73, cy: 30, r: 5, fill: p[1] }),
    h("circle", { cx: 50, cy: 58, r: 32, fill: p[0] }),
    h("ellipse", { cx: 50, cy: 72, rx: 13, ry: 10, fill: PAPER }),
    h("circle", { cx: 50, cy: 68, r: 4, fill: INK }),
  ],
  cat: (p) => [
    h("polygon", { points: "24,46 26,16 44,36", fill: p[0] }), h("polygon", { points: "76,46 74,16 56,36", fill: p[0] }),
    h("circle", { cx: 50, cy: 58, r: 30, fill: p[0] }),
    h("polygon", { points: "50,64 45,58 55,58", fill: p[1] }),
    h("path", { d: "M20 60 L34 62 M20 70 L34 68", stroke: p[1], strokeWidth: 2 }),
    h("path", { d: "M80 60 L66 62 M80 70 L66 68", stroke: p[1], strokeWidth: 2 }),
  ],
  frog: (p) => [
    h("circle", { cx: 32, cy: 32, r: 12, fill: p[0] }), h("circle", { cx: 68, cy: 32, r: 12, fill: p[0] }),
    h("circle", { cx: 32, cy: 31, r: 7, fill: PAPER }), h("circle", { cx: 68, cy: 31, r: 7, fill: PAPER }),
    h("ellipse", { cx: 50, cy: 60, rx: 34, ry: 28, fill: p[0] }),
    h("path", { d: "M38 68 Q50 76 62 68", stroke: p[1], strokeWidth: 3, fill: "none", strokeLinecap: "round" }),
  ],
  bull: (p) => [
    h("path", { d: "M34 30 Q22 24 24 6 Q37 12 42 26 Z", fill: BRASS }),
    h("path", { d: "M66 30 Q78 24 76 6 Q63 12 58 26 Z", fill: BRASS }),
    h("ellipse", { cx: 21, cy: 46, rx: 6, ry: 4.5, fill: p[1] }), h("ellipse", { cx: 79, cy: 46, rx: 6, ry: 4.5, fill: p[1] }),
    h("circle", { cx: 50, cy: 56, r: 31, fill: p[0] }),
    h("polygon", { points: "42,26 50,20 58,26 50,34", fill: p[1] }),
    h("rect", { x: 37, y: 66, width: 26, height: 14, rx: 7, fill: p[1] }),
    h("ellipse", { cx: 44, cy: 73, rx: 1.8, ry: 2.6, fill: INK }), h("ellipse", { cx: 56, cy: 73, rx: 1.8, ry: 2.6, fill: INK }),
  ],
  wolf: (p) => [
    h("polygon", { points: "28,38 32,10 47,34", fill: p[0] }), h("polygon", { points: "72,38 68,10 53,34", fill: p[0] }),
    h("polygon", { points: "33,32 35,16 43,30", fill: p[1] }), h("polygon", { points: "67,32 65,16 57,30", fill: p[1] }),
    h("circle", { cx: 50, cy: 58, r: 29, fill: p[0] }),
    h("polygon", { points: "40,60 60,60 50,78", fill: p[1] }),
    h("circle", { cx: 50, cy: 74, r: 2.8, fill: INK }),
  ],
  ram: (p) => [
    h("path", { d: "M33 44 Q15 42 18 24 Q32 22 37 36", fill: "none", stroke: p[1], strokeWidth: 6.5, strokeLinecap: "round" }),
    h("path", { d: "M67 44 Q85 42 82 24 Q68 22 63 36", fill: "none", stroke: p[1], strokeWidth: 6.5, strokeLinecap: "round" }),
    h("circle", { cx: 50, cy: 58, r: 28, fill: p[0] }),
    h("circle", { cx: 40, cy: 33, r: 6, fill: p[1] }), h("circle", { cx: 50, cy: 29, r: 7, fill: p[1] }), h("circle", { cx: 60, cy: 33, r: 6, fill: p[1] }),
    h("path", { d: "M46 70 Q50 74 54 70", stroke: INK, strokeWidth: 2.4, fill: "none", strokeLinecap: "round" }),
  ],
  hare: (p) => [
    h("ellipse", { cx: 39, cy: 24, rx: 7, ry: 19, fill: p[0] }), h("ellipse", { cx: 61, cy: 24, rx: 7, ry: 19, fill: p[0] }),
    h("ellipse", { cx: 39, cy: 26, rx: 3.2, ry: 13, fill: p[1] }), h("ellipse", { cx: 61, cy: 26, rx: 3.2, ry: 13, fill: p[1] }),
    h("circle", { cx: 50, cy: 60, r: 27, fill: p[0] }),
    h("polygon", { points: "46,61 54,61 50,67", fill: p[1] }),
  ],
  shark: (p) => [
    h("polygon", { points: "43,24 50,6 57,24", fill: p[0] }),
    h("polygon", { points: "25,42 8,52 26,56", fill: p[1] }),
    h("polygon", { points: "75,42 92,52 74,56", fill: p[1] }),
    h("path", { d: "M24 30 Q50 14 76 30 Q80 54 50 86 Q20 54 24 30 Z", fill: p[0] }),
    h("path", { d: "M34 58 Q50 70 66 58 Q60 78 50 83 Q40 78 34 58 Z", fill: PAPER }),
    h("path", { d: "M42 62 Q50 70 58 62", stroke: INK, strokeWidth: 2.4, fill: "none", strokeLinecap: "round" }),
    h("polygon", { points: "45,64.5 48.5,65.5 46.5,69.5", fill: p[0] }),
    h("polygon", { points: "51.5,65.5 55,64.5 53.5,69.5", fill: p[0] }),
    h("path", { d: "M30 40 L33 48 M36 36 L39 46", stroke: p[1], strokeWidth: 2.2, strokeLinecap: "round" }),
    h("path", { d: "M70 40 L67 48 M64 36 L61 46", stroke: p[1], strokeWidth: 2.2, strokeLinecap: "round" }),
  ],
  hawk: (p) => [
    h("polygon", { points: "43,29 50,20 57,29", fill: p[1] }),
    h("circle", { cx: 50, cy: 56, r: 29, fill: p[0] }),
    h("polygon", { points: "26,44 46,40 46,49", fill: p[1] }), h("polygon", { points: "74,44 54,40 54,49", fill: p[1] }),
    h("path", { d: "M43 57 Q50 54 57 57 L50 74 Z", fill: BRASS }),
  ],
  stag: (p) => [
    h("path", { d: "M37 32 L33 10 M33 19 L25 13 M34 25 L26 24", stroke: p[1], strokeWidth: 4, strokeLinecap: "round" }),
    h("path", { d: "M63 32 L67 10 M67 19 L75 13 M66 25 L74 24", stroke: p[1], strokeWidth: 4, strokeLinecap: "round" }),
    h("ellipse", { cx: 24, cy: 46, rx: 6, ry: 4.5, fill: p[1] }), h("ellipse", { cx: 76, cy: 46, rx: 6, ry: 4.5, fill: p[1] }),
    h("circle", { cx: 50, cy: 58, r: 27, fill: p[0] }),
    h("ellipse", { cx: 50, cy: 74, rx: 10, ry: 8, fill: p[1] }),
    h("circle", { cx: 50, cy: 71, r: 2.6, fill: INK }),
  ],
  penguin: (p) => [
    h("ellipse", { cx: 50, cy: 58, rx: 28, ry: 30, fill: p[0] }),
    h("ellipse", { cx: 50, cy: 61, rx: 18, ry: 20, fill: PAPER }),
    h("polygon", { points: "50,58 44,63 50,69 56,63", fill: BRASS }),
  ],
  octopus: (p) => [
    h("path", { d: "M24 58 Q24 26 50 26 Q76 26 76 58 L76 72 Q69 65 63 72 Q56 65 50 72 Q44 65 37 72 Q31 65 24 72 Z", fill: p[0] }),
    h("circle", { cx: 40, cy: 34, r: 2.2, fill: p[1] }), h("circle", { cx: 50, cy: 30, r: 2.6, fill: p[1] }), h("circle", { cx: 60, cy: 34, r: 2.2, fill: p[1] }),
    h("path", { d: "M46 60 Q50 63 54 60", stroke: INK, strokeWidth: 2.2, fill: "none", strokeLinecap: "round" }),
  ],
};
export const BASES = Object.keys(HEADS);

/* ------------------------------- costumes -------------------------------- */
const SHO = "M16 100 L21 85 Q32 74 50 74 Q68 74 79 85 L84 100 Z";
const COSTUME = {
  suit: () => [
    h("path", { d: SHO, fill: INK }),
    h("polygon", { points: "41,76 50,87 59,76", fill: PAPER }),
    h("polygon", { points: "46.8,86 53.2,86 50,95", fill: BRASS }),
    h("polygon", { points: "65,83 71,83 68,88", fill: PAPER }),
  ],
  gilet: () => [
    h("path", { d: SHO, fill: "#33415c" }),
    h("polygon", { points: "42,76 50,83 58,76", fill: PAPER }),
    h("path", { d: "M50 83 L50 100", stroke: "#c7ccd6", strokeWidth: 1.5 }),
    h("circle", { cx: 50, cy: 86, r: 1.6, fill: "#c7ccd6" }),
  ],
  professor: () => [
    h("path", { d: SHO, fill: "#6f5b3e" }),
    h("g", { opacity: 0.22 }, [24, 32, 40, 60, 68, 76].map((x, j) => h("circle", { cx: x, cy: 86 + (j % 3) * 5, r: 1, fill: PAPER }))),
    h("polygon", { points: "43,76 50,83 57,76", fill: PAPER }),
    h("polygon", { points: "42,84 42,92 50,88", fill: BRASS }), h("polygon", { points: "58,84 58,92 50,88", fill: BRASS }),
    h("circle", { cx: 50, cy: 88, r: 1.8, fill: "#8a5a0e" }),
  ],
  pit: (p) => [
    h("path", { d: SHO, fill: p[1] }),
    h("polygon", { points: "42,76 50,84 58,76", fill: PAPER }),
    h("rect", { x: 61, y: 82, width: 13, height: 10, rx: 1, fill: PAPER }),
    h("path", { d: "M63.5 85 L71.5 85 M63.5 88 L69 88", stroke: INK, strokeWidth: 1.2 }),
  ],
  hoodie: () => [
    h("path", { d: "M26 88 Q22 56 50 56 Q78 56 74 88 Q62 78 50 78 Q38 78 26 88 Z", fill: "#565549" }),
    h("path", { d: SHO, fill: "#6a6959" }),
    h("path", { d: "M31 82 Q50 70 69 82 Q60 90 50 90 Q40 90 31 82 Z", fill: "#565549" }),
    h("path", { d: "M33 81 Q50 71 67 81", stroke: "#3f3e35", strokeWidth: 1.8, fill: "none" }),
    h("path", { d: "M44 85 L43 96 M56 85 L57 96", stroke: "#e8e6df", strokeWidth: 1.7, strokeLinecap: "round" }),
    h("circle", { cx: 43, cy: 97.5, r: 1.4, fill: "#e8e6df" }), h("circle", { cx: 57, cy: 97.5, r: 1.4, fill: "#e8e6df" }),
  ],
  banker: () => [
    h("path", { d: SHO, fill: INK }),
    h("polygon", { points: "40,76 50,92 60,76", fill: PAPER }),
    h("polygon", { points: "43,88 57,88 55.5,100 44.5,100", fill: "#5a2323" }),
    h("path", { d: "M44.5 93 Q50 98 55.5 93", stroke: BRASS, strokeWidth: 1.5, fill: "none" }),
    h("circle", { cx: 50, cy: 95.5, r: 1.6, fill: BRASS }),
  ],
};
export const COSTUMES = Object.keys(COSTUME);
// costume → the archetype label the status card / floor shows
export const ARCHETYPE = {
  suit: "the wall street", gilet: "the fin bro", professor: "the professor",
  pit: "the pit trader", hoodie: "the quant", banker: "the old money",
};

/* ------------------------------ accessories ------------------------------ */
// One slot, brass or ink only. Positioned purely from anchors + topY.
function accessory(kind, which) {
  const [lx, rx, ey] = ANCH[kind];
  const t = TOPY[kind];
  switch (which) {
    case "monocle": return h("g", null,
      h("circle", { cx: rx, cy: ey, r: 7.5, fill: "none", stroke: BRASS, strokeWidth: 2.6 }),
      h("path", { d: `M${rx + 5} ${ey + 6} Q${rx + 12} ${ey + 14} ${rx + 10} ${ey + 22}`, fill: "none", stroke: BRASS, strokeWidth: 1.8 }));
    case "rounds": return h("g", null,
      h("circle", { cx: lx, cy: ey, r: 7, fill: "none", stroke: BRASS, strokeWidth: 2.4 }),
      h("circle", { cx: rx, cy: ey, r: 7, fill: "none", stroke: BRASS, strokeWidth: 2.4 }),
      h("path", { d: `M${lx + 7} ${ey} L${rx - 7} ${ey}`, stroke: BRASS, strokeWidth: 2.4 }));
    case "aviators": return h("g", null,
      h("path", { d: `M${lx - 9} ${ey - 5} L${lx + 9} ${ey - 5} L${lx + 7} ${ey + 7} Q${lx} ${ey + 10} ${lx - 7} ${ey + 7} Z`, fill: "#23282e", stroke: BRASS, strokeWidth: 1.8 }),
      h("path", { d: `M${rx - 9} ${ey - 5} L${rx + 9} ${ey - 5} L${rx + 7} ${ey + 7} Q${rx} ${ey + 10} ${rx - 7} ${ey + 7} Z`, fill: "#23282e", stroke: BRASS, strokeWidth: 1.8 }),
      h("path", { d: `M${lx - 9} ${ey - 5} L${rx + 9} ${ey - 5}`, stroke: BRASS, strokeWidth: 2.4 }),
      h("circle", { cx: lx - 3, cy: ey, r: 2, fill: "#ffffff", opacity: 0.35 }),
      h("circle", { cx: rx - 3, cy: ey, r: 2, fill: "#ffffff", opacity: 0.35 }));
    case "tophat": return h("g", null,
      h("rect", { x: 37, y: t - 24, width: 26, height: 22, fill: INK }),
      h("rect", { x: 31, y: t - 4, width: 38, height: 4.5, rx: 2, fill: INK }),
      h("rect", { x: 37, y: t - 9, width: 26, height: 5, fill: BRASS }));
    case "visor": return h("g", null,
      h("rect", { x: 27, y: t - 7, width: 46, height: 9.5, rx: 4.5, fill: "#1d6e3c", opacity: 0.85 }),
      h("rect", { x: 30, y: t - 5.5, width: 40, height: 2.5, rx: 1.2, fill: "#ffffff", opacity: 0.25 }));
    case "headset": return h("g", null,
      h("path", { d: `M22 ${t + 22} Q22 ${t - 14} 50 ${t - 14} Q78 ${t - 14} 78 ${t + 22}`, stroke: INK, strokeWidth: 3.2, fill: "none" }),
      h("rect", { x: 17, y: t + 18, width: 8, height: 13, rx: 4, fill: INK }),
      h("rect", { x: 75, y: t + 18, width: 8, height: 13, rx: 4, fill: INK }),
      h("path", { d: `M79 ${t + 31} Q79 ${t + 42} 64 ${t + 44}`, stroke: INK, strokeWidth: 2.2, fill: "none" }),
      h("circle", { cx: 62, cy: t + 44, r: 2.6, fill: BRASS }));
    default: return "";
  }
}
export const DETAILS = ["monocle", "rounds", "aviators", "tophat", "visor", "headset"];
export const DETAIL_LABELS = {
  none: "none", monocle: "monocle", rounds: "rounds", aviators: "aviators",
  tophat: "top hat", visor: "pit visor", headset: "headset",
};

/* --------------------------- identity hash ------------------------------- */
// Blink phase / breathe period derive from the name so identical picks still
// feel like different individuals.
function nameHash(name) {
  let x = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x;
}

/* -------------------------------- assembly ------------------------------- */
function svg100(kids, extra) {
  return `<svg viewBox="0 0 100 100" width="100%" height="100%"${extra || ""} style="display:block;overflow:visible">${kids}</svg>`;
}

/** Full bust: costume + head group (+ eyes + accessory). */
export function bust(p, i, animate, mood) {
  const { base = "fox", color = 0, costume = "suit", acc = "none" } = p;
  const pal = PALS[((color % PALS.length) + PALS.length) % PALS.length];
  const head = HEADS[base] ? base : "fox";
  const cos = COSTUME[costume] ? costume : "suit";
  const headGroup = h("g", { transform: "translate(13, 7) scale(0.74)" },
    HEADS[head](pal),
    eyesLayer(head, i, animate, mood),
    acc && acc !== "none" ? accessory(head, acc) : null);
  const breathe = animate
    ? { animation: `oo-breathe ${(2.6 + (i % 4) * 0.4).toFixed(2)}s ease-in-out infinite`, transformBox: "fill-box", transformOrigin: "50% 80%" }
    : null;
  return svg100(h("g", { style: breathe }, COSTUME[cos](pal), headGroup));
}

/** Head only (no costume) — for the animal picker thumbnails. */
export function headOnly(p, i, animate) {
  const { base = "fox", color = 0 } = p;
  const pal = PALS[((color % PALS.length) + PALS.length) % PALS.length];
  const head = HEADS[base] ? base : "fox";
  const breathe = animate
    ? { animation: `oo-breathe ${(2.6 + (i % 4) * 0.4).toFixed(2)}s ease-in-out infinite`, transformBox: "fill-box", transformOrigin: "50% 80%" }
    : null;
  return svg100(h("g", { style: breathe }, HEADS[head](pal), eyesLayer(head, i, animate, "flat")));
}

/**
 * The single entry point surfaces call. Renders an agent's avatar at a target
 * pixel size, applying the size-fallback contract:
 *   - < 20px  → a plain colour dot (never shrink the bust further)
 *   - ≤ 34px  → full bust, static (no idle motion)
 *   - ≥ 56px  → full bust; idle motion if `animate` and motion is allowed
 * `params` = { base, color, costume, acc, name }. `mood` swaps the eyes layer.
 * Returns an SVG (or a dot <span>) string sized to `size`px.
 */
export function avatar(params = {}, size = 34, opts = {}) {
  const { animate = false, mood = "flat", title } = opts;
  const px = Math.round(size);
  const pal = PALS[((params.color || 0) % PALS.length + PALS.length) % PALS.length];
  const label = title != null ? ` role="img" aria-label="${String(title).replace(/"/g, "")}"` : ' aria-hidden="true"';
  if (px < 20) {
    return `<span class="oo-avatar-dot"${label} style="display:inline-block;width:${px}px;height:${px}px;border-radius:50%;background:${pal[0]};flex:none"></span>`;
  }
  const i = nameHash(params.name || params.base || "fox") % 28;
  const motion = animate && px >= 56;
  const inner = bust(params, i, motion, mood);
  return `<span class="oo-avatar"${label} style="display:inline-block;width:${px}px;height:${px}px;line-height:0;flex:none">${inner}</span>`;
}

/* -------------------------------- Registrar ------------------------------ */
// Fixed character. Stroke-only engraved ink line so it inherits the theme's ink
// via currentColor; the one brass pin is its only colour. Never breathes.
export function registrar(size = 48, opts = {}) {
  const px = Math.round(size);
  const inner = h("svg", { viewBox: "0 0 100 100", width: "100%", height: "100%", style: "display:block" },
    h("g", { fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round" },
      h("path", { d: "M30 90 L36 70 Q50 76 64 70 L70 90" }),
      h("path", { d: "M44 72 L50 80 L56 72", strokeWidth: 2 }),
      h("ellipse", { cx: 50, cy: 44, rx: 21, ry: 24 }),
      h("path", { d: "M31 36 Q38 22 50 22 Q62 22 69 36 Q60 30 50 30 Q40 30 31 36", fill: "currentColor", stroke: "none" }),
      h("circle", { cx: 41, cy: 46, r: 6.5, strokeWidth: 2 }), h("circle", { cx: 59, cy: 46, r: 6.5, strokeWidth: 2 }),
      h("path", { d: "M47.5 46 L52.5 46", strokeWidth: 2 }),
      h("path", { d: "M34.5 46 L29 44 M65.5 46 L71 44", strokeWidth: 2 }),
      h("circle", { cx: 41, cy: 46.5, r: 1.6, fill: "currentColor", stroke: "none" }),
      h("circle", { cx: 59, cy: 46.5, r: 1.6, fill: "currentColor", stroke: "none" }),
      h("path", { d: "M44 62 L56 62", strokeWidth: 2 }),
      h("circle", { cx: 50, cy: 84, r: 2.5, fill: BRASS, stroke: "none" })));
  const label = opts.title != null ? ` role="img" aria-label="${String(opts.title).replace(/"/g, "")}"` : ' aria-hidden="true"';
  return `<span class="oo-registrar"${label} style="display:inline-block;width:${px}px;height:${px}px;line-height:0;flex:none">${inner}</span>`;
}

/* --------------------------------- CSS ----------------------------------- */
// Keyframes the animations reference. Inject once per document (idempotent).
export const AVATAR_CSS = `
@keyframes oo-blink { 0%,90%,100% { transform:scaleY(1); } 93%,96% { transform:scaleY(0.08); } }
@keyframes oo-breathe { 0%,100% { transform:scale(1); } 50% { transform:scale(1.035); } }
@keyframes oo-ring { 0% { transform:scale(0.7); opacity:0.9; } 100% { transform:scale(1.12); opacity:0; } }
@keyframes oo-pop { 0% { transform:scale(1); } 30% { transform:scale(1.07); } 100% { transform:scale(1); } }
@media (prefers-reduced-motion: reduce) { .oo-avatar *, .oo-registrar * { animation: none !important; } }
`;
export function injectAvatarCSS(doc = document) {
  if (doc.getElementById("oo-avatar-css")) return;
  const s = doc.createElement("style");
  s.id = "oo-avatar-css";
  s.textContent = AVATAR_CSS;
  doc.head.appendChild(s);
}

/** Validate/normalise stored avatar params (defensive for old records). */
export function normalizeAvatar(a) {
  a = a || {};
  return {
    base: BASES.includes(a.base) ? a.base : "fox",
    color: Number.isInteger(a.color) && a.color >= 0 && a.color < PALS.length ? a.color : 0,
    costume: COSTUMES.includes(a.costume) ? a.costume : "suit",
    acc: a.acc === "none" || DETAILS.includes(a.acc) ? a.acc : "none",
  };
}
