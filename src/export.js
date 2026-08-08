// Ctrl+Shift+E writes both files: an SVG of the scene and a 2x PNG of the same SVG.
// Geometry comes from buildNode, the same call the on-screen renderer uses, so an export cannot
// drift from what is on the canvas. Hit paths are left out, because .hit lives in styles.css and
// neither a standalone file nor an <img> loads it, so they would paint as solid black.
import { state } from "./app.js";
import { buildNode, unionBBoxOf } from "./render.js";
import { BG, inlineBlobs, serializeSvg, svgDataUrl } from "./thumbs.js";

const NS = "http://www.w3.org/2000/svg";
const PAD = 24; // world units around the union bbox
const PIXEL_RATIO = 2;

function fileBase() {
  const meta = state.canvases.find((c) => c.id === state.activeId);
  const raw = meta && meta.name ? meta.name : "sketchy";
  // a canvas can be named anything, and a slash or a colon breaks the download on Windows
  const clean = raw.replace(/[^\w\- ]+/g, "").trim().slice(0, 60);
  return clean || "sketchy";
}

function buildScene() {
  const els = state.elements;
  const b = unionBBoxOf(els);
  const w = Math.max(1, b.w + PAD * 2);
  const h = Math.max(1, b.h + PAD * 2);
  const x = b.x - PAD;
  const y = b.y - PAD;

  const svg = document.createElementNS(NS, "svg");
  // width and height matter: Firefox renders a root without them at zero size inside an <img>
  svg.setAttribute("width", String(Math.round(w)));
  svg.setAttribute("height", String(Math.round(h)));
  svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);

  const back = document.createElementNS(NS, "rect");
  back.setAttribute("x", String(x));
  back.setAttribute("y", String(y));
  back.setAttribute("width", String(w));
  back.setAttribute("height", String(h));
  back.setAttribute("fill", BG[state.bg] || BG.black);
  svg.appendChild(back);

  for (const el of els) svg.appendChild(buildNode(el, false));
  return { svg, w, h };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("export: the svg would not load into an image"));
    img.src = src;
  });
}

// no external references in the markup, so the canvas stays untainted and toBlob works
async function toPng(dataUrl, w, h) {
  const img = await loadImage(dataUrl);
  const pw = Math.max(1, Math.round(w * PIXEL_RATIO));
  const ph = Math.max(1, Math.round(h * PIXEL_RATIO));
  if (typeof OffscreenCanvas === "function") {
    const c = new OffscreenCanvas(pw, ph);
    c.getContext("2d").drawImage(img, 0, 0, pw, ph);
    return c.convertToBlob({ type: "image/png" });
  }
  const c = document.createElement("canvas");
  c.width = pw;
  c.height = ph;
  c.getContext("2d").drawImage(img, 0, 0, pw, ph);
  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // the download reads the URL after click() returns, so revoking on the next line cancels it
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function exportCanvas() {
  if (!state.elements.length) return;
  const { svg, w, h } = buildScene();
  await inlineBlobs(svg, state.elements);

  const base = fileBase();
  download(new Blob([serializeSvg(svg)], { type: "image/svg+xml" }), base + ".svg");

  const png = await toPng(svgDataUrl(svg), w, h);
  if (png) download(png, base + ".png");
}
