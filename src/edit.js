// Clipboard, duplicate, delete, select all, z-order. Every command here is one logical action,
// so each pushes exactly one snapshot and Ctrl+Z reverts it whole.
import { state, commit, selectionChanged } from "./app.js";
import { snapshot } from "./history.js";
import { id } from "./db.js";

const PREFIX = "sketchy:v1:";
// world units, added again on each repeat paste so the second one does not land on the first
const OFFSET = 10;

const TYPES = new Set(["rect", "ellipse", "diamond", "arrow", "text", "image"]);

// the Set is in click order, the array is in z-order, and every command below wants z-order
function selectedInOrder() {
  return state.elements.filter((el) => state.selection.has(el.id));
}

// fresh id, same seed: a copy that reshuffled its wobble would not read as a copy.
// version restarts at 1 because the renderer caches by id and this id is new.
// blobId rides along untouched, so pasting an image ten times stores one copy of the bytes.
function clone(el, dx, dy) {
  const out = structuredClone(el);
  out.id = id();
  out.version = 1;
  out.x += dx;
  out.y += dy;
  return out;
}

// clones go on top of the z-order, keep their order among themselves, and become the selection
function place(list, dx, dy) {
  if (!list.length) return;
  const pre = snapshot(state.elements);
  const made = list.map((el) => clone(el, dx, dy));
  state.elements.push(...made);
  state.selection.clear();
  for (const el of made) state.selection.add(el.id);
  commit(pre);
}

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// A payload off the system clipboard may have been hand-edited, truncated, or written by an older
// build, so each element is rebuilt from known fields rather than trusted as handed over. An
// unexpected key reaching state.elements would go straight into IDB and outlive the session.
function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || !TYPES.has(raw.type)) continue;
    const el = {
      type: raw.type,
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      w: Math.max(0, num(raw.w, 0)),
      h: Math.max(0, num(raw.h, 0)),
      stroke: typeof raw.stroke === "string" ? raw.stroke : "#e6e6e6",
      fill: typeof raw.fill === "string" ? raw.fill : null,
      opacity: Math.min(1, Math.max(0, num(raw.opacity, 1))),
      seed: num(raw.seed, Math.floor(Math.random() * 2 ** 31)),
    };
    if (raw.type === "arrow") {
      const pts = Array.isArray(raw.points)
        ? raw.points
            .filter((p) => Array.isArray(p) && p.length === 2)
            .map(([a, b]) => [num(a, 0), num(b, 0)])
        : [];
      el.points = pts.length >= 2 ? pts : [[0, 0], [0, 0]];
    }
    if (raw.type === "text") {
      el.text = typeof raw.text === "string" ? raw.text : "";
      el.fontSize = Math.max(1, num(raw.fontSize, 14));
      if (typeof raw.fontFamily === "string") el.fontFamily = raw.fontFamily;
      if (raw.align === "center" || raw.align === "right") el.align = raw.align;
    }
    // blobs live in the origin's IDB, so a blobId copied from another tab resolves here too
    if (raw.type === "image" && typeof raw.blobId === "string") el.blobId = raw.blobId;
    out.push(el);
  }
  return out;
}

function parsePayload(text) {
  if (typeof text !== "string" || !text.startsWith(PREFIX)) return null;
  let data;
  try {
    data = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return null;
  }
  const list = sanitize(data && data.elements);
  return list.length ? list : null;
}

// Ctrl+C runs off keydown rather than the copy event: Firefox does not fire copy when nothing is
// selected and no editable is focused, and the SVG is user-select: none, so there never is.
// writeText needs a user gesture and a secure context, both of which a keydown on localhost gives.
function writeSystem(els) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  const text = PREFIX + JSON.stringify({ elements: els });
  // a denied permission is not worth a dialog; state.clipboard already holds the same elements
  navigator.clipboard.writeText(text).catch(() => {});
}

// counts pastes since the last copy, so holding Ctrl+V staircases instead of stacking
let pasteRun = 0;

export function copySelection() {
  const els = selectedInOrder();
  if (!els.length) return false;
  state.clipboard = structuredClone(els);
  pasteRun = 0;
  writeSystem(state.clipboard);
  return true;
}

export function cutSelection() {
  if (!copySelection()) return;
  deleteSelection();
}

export function deleteSelection() {
  if (!state.selection.size) return;
  const pre = snapshot(state.elements);
  state.elements = state.elements.filter((el) => !state.selection.has(el.id));
  state.selection.clear();
  commit(pre);
}

export function duplicateSelection() {
  place(selectedInOrder(), OFFSET, OFFSET);
}

export function selectAll() {
  if (!state.elements.length) return;
  state.selection.clear();
  for (const el of state.elements) state.selection.add(el.id);
  selectionChanged();
}

function pasteList(list) {
  pasteRun++;
  const d = OFFSET * pasteRun;
  place(list, d, d);
}

function imageItem(dt) {
  if (!dt || !dt.items) return null;
  for (const it of dt.items) {
    if (it.kind === "file" && it.type && it.type.startsWith("image/")) return it;
  }
  return null;
}

// The paste event hands over the system clipboard synchronously and with no permission prompt,
// which navigator.clipboard.read() does not, so Ctrl+V has no keydown binding at all.
// Precedence: system image, then a sketchy payload, then state.clipboard, which is the only
// source left when the system write was denied or the payload came from something else.
export function onPaste(e) {
  const dt = e.clipboardData;

  // Phase 7 fills this in. The branch is here now so a pasted screenshot stops at the top of the
  // chain instead of falling through and pasting whatever shapes were last copied.
  if (imageItem(dt)) return;

  const fromSystem = parsePayload(dt ? dt.getData("text/plain") : "");
  if (fromSystem) {
    e.preventDefault();
    pasteList(fromSystem);
    return;
  }

  if (!state.clipboard.length) return;
  e.preventDefault();
  pasteList(state.clipboard);
}

function sameOrder(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// splice within elements; z-order is array position, which is why there is no zIndex field.
// the moved elements keep their order among themselves, so a group does not shuffle itself
function reorder(toFront) {
  if (!state.selection.size) return;
  const moving = selectedInOrder();
  if (!moving.length) return;
  const rest = state.elements.filter((el) => !state.selection.has(el.id));
  const next = toFront ? [...rest, ...moving] : [...moving, ...rest];
  if (sameOrder(next, state.elements)) return; // already there, do not burn a history slot
  const pre = snapshot(state.elements);
  state.elements = next;
  commit(pre);
}

export function bringToFront() {
  reorder(true);
}

export function sendToBack() {
  reorder(false);
}
