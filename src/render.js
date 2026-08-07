// reads window.rough; the vendored UMD predates the module split
import { state } from "./app.js";

const NS = "http://www.w3.org/2000/svg";
const HIT_W = 10; // world units, before the inverse-scale correction

const svg = document.getElementById("canvas");
const scene = document.getElementById("scene");
const previewLayer = document.getElementById("preview");
const marqueeLayer = document.getElementById("marquee");
const chromeLayer = document.getElementById("chrome");

let rc = null;
function roughSvg() {
  if (!rc) rc = window.rough.svg(svg);
  return rc;
}

// id -> { node, version }; change test is an integer compare, never a deep compare
const nodes = new Map();

export function nodeFor(eid) {
  const rec = nodes.get(eid);
  return rec ? rec.node : null;
}

function applyViewBox(r) {
  const { tx, ty, scale } = state.view;
  svg.setAttribute("viewBox", `${tx} ${ty} ${r.width / scale} ${r.height / scale}`);
  // hit margin and preview stroke stay visually constant across zoom; one root write beats touching every hit path
  svg.style.setProperty("--hit-w", String(HIT_W / scale));
  svg.style.setProperty("--px", String(1 / scale));
}

// anything that moves or resizes the SVG refreshes this; a stale rect silently offsets every pointer coord
// size change must reach the viewBox in the same frame, or clicks land on the wrong element until the ResizeObserver fires
export function refreshRect() {
  const prev = state.view.rect;
  const r = svg.getBoundingClientRect();
  state.view.rect = r;
  if (!prev || prev.width !== r.width || prev.height !== r.height) applyViewBox(r);
}

export function updateViewBox() {
  applyViewBox(state.view.rect || svg.getBoundingClientRect());
}

export function initRenderer() {
  refreshRect();
  updateViewBox();
  new ResizeObserver(() => {
    refreshRect();
    updateViewBox();
  }).observe(svg.parentElement);
  window.addEventListener("resize", refreshRect);
  window.addEventListener("scroll", refreshRect, true);
}

// arrows anchor at x,y with points as offsets, so the bbox can start left of/above the anchor
export function bboxOf(el) {
  if (el.type === "arrow" && el.points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [dx, dy] of el.points) {
      if (dx < minX) minX = dx;
      if (dx > maxX) maxX = dx;
      if (dy < minY) minY = dy;
      if (dy > maxY) maxY = dy;
    }
    return { x: el.x + minX, y: el.y + minY, w: maxX - minX, h: maxY - minY };
  }
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

function diamondPoints(x, y, w, h) {
  return [
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
  ];
}

function arrowEnds(el) {
  const p = el.points || [[0, 0], [0, 0]];
  const a = p[0];
  const b = p[p.length - 1];
  return { x1: el.x + a[0], y1: el.y + a[1], x2: el.x + b[0], y2: el.y + b[1] };
}

function headPoints(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const size = Math.min(22, len * 0.4);
  const a = Math.atan2(dy, dx);
  const spread = Math.PI / 7;
  return [
    [x2 - size * Math.cos(a - spread), y2 - size * Math.sin(a - spread)],
    [x2, y2],
    [x2 - size * Math.cos(a + spread), y2 - size * Math.sin(a + spread)],
  ];
}

function roughOpts(el) {
  const o = {
    seed: el.seed,
    stroke: el.stroke,
    strokeWidth: 1.6,
    roughness: 1.15,
    bowing: 1,
  };
  if (el.fill) {
    o.fill = el.fill;
    o.fillStyle = "solid";
  }
  return o;
}

function roughArt(el) {
  const rs = roughSvg();
  const o = roughOpts(el);
  const w = Math.max(1, el.w || 0);
  const h = Math.max(1, el.h || 0);
  switch (el.type) {
    case "rect":
      return rs.rectangle(el.x, el.y, w, h, o);
    case "ellipse":
      return rs.ellipse(el.x + w / 2, el.y + h / 2, w, h, o);
    case "diamond":
      return rs.polygon(diamondPoints(el.x, el.y, w, h), o);
    case "arrow": {
      const { x1, y1, x2, y2 } = arrowEnds(el);
      const g = document.createElementNS(NS, "g");
      g.appendChild(rs.line(x1, y1, x2, y2, o));
      g.appendChild(rs.polygon(headPoints(x1, y1, x2, y2), o));
      return g;
    }
    default:
      return null; // text is phase 6, images phase 7
  }
}

// everything the wobble depends on; same key means byte-identical paths, so a version bump with matching key is a style patch, not a rebuild
// fill presence is in the key because it adds/removes a path; fill colour is not
function geomKey(el) {
  return [
    el.type, el.x, el.y, el.w, el.h, el.seed,
    el.points ? JSON.stringify(el.points) : "",
    el.fill ? "f" : "n",
  ].join("|");
}

// restyle without touching geometry, the whole point of tagging data-role at creation
export function applyStyle(node, el) {
  const o = el.opacity == null ? 1 : el.opacity;
  if (o === 1) node.removeAttribute("opacity");
  else node.setAttribute("opacity", String(o));
  for (const p of node.querySelectorAll('path[data-role="stroke"]')) p.setAttribute("stroke", el.stroke);
  for (const p of node.querySelectorAll('path[data-role="fill"]')) p.setAttribute("fill", el.fill || "none");
}

// rough emits one <g> of <path> children; tag by role at creation so a color/opacity edit is a setAttribute, not a rebuild
// fillPath is the one rough marks stroke="none"
function buildNode(el) {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("data-id", el.id);

  const art = roughArt(el);
  if (!art) return g;

  const hits = [];
  for (const p of art.querySelectorAll("path")) {
    const isFill = p.getAttribute("stroke") === "none";
    p.setAttribute("data-role", isFill ? "fill" : "stroke");
    p.setAttribute("pointer-events", "none");
    const hit = document.createElementNS(NS, "path");
    hit.setAttribute("d", p.getAttribute("d"));
    hit.setAttribute("class", isFill ? "hit-fill" : "hit");
    hits.push(hit);
  }

  g.appendChild(art);
  for (const h of hits) g.appendChild(h);
  applyStyle(g, el);
  return g;
}

export function renderElements() {
  const els = state.elements;

  // Prune first so childNodes[i] lines up with the array index below.
  const live = new Set();
  for (const el of els) live.add(el.id);
  for (const [eid, rec] of nodes) {
    if (!live.has(eid)) {
      rec.node.remove();
      nodes.delete(eid);
    }
  }

  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    let rec = nodes.get(el.id);
    const key = geomKey(el);
    if (!rec) {
      rec = { node: buildNode(el), version: el.version, key };
      nodes.set(el.id, rec);
    } else if (rec.version !== el.version) {
      if (rec.key === key) {
        applyStyle(rec.node, el);
        rec.version = el.version;
      } else {
        rec.node.remove();
        rec = { node: buildNode(el), version: el.version, key };
        nodes.set(el.id, rec);
      }
    }
    // document order tracks array order (z-order); usually a pointer compare that passes
    if (scene.childNodes[i] !== rec.node) {
      scene.insertBefore(rec.node, scene.childNodes[i] || null);
    }
  }
}

export function resetRenderer() {
  nodes.clear();
  scene.textContent = "";
  previewClear();
  marqueeClear();
  layoutChrome(null);
}

// nodes are built once and repositioned, so a resize drag is 20 attribute writes, not 9 element creations

const GRIPS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
let selBox = null;
let gripNodes = null;

function ensureChrome() {
  if (selBox) return;
  selBox = document.createElementNS(NS, "rect");
  selBox.setAttribute("class", "sel-box");
  chromeLayer.appendChild(selBox);
  gripNodes = {};
  for (const name of GRIPS) {
    const n = document.createElementNS(NS, "rect");
    n.setAttribute("class", "grip");
    n.setAttribute("data-grip", name);
    chromeLayer.appendChild(n);
    gripNodes[name] = n;
  }
}

export function unionBBox(ids) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let n = 0;
  for (const el of state.elements) {
    if (ids && !ids.has(el.id)) continue;
    const b = bboxOf(el);
    n++;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return n ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

function gripPoints(b) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const r = b.x + b.w;
  const bt = b.y + b.h;
  return {
    nw: [b.x, b.y], n: [cx, b.y], ne: [r, b.y], e: [r, cy],
    se: [r, bt], s: [cx, bt], sw: [b.x, bt], w: [b.x, cy],
  };
}

// pass null to hide; grips and padding are in screen px so they stay constant across zoom
export function layoutChrome(b) {
  if (!b) {
    chromeLayer.style.display = "none";
    return;
  }
  ensureChrome();
  chromeLayer.style.display = "";
  chromeLayer.removeAttribute("transform");

  const s = state.view.scale;
  const pad = 4 / s;
  const box = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  selBox.setAttribute("x", box.x);
  selBox.setAttribute("y", box.y);
  selBox.setAttribute("width", box.w);
  selBox.setAttribute("height", box.h);

  const g = 8 / s;
  const pts = gripPoints(box);
  for (const name of GRIPS) {
    const [gx, gy] = pts[name];
    const n = gripNodes[name];
    n.setAttribute("x", gx - g / 2);
    n.setAttribute("y", gy - g / 2);
    n.setAttribute("width", g);
    n.setAttribute("height", g);
  }
}

export function renderChrome() {
  layoutChrome(state.selection.size ? unionBBox(state.selection) : null);
}

// a move drag rides the chrome along on the same transform the elements use
export function setChromeTransform(t) {
  if (t) chromeLayer.setAttribute("transform", t);
  else chromeLayer.removeAttribute("transform");
}

let marqueeNode = null;

export function marqueeShow(a, b) {
  if (!marqueeNode) {
    marqueeNode = document.createElementNS(NS, "rect");
    marqueeNode.setAttribute("class", "marquee");
    marqueeLayer.appendChild(marqueeNode);
  }
  marqueeNode.setAttribute("x", Math.min(a.x, b.x));
  marqueeNode.setAttribute("y", Math.min(a.y, b.y));
  marqueeNode.setAttribute("width", Math.abs(b.x - a.x));
  marqueeNode.setAttribute("height", Math.abs(b.y - a.y));
}

export function marqueeClear() {
  if (!marqueeNode) return;
  marqueeNode.remove();
  marqueeNode = null;
}

// plain primitives at 1px while sizing; rough regenerates the wobble from the seed on every call
// a per-frame rebuild makes the shape crawl and costs a path reparse each frame

const previewPool = [];

function makePlain(type) {
  const tag =
    type === "rect" ? "rect" :
    type === "ellipse" ? "ellipse" :
    type === "diamond" ? "polygon" : "line";
  const n = document.createElementNS(NS, tag);
  n.setAttribute("class", "preview-shape");
  return n;
}

function applyPlain(n, el) {
  n.setAttribute("stroke", el.stroke);
  const w = Math.max(0, el.w || 0);
  const h = Math.max(0, el.h || 0);
  switch (el.type) {
    case "rect":
      n.setAttribute("x", el.x);
      n.setAttribute("y", el.y);
      n.setAttribute("width", w);
      n.setAttribute("height", h);
      break;
    case "ellipse":
      n.setAttribute("cx", el.x + w / 2);
      n.setAttribute("cy", el.y + h / 2);
      n.setAttribute("rx", w / 2);
      n.setAttribute("ry", h / 2);
      break;
    case "diamond":
      n.setAttribute("points", diamondPoints(el.x, el.y, w, h).map((p) => p.join(",")).join(" "));
      break;
    case "arrow": {
      const { x1, y1, x2, y2 } = arrowEnds(el);
      n.setAttribute("x1", x1);
      n.setAttribute("y1", y1);
      n.setAttribute("x2", x2);
      n.setAttribute("y2", y2);
      break;
    }
  }
}

// nodes are pooled and replaced only when the slot's type changes, so a 10-element resize reuses all 10
export function previewSet(list) {
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    let rec = previewPool[i];
    if (!rec || rec.type !== el.type) {
      const node = makePlain(el.type);
      if (rec) rec.node.replaceWith(node);
      else previewLayer.appendChild(node);
      rec = { node, type: el.type };
      previewPool[i] = rec;
    }
    applyPlain(rec.node, el);
  }
  while (previewPool.length > list.length) previewPool.pop().node.remove();
}

export function previewClear() {
  while (previewPool.length) previewPool.pop().node.remove();
}
