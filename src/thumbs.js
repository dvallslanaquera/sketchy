// Offscreen thumbnail rendering. Re-running a whole scene through rough.js is the most expensive
// thing the app does, so this never touches the canvas being drawn on and only runs on idle.
import { state } from "./app.js";
import { buildNode, unionBBoxOf } from "./render.js";
import { getCanvas, getThumb, putThumb, getBlob } from "./db.js";

const NS = "http://www.w3.org/2000/svg";
const W = 120;
const H = 80;
const PAD = 6; // world units at 1:1, so a shape's stroke does not touch the edge

// export.js shares BG, inlineBlobs and serializeSvg. An exported file faces the same constraints
// as a tile: no stylesheet, no blob: URLs, and the PNG path goes through an <img> as well.
export const BG = { black: "#000000", charcoal: "#232323" };

// canvasId -> dataUrl, so the sidebar can paint without a round trip per repaint
const cache = new Map();
const pending = new Set();

export function thumbUrl(cid) {
  return cache.get(cid) || null;
}

function idle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 200);
}

// uniform scale, and the viewBox aspect is forced to match the viewport, so nothing stretches.
// capped at 1: a lone small shape blown up to fill the tile renders its 1.6-unit stroke as a slab
function fitViewBox(b) {
  const s = Math.min(1, (W - PAD * 2) / Math.max(b.w, 1), (H - PAD * 2) / Math.max(b.h, 1));
  const vw = W / s;
  const vh = H / s;
  return { x: b.x + b.w / 2 - vw / 2, y: b.y + b.h / 2 - vh / 2, w: vw, h: vh };
}

function buildSvg(elements, bg) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));

  const b = elements.length ? unionBBoxOf(elements) : null;
  const vb = b ? fitViewBox(b) : { x: 0, y: 0, w: W, h: H };
  svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);

  // the tile carries its own background, so light strokes stay readable and the tone matches the canvas
  const back = document.createElementNS(NS, "rect");
  back.setAttribute("x", String(vb.x));
  back.setAttribute("y", String(vb.y));
  back.setAttribute("width", String(vb.w));
  back.setAttribute("height", String(vb.h));
  back.setAttribute("fill", BG[bg] || BG.black);
  svg.appendChild(back);

  for (const el of elements) svg.appendChild(buildNode(el, false));
  return svg;
}

function readAsDataUrl(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

// blob: URLs do not resolve inside an <img>-hosted SVG, which fetches nothing and runs no script.
// Image nodes carry data-blob-id for exactly this swap.
export async function inlineBlobs(svg, elements) {
  const ids = new Set();
  for (const el of elements) if (el.type === "image" && el.blobId) ids.add(el.blobId);
  if (!ids.size) return;
  for (const blobId of ids) {
    const targets = svg.querySelectorAll(`image[data-blob-id="${blobId}"]`);
    if (!targets.length) continue;
    const rec = await getBlob(blobId);
    if (!rec || !rec.blob) continue;
    const url = await readAsDataUrl(rec.blob);
    if (!url) continue;
    for (const n of targets) {
      n.setAttribute("href", url);
      n.removeAttribute("xlink:href"); // legacy attribute wins in some serializers
    }
  }
}

export function serializeSvg(svg) {
  let xml = new XMLSerializer().serializeToString(svg);
  // The serializer emits xmlns itself for a namespaced root, and setting the attribute by hand
  // risks a duplicate declaration, which is invalid XML and renders as nothing in an <img>.
  // Patch it only if it is actually missing.
  if (!xml.includes("xmlns=")) xml = xml.replace("<svg", `<svg xmlns="${NS}"`);
  return xml;
}

// encodeURIComponent rather than base64: the payload is text and may hold non-ascii, and btoa
// throws on anything above U+00FF
export function svgDataUrl(svg) {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(serializeSvg(svg));
}

export async function renderThumb(elements, bg) {
  const svg = buildSvg(elements, bg);
  await inlineBlobs(svg, elements);
  return svgDataUrl(svg);
}

let onReady = null;

export function setThumbListener(fn) {
  onReady = fn;
}

// boot paints from the stored tiles first, so the sidebar is not blank while the queue drains
export async function primeThumbs(ids) {
  for (const cid of ids) {
    const rec = await getThumb(cid);
    if (!rec || !rec.dataUrl) continue;
    cache.set(cid, rec.dataUrl);
    if (onReady) onReady(cid, rec.dataUrl);
  }
}

async function generate(cid) {
  pending.delete(cid);
  // the active canvas is the one being drawn on, and it is the whole reason this runs on idle
  if (cid === state.activeId) return;
  const doc = await getCanvas(cid);
  if (!doc || doc.deletedAt) return;

  const elements = doc.elements || [];
  const stored = await getThumb(cid);
  // elementCount alone misses a restyle, which changes no count; updatedAt moves on every save
  if (stored && stored.dataUrl &&
      stored.elementCount === elements.length &&
      stored.updatedAt === doc.updatedAt) {
    cache.set(cid, stored.dataUrl);
    if (onReady) onReady(cid, stored.dataUrl);
    return;
  }

  const dataUrl = await renderThumb(elements, doc.bg);
  cache.set(cid, dataUrl);
  await putThumb({
    id: cid,
    dataUrl,
    elementCount: elements.length,
    updatedAt: doc.updatedAt,
  });
  if (onReady) onReady(cid, dataUrl);
}

// callers queue on switch-away and at boot. The read here lands after the switch's synchronous
// flush, because IndexedDB runs overlapping transactions in creation order.
export function queueThumb(cid) {
  if (!cid || pending.has(cid) || cid === state.activeId) return;
  pending.add(cid);
  idle(() => {
    generate(cid).catch((e) => console.error("sketchy: thumbnail failed", cid, e));
  });
}

export function dropThumb(cid) {
  cache.delete(cid);
  pending.delete(cid);
}
