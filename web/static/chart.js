// The arena's line chart: one instrument, two surfaces. The floor plots several
// traders against their benchmarks; the desk plots one trader against its own.
// Inlined into the floor's classic script by render.py (the avatar.js pattern),
// imported as a module by /desk.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const pct = (v, dp = 1) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(dp) + "%";

/** last index of pts with t <= t0, or -1 */
export function atOrBefore(pts, t0){ let lo=0,hi=pts.length-1,r=-1; while(lo<=hi){ const m=(lo+hi)>>1; if(pts[m].t<=t0){ r=m; lo=m+1; } else hi=m-1; } return r; }
export function niceStep(span){ const raw=(span/4)||1, p=Math.pow(10,Math.floor(Math.log10(raw))); for (const m of [1,2,5]) if (m*p>=raw) return m*p; return 10*p; }

/* seriesList: [{name, color, points:[{t,date,v}], dashed, fill}] — plotted on a
   real time axis, so traders born mid-record start mid-chart, not at the left edge. */
export function lineChart(container, seriesList, opts={}){
  const series = seriesList.map(s=>({...s, pts:s.points.map((p,i)=>({t:p.t!=null?p.t:i, date:p.date, v:p.v}))})).filter(s=>s.pts.length);
  if (!series.length || Math.max(...series.map(s=>s.pts.length)) < 2){
    container.innerHTML = `<div class="emptychart">One data point so far. The curve draws itself as trading accumulates.</div>`;
    return;
  }
  const g = Object.assign({W:760,H:300,mL:46,mR:90,mT:14,mB:26}, opts.size||{});
  const {W,H,mL,mR,mT,mB} = g, iw=W-mL-mR, ih=H-mT-mB;
  const tMin=Math.min(...series.map(s=>s.pts[0].t)), tMax=Math.max(...series.map(s=>s.pts[s.pts.length-1].t));
  const span=(tMax-tMin)||1;
  const x = t => mL + (t-tMin)/span*iw;
  const all = series.flatMap(s=>s.pts.map(p=>p.v));
  let lo=Math.min(...all), hi=Math.max(...all); const pad=(hi-lo)*0.08||0.5; lo-=pad; hi+=pad;
  const y = v => mT + (1-(v-lo)/(hi-lo))*ih;
  const step=niceStep(hi-lo), dp=step>=1?0:(step>=0.1?1:2);
  let grid="",ylabels="";
  for (let k=Math.ceil(lo/step); k*step<=hi; k++){ const g=k*step, gy=y(g).toFixed(1);
    grid += `<line x1="${mL}" y1="${gy}" x2="${W-mR}" y2="${gy}" stroke="var(--grid)" stroke-width="1"/>`;
    ylabels += `<text x="${mL-8}" y="${gy}" dy="4" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--mono)">${(g-100>=-1e-9?"+":"−")+Math.abs(g-100).toFixed(dp)+"%"}</text>`; }
  /* merged timeline for the crosshair + x labels */
  const dateByT=new Map();
  series.forEach(s=>s.pts.forEach(p=>{ if(!dateByT.has(p.t)) dateByT.set(p.t,p.date); }));
  const merged=[...dateByT.keys()].sort((a,b)=>a-b);
  const dayLabel = d => (span>3*86400 && d) ? d.split(" ").slice(0,2).join(" ") : (d||"");
  let xlabels=""; const used=[];
  [0,0.35,0.7,1].forEach(f=>{
    const target=tMin+span*f; let bi=0,bd=Infinity;
    merged.forEach((t,i)=>{ const d=Math.abs(t-target); if(d<bd){bd=d;bi=i;} });
    const t=merged[bi], lab=dayLabel(dateByT.get(t));
    if (!lab || used.some(u=>u.lab===lab || Math.abs(u.x-x(t))<70)) return;
    used.push({lab,x:x(t)});
    xlabels += `<text x="${x(t).toFixed(1)}" y="${H-8}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(lab)}</text>`;
  });
  let paths="",endDots="",endLabels=""; const labelYs=[];
  series.forEach(s=>{
    const lastP=s.pts[s.pts.length-1];
    if (s.pts.length===1){ paths += `<circle cx="${x(lastP.t).toFixed(1)}" cy="${y(lastP.v).toFixed(1)}" r="3" fill="${s.color}"/>`; }
    else {
      const d = s.pts.map((p,i)=>(i?"L":"M")+x(p.t).toFixed(1)+" "+y(p.v).toFixed(1)).join(" ");
      if (s.fill) paths += `<path d="${d} L ${x(lastP.t).toFixed(1)} ${(mT+ih).toFixed(1)} L ${x(s.pts[0].t).toFixed(1)} ${(mT+ih).toFixed(1)} Z" fill="${s.color}" opacity="0.07"/>`;
      paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.dashed?'stroke-dasharray="5 4"':""}/>`;
    }
    endDots += `<circle cx="${x(lastP.t).toFixed(1)}" cy="${y(lastP.v).toFixed(1)}" r="3.5" fill="${s.color}"/>`;
    // a narrow column has no room to name the lines beside them; the caller
    // labels them underneath instead (opts.endLabels: false)
    if (opts.endLabels === false) return;
    let ly=y(lastP.v); while(labelYs.some(p=>Math.abs(p-ly)<14)) ly+=14; labelYs.push(ly);
    endLabels += `<g><rect x="${W-mR+8}" y="${(ly-5).toFixed(1)}" width="10" height="3" rx="1.5" fill="${s.color}"/><text x="${W-mR+22}" y="${ly.toFixed(1)}" dy="1" font-size="11.5" fill="var(--ink2)">${esc(s.short||s.name)}</text></g>`;
  });
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria||"equity chart")}">${grid}<line x1="${mL}" y1="${(mT+ih).toFixed(1)}" x2="${W-mR}" y2="${(mT+ih).toFixed(1)}" stroke="var(--axis)" stroke-width="1"/>${ylabels}${xlabels}${paths}${endDots}${endLabels}<line class="xhair" x1="0" y1="${mT}" x2="0" y2="${mT+ih}" stroke="var(--axis)" stroke-width="1" opacity="0"/></svg>`;
  const tooltip = opts.tooltip;
  if (!tooltip) return;   // a chart with nowhere to put a readout has no crosshair
  const svg=container.querySelector("svg"), xhair=svg.querySelector(".xhair");
  const hide = ()=>{ xhair.setAttribute("opacity","0"); tooltip.style.display="none"; };
  /* One reader for both hands. A finger covers whatever it points at, so on
     touch the readout parks above the chart instead of under the fingertip. */
  const read = (clientX, clientY, touch)=>{
    const r=svg.getBoundingClientRect(); const px=(clientX-r.left)/r.width*W;
    if (px<mL||px>W-mR){ hide(); return; }
    const target=tMin+(px-mL)/iw*span; let bi=0,bd=Infinity;
    merged.forEach((t,i)=>{ const d=Math.abs(t-target); if(d<bd){bd=d;bi=i;} });
    const mt=merged[bi], cx=x(mt);
    xhair.setAttribute("x1",cx); xhair.setAttribute("x2",cx); xhair.setAttribute("opacity","1");
    tooltip.style.display="block";
    tooltip.innerHTML = `<div class="tdate">${esc(dateByT.get(mt)||"")}</div>` + series.map(s=>{
      const i=atOrBefore(s.pts,mt), v=i>=0?s.pts[i].v:null;
      return `<div class="trow"><span class="l"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span><span class="v">${v!=null?pct(v/100-1):"—"}</span></div>`; }).join("");
    const tw=tooltip.offsetWidth, th=tooltip.offsetHeight;
    if (touch){
      let tx=clientX-tw/2; tx=Math.max(8,Math.min(tx,window.innerWidth-tw-8));
      let ty=r.top-th-12; if (ty<8) ty=Math.min(r.bottom+12,window.innerHeight-th-8);
      tooltip.style.left=tx+"px"; tooltip.style.top=ty+"px";
    } else {
      let tx=clientX+14; if (tx+tw>window.innerWidth-8) tx=clientX-tw-14;
      tooltip.style.left=tx+"px"; tooltip.style.top=Math.max(8,clientY-10)+"px";
    }
  };
  /* Pointer events, not mouse+touch: a touch is followed by a synthesised
     mousemove, which would re-open the readout the instant the finger lifts
     and leave it stranded on screen. pointerType tells them apart, and a
     touch-drag keeps sending pointermove to this element on its own. */
  const onPoint = ev=>read(ev.clientX, ev.clientY, ev.pointerType !== "mouse");
  svg.addEventListener("pointerdown", onPoint);
  svg.addEventListener("pointermove", onPoint);
  svg.addEventListener("pointerup", ev=>{ if (ev.pointerType !== "mouse") hide(); });
  svg.addEventListener("pointerleave", ev=>{ if (ev.pointerType === "mouse") hide(); });
  svg.addEventListener("pointercancel", hide);   // the page started scrolling
}

