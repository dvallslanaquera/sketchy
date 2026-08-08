// viewport only: tx, ty, scale. Pan and zoom are not undoable, so nothing here touches history.
import { state, scheduleSave } from "./app.js";
import { updateViewBox, renderChrome, unionBBox } from "./render.js";

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const FIT_MARGIN = 40; // screen px on every side

const zoomLabel = document.getElementById("zoom-level");

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

// the toolbar is live before boot finishes, and every command here divides by rect
function ready() {
  return state.view.rect != null;
}

// boot and canvas switch load tx/ty/scale straight off the record, so the label has to catch up
export function syncZoomLabel() {
  zoomLabel.textContent = Math.round(state.view.scale * 100) + "%";
}

// pan leaves scale alone, so the chrome keeps its size and world position and does not need a relayout
export function setPan(tx, ty) {
  state.view.tx = tx;
  state.view.ty = ty;
  updateViewBox();
}

export function panBy(dxScreen, dyScreen) {
  const v = state.view;
  setPan(v.tx + dxScreen / v.scale, v.ty + dyScreen / v.scale);
  scheduleSave();
}

// grip size, chrome padding and the hit margin are all divided by scale, so a zoom has to relay the chrome
function afterZoom() {
  updateViewBox();
  renderChrome();
  syncZoomLabel();
  scheduleSave();
}

// keeps the world point under the cursor fixed: wx = px / scale + tx, solved for tx at the new scale
export function zoomAt(clientX, clientY, factor) {
  if (!ready()) return;
  const v = state.view;
  const next = clampScale(v.scale * factor);
  if (next === v.scale) return;
  const rect = v.rect;
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const wx = px / v.scale + v.tx;
  const wy = py / v.scale + v.ty;
  v.scale = next;
  v.tx = wx - px / next;
  v.ty = wy - py / next;
  afterZoom();
}

function centerOn(b, scale) {
  const v = state.view;
  const rect = v.rect;
  v.scale = scale;
  v.tx = b.x + b.w / 2 - rect.width / (2 * scale);
  v.ty = b.y + b.h / 2 - rect.height / (2 * scale);
}

export function zoomToFit() {
  if (!ready()) return;
  const b = unionBBox(null);
  if (!b) {
    resetZoom();
    return;
  }
  const rect = state.view.rect;
  const availW = Math.max(1, rect.width - FIT_MARGIN * 2);
  const availH = Math.max(1, rect.height - FIT_MARGIN * 2);
  // a single point or a flat line has a zero side; fitting it would divide by zero
  const s = clampScale(Math.min(availW / Math.max(b.w, 1), availH / Math.max(b.h, 1)));
  centerOn(b, s);
  afterZoom();
}

export function resetZoom() {
  if (!ready()) return;
  const b = unionBBox(null);
  if (b) centerOn(b, 1);
  else {
    state.view.scale = 1;
    state.view.tx = 0;
    state.view.ty = 0;
  }
  afterZoom();
}
