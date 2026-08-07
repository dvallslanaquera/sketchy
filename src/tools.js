// pan and text hook into this dispatch in later phases
import { state, commit, bump, elementById, selectionChanged } from "./app.js";
import {
  refreshRect, previewSet, previewClear, nodeFor, bboxOf,
  renderChrome, layoutChrome, setChromeTransform, unionBBox,
  marqueeShow, marqueeClear,
} from "./render.js";
import { snapshot } from "./history.js";
import { id } from "./db.js";

const svg = document.getElementById("canvas");

const SHAPE_TOOLS = new Set(["rect", "ellipse", "diamond", "arrow"]);
const DEFAULT_STROKE = "#e6e6e6";
// A drag shorter than this in world units is a stray click, not a shape.
const MIN_DRAG = 4;
const MIN_SIZE = 1;

export function setTool(tool) {
  state.tool = tool;
  svg.setAttribute("data-tool", tool);
  for (const b of document.querySelectorAll("#tools .tool-btn")) {
    b.classList.toggle("is-active", b.dataset.tool === tool);
  }
}

// cached rect, never getBoundingClientRect(); reading layout in a pointer handler forces a style/layout flush
export function screenToWorld(e) {
  const { rect, scale, tx, ty } = state.view;
  return {
    x: (e.clientX - rect.left) / scale + tx,
    y: (e.clientY - rect.top) / scale + ty,
  };
}

function newElement(type, at) {
  const el = {
    id: id(),
    type,
    version: 1,
    x: at.x,
    y: at.y,
    w: 0,
    h: 0,
    stroke: DEFAULT_STROKE,
    fill: null,
    opacity: 1,
    // Stable per element, so the wobble does not reshuffle across re-renders.
    seed: Math.floor(Math.random() * 2 ** 31),
  };
  if (type === "arrow") el.points = [[0, 0], [0, 0]];
  return el;
}

function sizeDraft(drag, at) {
  const el = drag.draft;
  const dx = at.x - drag.startWorld.x;
  const dy = at.y - drag.startWorld.y;
  if (el.type === "arrow") {
    // x,y stays the anchor. Only the offsets move.
    el.points = [[0, 0], [dx, dy]];
  } else {
    el.x = Math.min(drag.startWorld.x, at.x);
    el.y = Math.min(drag.startWorld.y, at.y);
  }
  el.w = Math.abs(dx);
  el.h = Math.abs(dy);
}

// The grip name says which edges move; the opposite edge is the anchor.
function resizeBox(grip, box, at) {
  let { x, y, w, h } = box;
  if (grip.includes("e")) w = Math.max(MIN_SIZE, at.x - box.x);
  if (grip.includes("w")) {
    const right = box.x + box.w;
    x = Math.min(at.x, right - MIN_SIZE);
    w = right - x;
  }
  if (grip.includes("s")) h = Math.max(MIN_SIZE, at.y - box.y);
  if (grip.includes("n")) {
    const bottom = box.y + box.h;
    y = Math.min(at.y, bottom - MIN_SIZE);
    h = bottom - y;
  }
  return { x, y, w, h };
}

function projectElement(el, box, nb) {
  const sx = box.w > 1e-6 ? nb.w / box.w : 1;
  const sy = box.h > 1e-6 ? nb.h / box.h : 1;
  const out = { ...el };
  out.x = nb.x + (el.x - box.x) * sx;
  out.y = nb.y + (el.y - box.y) * sy;
  if (el.type === "arrow" && el.points) {
    out.points = el.points.map(([dx, dy]) => [dx * sx, dy * sy]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [dx, dy] of out.points) {
      minX = Math.min(minX, dx); maxX = Math.max(maxX, dx);
      minY = Math.min(minY, dy); maxY = Math.max(maxY, dy);
    }
    out.w = maxX - minX;
    out.h = maxY - minY;
  } else if (el.type === "text") {
    // text keeps wrap width from w and size from vertical scale, so e/w re-wrap while n/s resize the type
    out.fontSize = Math.max(1, (el.fontSize || 14) * sy);
    out.w = Math.max(MIN_SIZE, el.w * sx);
    out.h = Math.max(MIN_SIZE, el.h * sy);
  } else {
    out.w = Math.max(MIN_SIZE, el.w * sx);
    out.h = Math.max(MIN_SIZE, el.h * sy);
  }
  return out;
}

function projectAll(drag, at) {
  const nb = resizeBox(drag.grip, drag.box, at);
  drag.projBox = nb;
  return drag.ids.map((eid) => projectElement(drag.start.get(eid), drag.box, nb));
}

function setHidden(ids, hidden) {
  for (const eid of ids) {
    const n = nodeFor(eid);
    if (n) n.style.display = hidden ? "none" : "";
  }
}

function clearTransforms(ids) {
  for (const eid of ids) {
    const n = nodeFor(eid);
    if (n) n.removeAttribute("transform");
  }
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function onDown(e) {
  if (e.button !== 0) return;
  refreshRect();
  const at = screenToWorld(e);

  if (SHAPE_TOOLS.has(state.tool)) {
    // without capture, a drag past the SVG edge drops the event stream and the shape freezes
    svg.setPointerCapture(e.pointerId);
    state.drag = {
      kind: "create",
      pointerId: e.pointerId,
      startWorld: at,
      draft: newElement(state.tool, at),
    };
    previewSet([state.drag.draft]);
    e.preventDefault();
    return;
  }

  if (state.tool !== "select") return;

  const grip = e.target.getAttribute && e.target.getAttribute("data-grip");
  if (grip && state.selection.size) {
    svg.setPointerCapture(e.pointerId);
    const ids = [...state.selection];
    const start = new Map();
    for (const eid of ids) start.set(eid, structuredClone(elementById(eid)));
    state.drag = {
      kind: "resize", pointerId: e.pointerId, grip, ids, start,
      box: unionBBox(state.selection),
      pre: snapshot(state.elements),
    };
    setHidden(ids, true);
    previewSet(projectAll(state.drag, at));
    e.preventDefault();
    return;
  }

  const hit = e.target.closest ? e.target.closest("g[data-id]") : null;
  if (hit) {
    const hid = hit.getAttribute("data-id");
    if (e.shiftKey) {
      if (state.selection.has(hid)) state.selection.delete(hid);
      else state.selection.add(hid);
      selectionChanged();
      return; // a shift-click toggles, it does not start a move
    }
    // Grabbing one member of a multi-selection drags the whole group.
    if (!state.selection.has(hid)) {
      state.selection.clear();
      state.selection.add(hid);
      selectionChanged();
    }
    svg.setPointerCapture(e.pointerId);
    state.drag = {
      kind: "move", pointerId: e.pointerId, startWorld: at,
      ids: [...state.selection], moved: false,
      pre: snapshot(state.elements),
    };
    e.preventDefault();
    return;
  }

  // Empty space: clear unless shift is extending, then rubber-band.
  if (!e.shiftKey && state.selection.size) {
    state.selection.clear();
    selectionChanged();
  }
  svg.setPointerCapture(e.pointerId);
  state.drag = {
    kind: "marquee", pointerId: e.pointerId, startWorld: at,
    base: new Set(state.selection),
  };
  marqueeShow(at, at);
  e.preventDefault();
}

function onMove(e) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== e.pointerId) return;
  const at = screenToWorld(e);

  if (drag.kind === "create") {
    sizeDraft(drag, at);
    previewSet([drag.draft]);
    return;
  }

  if (drag.kind === "move") {
    // attribute write only; regenerating rough geometry per frame costs one path rebuild per element per frame
    const dx = at.x - drag.startWorld.x;
    const dy = at.y - drag.startWorld.y;
    if (dx !== 0 || dy !== 0) drag.moved = true;
    const t = `translate(${dx},${dy})`;
    for (const eid of drag.ids) {
      const n = nodeFor(eid);
      if (n) n.setAttribute("transform", t);
    }
    setChromeTransform(t);
    drag.delta = { dx, dy };
    return;
  }

  if (drag.kind === "resize") {
    previewSet(projectAll(drag, at));
    layoutChrome(drag.projBox);
    return;
  }

  if (drag.kind === "marquee") {
    drag.lastWorld = at;
    marqueeShow(drag.startWorld, at);
  }
}

function onUp(e) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== e.pointerId) return;
  release(drag.pointerId);
  state.drag = null;

  if (drag.kind === "create") {
    previewClear();
    const el = drag.draft;
    if (Math.max(el.w, el.h) < MIN_DRAG) return;
    const pre = snapshot(state.elements);
    state.elements.push(el);
    commit(pre);
    return;
  }

  if (drag.kind === "move") {
    clearTransforms(drag.ids);
    setChromeTransform(null);
    const d = drag.delta;
    if (!drag.moved || !d || (d.dx === 0 && d.dy === 0)) {
      renderChrome();
      return;
    }
    for (const eid of drag.ids) {
      const el = elementById(eid);
      if (!el) continue;
      el.x += d.dx;
      el.y += d.dy;
      bump(el);
    }
    commit(drag.pre);
    return;
  }

  if (drag.kind === "resize") {
    setHidden(drag.ids, false);
    previewClear();
    if (!drag.projBox) {
      renderChrome();
      return;
    }
    for (const eid of drag.ids) {
      const el = elementById(eid);
      if (!el) continue;
      Object.assign(el, projectElement(drag.start.get(eid), drag.box, drag.projBox));
      bump(el);
    }
    commit(drag.pre);
    return;
  }

  if (drag.kind === "marquee") {
    marqueeClear();
    const at = drag.lastWorld;
    if (at) {
      const m = {
        x: Math.min(drag.startWorld.x, at.x),
        y: Math.min(drag.startWorld.y, at.y),
        w: Math.abs(at.x - drag.startWorld.x),
        h: Math.abs(at.y - drag.startWorld.y),
      };
      state.selection.clear();
      for (const eid of drag.base) state.selection.add(eid);
      for (const el of state.elements) {
        if (intersects(bboxOf(el), m)) state.selection.add(el.id);
      }
    }
    selectionChanged();
  }
}

function onCancel(e) {
  if (!state.drag || state.drag.pointerId !== e.pointerId) return;
  abortDrag();
}

function release(pointerId) {
  try {
    svg.releasePointerCapture(pointerId);
  } catch {
    // capture already gone (pointercancel, or the element left the DOM)
  }
}

// drops transient transforms/previews/marquee without touching history; also the mid-drag Ctrl+Z path before the undo
export function abortDrag() {
  const drag = state.drag;
  if (!drag) return;
  release(drag.pointerId);
  state.drag = null;
  if (drag.kind === "move") {
    clearTransforms(drag.ids);
    setChromeTransform(null);
  } else if (drag.kind === "resize") {
    setHidden(drag.ids, false);
  } else if (drag.kind === "marquee") {
    marqueeClear();
  }
  previewClear();
  renderChrome();
}

export function initTools() {
  svg.addEventListener("pointerdown", onDown);
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onUp);
  svg.addEventListener("pointercancel", onCancel);
  setTool(state.tool);
}
