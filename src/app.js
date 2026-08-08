import {
  openDB,
  getAllCanvases,
  getCanvas,
  putCanvas,
  setMeta,
  getMeta,
  purgeDeleted,
  id,
} from "./db.js";
import {
  initRenderer, renderElements, resetRenderer, renderChrome,
  applyStyle, nodeFor, refreshRect, updateViewBox,
} from "./render.js";
import { initTools, setTool, abortDrag } from "./tools.js";
import { zoomToFit, resetZoom, syncZoomLabel } from "./view.js";
import { snapshot, pushSnapshot, undo, redo, canUndo, canRedo, resetHistory } from "./history.js";

// history lives in history.js so a snapshot can't capture the stack
export const state = {
  canvases: [], // metadata only: { id, name, createdAt, updatedAt }
  activeId: null,
  elements: [], // z-order is array order, index 0 is furthest back
  selection: new Set(),
  view: { tx: 0, ty: 0, scale: 1, rect: null },
  bg: "black",
  tool: "select",
  drag: null,
};

const canvasEl = document.getElementById("canvas");
const bgBlack = document.getElementById("bg-black");
const bgCharcoal = document.getElementById("bg-charcoal");
const canvasList = document.getElementById("canvas-list");
const newBtn = document.getElementById("new-canvas");
const toolsEl = document.getElementById("tools");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const panel = document.getElementById("panel");
const strokeInput = document.getElementById("prop-stroke");
const fillInput = document.getElementById("prop-fill");
const noFillInput = document.getElementById("prop-nofill");
const opacityInput = document.getElementById("prop-opacity");
const opacityVal = document.getElementById("prop-opacity-val");
const panelCount = document.getElementById("panel-count");
const zoomBtn = document.getElementById("zoom-level");

function applyBg(tone) {
  state.bg = tone;
  canvasEl.setAttribute("data-bg", tone);
  bgBlack.classList.toggle("is-active", tone === "black");
  bgCharcoal.classList.toggle("is-active", tone === "charcoal");
}

export function setBg(tone) {
  if (tone !== "black" && tone !== "charcoal") return;
  if (state.bg === tone) return;
  applyBg(tone);
  scheduleSave();
}

bgBlack.addEventListener("click", () => setBg("black"));
bgCharcoal.addEventListener("click", () => setBg("charcoal"));
newBtn.addEventListener("click", newCanvas);
zoomBtn.addEventListener("click", resetZoom);

// pan has no toolbar button. It is space-held, and the previous tool comes back on release.

const TOOLS = [
  ["select", "Select"],
  ["rect", "Rect"],
  ["ellipse", "Ellipse"],
  ["diamond", "Diamond"],
  ["arrow", "Arrow"],
  ["text", "Text"],
];

function buildToolbar() {
  for (const [tool, label] of TOOLS) {
    const b = document.createElement("button");
    b.className = "tool-btn";
    b.dataset.tool = tool;
    b.textContent = label;
    b.title = label;
    b.addEventListener("click", () => setTool(tool));
    toolsEl.appendChild(b);
  }
}

// callers snapshot before mutating; the pushed state is the pre-action one
export function commit(pre) {
  if (pre) pushSnapshot(pre);
  renderElements();
  renderChrome();
  syncPanel();
  scheduleSave();
  syncHistoryButtons();
}

export function bump(el) {
  el.version = (el.version | 0) + 1;
}

export function elementById(eid) {
  return state.elements.find((el) => el.id === eid);
}

export function selectionChanged() {
  renderChrome();
  syncPanel();
}

function syncHistoryButtons() {
  undoBtn.disabled = !canUndo();
  redoBtn.disabled = !canRedo();
}

function applyHistory(next) {
  if (!next) return;
  state.elements = next;
  // the snapshot may predate the current selection
  const live = new Set(next.map((el) => el.id));
  for (const sid of state.selection) if (!live.has(sid)) state.selection.delete(sid);
  renderElements();
  renderChrome();
  syncPanel();
  scheduleSave();
  syncHistoryButtons();
}

export function doUndo() {
  abortDrag();
  applyHistory(undo(state.elements));
}

export function doRedo() {
  abortDrag();
  applyHistory(redo(state.elements));
}

undoBtn.addEventListener("click", doUndo);
redoBtn.addEventListener("click", doRedo);

// every control writes the whole selection, so a bulk edit is one history entry

function selected() {
  const out = [];
  for (const sid of state.selection) {
    const el = elementById(sid);
    if (el) out.push(el);
  }
  return out;
}

function syncPanel() {
  const els = selected();
  // panel show/hide resizes the canvas; refresh the rect now, not next frame
  const wasHidden = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", els.length === 0);
  if (wasHidden !== (els.length === 0)) refreshRect();
  if (els.length === 0) return;

  const first = els[0];
  strokeInput.value = first.stroke;
  if (first.fill) fillInput.value = first.fill;
  noFillInput.checked = !first.fill;
  fillInput.disabled = !first.fill;
  const o = first.opacity == null ? 1 : first.opacity;
  opacityInput.value = String(o);
  opacityVal.textContent = Math.round(o * 100) + "%";
  panelCount.textContent = els.length === 1 ? "1 selected" : `${els.length} selected`;
}

// snapshot once per gesture; a slider drag fires ~40 input events and would empty the 10-slot history
let gesture = null;

function beginGesture() {
  if (!gesture) gesture = snapshot(state.elements);
}

function endGesture() {
  if (!gesture) return;
  for (const el of selected()) bump(el);
  commit(gesture);
  gesture = null;
}

// live preview: write the DOM directly, leave version alone so nothing re-renders until commit
function liveStyle(apply) {
  beginGesture();
  for (const el of selected()) {
    apply(el);
    const node = nodeFor(el.id);
    if (node) applyStyle(node, el);
  }
}

strokeInput.addEventListener("input", () => {
  liveStyle((el) => { el.stroke = strokeInput.value; });
});
strokeInput.addEventListener("change", endGesture);

fillInput.addEventListener("input", () => {
  liveStyle((el) => { el.fill = fillInput.value; });
});
fillInput.addEventListener("change", endGesture);

opacityInput.addEventListener("input", () => {
  const v = Number(opacityInput.value);
  opacityVal.textContent = Math.round(v * 100) + "%";
  liveStyle((el) => { el.opacity = v; });
});
opacityInput.addEventListener("change", endGesture);

// toggling fill adds/removes a path, so this is a geometry rebuild, not a style patch
noFillInput.addEventListener("change", () => {
  const pre = snapshot(state.elements);
  const off = noFillInput.checked;
  for (const el of selected()) {
    el.fill = off ? null : fillInput.value;
    bump(el);
  }
  fillInput.disabled = off;
  commit(pre);
});

const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

// gate on inputs that consume the key; a range or checkbox would swallow Ctrl+Z otherwise
function isTyping() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === "TEXTAREA") return true;
  return a.tagName === "INPUT" && TEXT_INPUTS.has((a.type || "text").toLowerCase());
}

// the tool space interrupted, so release can put it back
let heldTool = null;

function endHandMode() {
  if (!heldTool) return;
  setTool(heldTool);
  heldTool = null;
}

window.addEventListener("keydown", (e) => {
  if (isTyping()) return;

  // e.repeat fires while the key is held and would overwrite heldTool with 'pan'
  if (e.code === "Space") {
    e.preventDefault(); // space scrolls the page and clicks a focused button
    if (e.repeat || state.drag || state.tool === "pan") return;
    heldTool = state.tool;
    setTool("pan");
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) {
    // e.code, not e.key: shift+1 is '!' on a US layout and something else everywhere it is not
    if (e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      zoomToFit();
    }
    return;
  }
  const k = e.key.toLowerCase();

  if (k === "z" && !e.shiftKey) {
    e.preventDefault();
    doUndo();
  } else if ((k === "z" && e.shiftKey) || k === "y") {
    e.preventDefault();
    doRedo();
  } else if (k === "r") {
    // third redo binding; one miss reloads the page, preventable in current Chrome/Firefox
    e.preventDefault();
    doRedo();
  } else if (k === "0") {
    e.preventDefault();
    resetZoom();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") endHandMode();
});

// microtask + 250ms debounce, IDB write in requestIdleCallback to stay off the pointer path
// flushSave captures the id at schedule time and drops the write if the canvas changed

let saveTimer = null;
let pendingId = null;
let microtaskScheduled = false;

export function scheduleSave() {
  if (!state.activeId) return;
  pendingId = state.activeId;
  if (microtaskScheduled) return;
  microtaskScheduled = true;
  queueMicrotask(() => {
    microtaskScheduled = false;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 250);
  });
}

function buildDoc(cid) {
  const meta = state.canvases.find((c) => c.id === cid);
  return {
    id: cid,
    name: meta ? meta.name : "Untitled",
    createdAt: meta ? meta.createdAt : Date.now(),
    updatedAt: Date.now(),
    elements: structuredClone(state.elements),
    view: { tx: state.view.tx, ty: state.view.ty, scale: state.view.scale },
    bg: state.bg,
  };
}

export function flushSave({ immediate = false } = {}) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const cid = pendingId;
  pendingId = null;
  if (!cid) return;
  // stale: scheduled for a canvas that is no longer active; switchCanvas already flushed it
  if (state.activeId !== cid) return;
  const doc = buildDoc(cid);
  const write = () =>
    putCanvas(doc).catch((e) => console.error("sketchy: save failed", e));
  if (immediate || typeof requestIdleCallback !== "function") write();
  else requestIdleCallback(write, { timeout: 1500 });
}

// a focus loss eats the keyup, which would otherwise leave the canvas stuck in hand mode
window.addEventListener("blur", () => {
  endHandMode();
  flushSave({ immediate: true });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave({ immediate: true });
});
window.addEventListener("pagehide", () => flushSave({ immediate: true }));

export async function switchCanvas(cid) {
  if (cid === state.activeId) return;
  // Flush the outgoing canvas while its elements are still in state.
  flushSave({ immediate: true });
  state.activeId = cid;
  const doc = await getCanvas(cid);
  state.elements = doc && doc.elements ? doc.elements : [];
  const v = (doc && doc.view) || {};
  state.view = {
    tx: v.tx || 0,
    ty: v.ty || 0,
    scale: v.scale || 1,
    rect: state.view.rect,
  };
  state.bg = doc && doc.bg ? doc.bg : "black";
  state.selection.clear();
  applyBg(state.bg);
  // tx/ty/scale came off the record, so the viewBox has to catch up before the first paint
  updateViewBox();
  syncZoomLabel();
  resetHistory();
  syncHistoryButtons();
  resetRenderer();
  renderElements();
  selectionChanged();
  await setMeta("activeCanvas", cid);
  renderSidebar();
}

export async function newCanvas() {
  flushSave({ immediate: true });
  const cid = id();
  const now = Date.now();
  const doc = {
    id: cid,
    name: "Untitled",
    createdAt: now,
    updatedAt: now,
    elements: [],
    view: { tx: 0, ty: 0, scale: 1 },
    bg: state.bg,
  };
  await putCanvas(doc);
  state.canvases.push({ id: cid, name: "Untitled", createdAt: now, updatedAt: now });
  await switchCanvas(cid);
}

function renderSidebar() {
  canvasList.innerHTML = "";
  for (const c of state.canvases) {
    const li = document.createElement("li");
    li.className = "canvas-item" + (c.id === state.activeId ? " is-active" : "");
    li.textContent = c.name;
    li.title = c.name;
    li.addEventListener("click", () => switchCanvas(c.id));
    canvasList.appendChild(li);
  }
}

async function boot() {
  await openDB();
  await purgeDeleted();

  let docs = (await getAllCanvases()).filter((c) => !c.deletedAt);
  if (docs.length === 0) {
    const cid = id();
    const now = Date.now();
    await putCanvas({
      id: cid,
      name: "Untitled",
      createdAt: now,
      updatedAt: now,
      elements: [],
      view: { tx: 0, ty: 0, scale: 1 },
      bg: "black",
    });
    docs = (await getAllCanvases()).filter((c) => !c.deletedAt);
  }

  state.canvases = docs.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));

  let activeId = await getMeta("activeCanvas");
  if (!activeId || !state.canvases.find((c) => c.id === activeId)) {
    activeId = state.canvases[0].id;
  }
  state.activeId = activeId;

  const active = await getCanvas(activeId);
  state.elements = active && active.elements ? active.elements : [];
  const v = (active && active.view) || {};
  state.view = { tx: v.tx || 0, ty: v.ty || 0, scale: v.scale || 1, rect: null };
  state.bg = active && active.bg ? active.bg : "black";
  applyBg(state.bg);

  if (!window.rough || !window.rough.svg) {
    console.error("sketchy: rough.js missing, shapes will not render");
    return;
  }

  buildToolbar();
  initRenderer();
  initTools();
  syncZoomLabel();
  renderElements();
  selectionChanged();

  newBtn.disabled = false;
  renderSidebar();
  syncHistoryButtons();

  // dev handle: no build step, so this is how the console and the phase 10 perf gate reach the scene
  window.sketchy = {
    state,
    render: renderElements,
    flush: () => flushSave({ immediate: true }),
    undo: doUndo,
    redo: doRedo,
    selectionChanged,
    zoomToFit,
    resetZoom,
    clearHistory: () => {
      resetHistory();
      syncHistoryButtons();
    },
  };

  console.log("sketchy: ready,", state.canvases.length, "canvas(es),", state.elements.length, "element(s)");
}

boot().catch((e) => console.error("sketchy: boot failed", e));