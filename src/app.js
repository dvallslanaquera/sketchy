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
import { thumbUrl, queueThumb, dropThumb, primeThumbs, setThumbListener } from "./thumbs.js";
import { snapshot, pushSnapshot, undo, redo, canUndo, canRedo, resetHistory } from "./history.js";
import {
  copySelection, cutSelection, onPaste, duplicateSelection,
  deleteSelection, selectAll, bringToFront, sendToBack,
} from "./edit.js";
import { exportCanvas } from "./export.js";

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
  // survives a canvas switch on purpose, so copy on one drawing and paste on another works
  clipboard: [],
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

// digits pick from the toolbar row, so 1 is Select and 6 is Text
function pickTool(index) {
  const t = TOOLS[index];
  if (!t) return;
  // space is down, and its release would restore the old tool and swallow this choice
  if (heldTool) heldTool = t[0];
  else setTool(t[0]);
}

// a text edit cancels here too once phase 6 lands
function cancelCurrent() {
  if (state.drag) {
    abortDrag();
    return;
  }
  if (!state.selection.size) return;
  state.selection.clear();
  selectionChanged();
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
    if (e.key === "Escape") {
      cancelCurrent();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault(); // backspace still means "go back" in a few configurations
      deleteSelection();
      return;
    }
    // e.code, not e.key: shift+1 is '!' on a US layout and something else everywhere it is not
    if (e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      zoomToFit();
      return;
    }
    if (!e.shiftKey && !e.altKey && /^Digit[1-6]$/.test(e.code)) {
      e.preventDefault();
      pickTool(Number(e.code.slice(5)) - 1);
    }
    return;
  }

  // e.key for ctrl+shift+] is '}' on a US layout and absent on plenty of others
  if (e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
    e.preventDefault();
    if (e.code === "BracketRight") bringToFront();
    else sendToBack();
    return;
  }

  const k = e.key.toLowerCase();
  // the four edit commands want ctrl on its own, so Ctrl+Shift+C still opens the inspector
  const plain = !e.shiftKey;

  if (k === "z" && plain) {
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
  } else if (k === "e" && e.shiftKey) {
    e.preventDefault();
    exportCanvas().catch((err) => console.error("sketchy: export failed", err));
  } else if (k === "c" && plain) {
    copySelection(); // no preventDefault: nothing is selectable on the page to copy anyway
  } else if (k === "x" && plain) {
    cutSelection();
  } else if (k === "a" && plain) {
    e.preventDefault(); // ctrl+A would select the whole document
    selectAll();
  } else if (k === "d" && plain) {
    e.preventDefault(); // ctrl+D is bookmark-this-page
    duplicateSelection();
  }
  // Ctrl+V has no binding here. The paste event carries the clipboard synchronously and
  // navigator.clipboard.read() would prompt, so the listener below owns it.
});

window.addEventListener("paste", (e) => {
  if (isTyping()) return;
  onPaste(e);
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
  // re-checked at write time, not just at schedule time. An idle write can sit in the queue while
  // a canvas switch flushes fresh data synchronously, and this older doc would land on top of it.
  // The same check keeps a pending write from resurrecting a canvas that was deleted meanwhile.
  const write = () => {
    if (state.activeId !== cid) return;
    putCanvas(doc).catch((e) => console.error("sketchy: save failed", e));
  };
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
  const outgoing = state.activeId;
  flushSave({ immediate: true });
  state.activeId = cid;
  // after activeId moves, or queueThumb would refuse it as the active canvas
  queueThumb(outgoing);
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
  syncActiveItem();
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
  renderSidebar(); // switchCanvas only moves the active class, and this row is new
}

// id of the canvas whose name is currently an <input>, or null
let renaming = null;

function buildItem(c) {
  const li = document.createElement("li");
  li.className = "canvas-item" + (c.id === state.activeId ? " is-active" : "");
  li.dataset.cid = c.id;

  const img = document.createElement("img");
  img.className = "canvas-thumb";
  img.alt = "";
  img.draggable = false;
  const url = thumbUrl(c.id);
  if (url) img.src = url;
  li.appendChild(img);

  const name = document.createElement("span");
  name.className = "canvas-name";
  name.textContent = c.name;
  name.title = c.name + " (double-click to rename)";
  li.appendChild(name);

  const del = document.createElement("button");
  del.className = "canvas-del";
  del.type = "button";
  del.title = "Delete canvas";
  del.textContent = "x";
  del.addEventListener("click", (e) => {
    e.stopPropagation(); // the row click switches canvases
    deleteCanvasItem(c.id);
  });
  li.appendChild(del);

  li.addEventListener("click", () => {
    if (renaming) return;
    switchCanvas(c.id);
  });
  name.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startRename(li, c);
  });
  return li;
}

// full rebuild, so only for membership changes: boot, new, delete, rename
function renderSidebar() {
  canvasList.innerHTML = "";
  for (const c of state.canvases) canvasList.appendChild(buildItem(c));
}

// a switch changes which row is lit and nothing else. Rebuilding here would tear out a rename
// input, because double-clicking a row fires its click and switches canvases first.
function syncActiveItem() {
  for (const li of canvasList.children) {
    li.classList.toggle("is-active", li.dataset.cid === state.activeId);
  }
}

// targeted, because a full rebuild while a rename input is open would throw the input away
function paintThumb(cid, dataUrl) {
  const img = canvasList.querySelector(`[data-cid="${cid}"] .canvas-thumb`);
  if (img) img.src = dataUrl;
}

function startRename(li, c) {
  if (renaming) return;
  const name = li.querySelector(".canvas-name");
  const input = document.createElement("input");
  input.className = "canvas-rename";
  input.type = "text";
  input.value = c.name;
  renaming = c.id;

  let settled = false;
  const finish = async (keep) => {
    if (settled) return;
    settled = true;
    renaming = null;
    const next = input.value.trim();
    input.replaceWith(name);
    if (!keep || !next || next === c.name) return;
    await renameCanvas(c.id, next);
  };

  input.addEventListener("keydown", (e) => {
    // the global handler is gated on isTyping(), so only the two commit keys need handling here
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());

  name.replaceWith(input);
  input.focus();
  input.select();
}

async function renameCanvas(cid, name) {
  const meta = state.canvases.find((x) => x.id === cid);
  if (meta) meta.name = name;
  const doc = await getCanvas(cid);
  if (doc) {
    doc.name = name;
    doc.updatedAt = Date.now();
    await putCanvas(doc);
  }
  renderSidebar();
}

// soft delete: hide it now, hard-delete on the next boot. A session-long grace period costs
// nothing and buys us no confirm dialog on the hot path.
async function deleteCanvasItem(cid) {
  const wasActive = cid === state.activeId;
  // clear the active id before the first await. A debounced save landing mid-delete would write
  // a record with no deletedAt and resurrect the canvas.
  if (wasActive) state.activeId = null;
  state.canvases = state.canvases.filter((x) => x.id !== cid);
  dropThumb(cid);
  renderSidebar();

  const doc = await getCanvas(cid);
  if (doc) {
    doc.deletedAt = Date.now();
    await putCanvas(doc);
  }
  if (!wasActive) return;

  // the active one just went away, so land somewhere real
  if (state.canvases.length) await switchCanvas(state.canvases[0].id);
  else await newCanvas();
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
  syncHistoryButtons();

  setThumbListener(paintThumb);
  renderSidebar();
  // stored tiles paint as they load, then the queue fills in whatever is missing or stale
  await primeThumbs(state.canvases.map((c) => c.id));
  for (const c of state.canvases) queueThumb(c.id);

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