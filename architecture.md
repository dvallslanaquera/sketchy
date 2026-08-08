# Sketchy architecture

## What this is

A single-page browser drawing tool: hand-drawn shapes, pasteable images, free text, a sidebar of saved canvases with thumbnails, auto-save on every change, 10-step undo/redo, per-figure and bulk color and transparency editing, spacebar hand-pan, and rich text controls. Dark mode, with a toggle between pure black and charcoal grey canvas backgrounds.

The governing priority is input latency. Every design decision below that touches the pointer path is made to keep the time between a mouse event and a pixel change under one frame.

## Core decisions

### Vanilla JS, ES modules, no framework, no bundler, no server code

No build step, no node_modules, no transpile. The app is static files served by anything.

We do need a static server. Two reasons: `file://` gives every page an opaque origin, which historically broke IndexedDB (Firefox shipped that bug for nine years before closing it, and Chrome's behavior has its own quirks), and `file://` blocks ES module loading outright. Betting the app's only persistence layer on the least-tested storage path in every browser is not a trade worth making to save one command.

So: `python -m http.server 8000` from the project root, then `localhost:8000`. A `serve.cmd` one-liner ships in the repo. With a real origin we get ES modules back, so the source splits into modules with `import`/`export` and no bundler.

`localhost` is a secure context, so `crypto.randomUUID()` works. If you ever serve from a LAN IP over plain http it will not exist, so `id()` falls back to a counter plus `Math.random()`.

### SVG rendering with rough.js, not canvas

We render into an `<svg>` via `rough.svg()` rather than a `<canvas>`. The tradeoffs:

- Hit-testing is DOM-native. Each shape carries an invisible companion hit path, so pointer events tell us what was clicked with no spatial index and no per-frame intersection math. See the hit-testing section, because this only works if the hit paths are built deliberately.
- Pan and zoom are one line: mutate the SVG `viewBox`. Canvas would require a full repaint and manual transform matrices.
- Selection handles, bounding boxes, and resize grips are first-class SVG elements, drawn in the same coordinate space as the shapes.
- Color and opacity edits restyle a single node without redrawing the scene.
- Moving elements is an attribute write on a `<g>`, not a repaint.

The cost is performance at thousands of elements. Acceptable for a sketching tool, and the performance gate in the roadmap pins down where "acceptable" ends.

### rough.js vendored locally

`vendor/rough.js` is the UMD build. It predates the module split and still writes `window.rough`, which is fine; `render.js` reads the global rather than importing it. Vendoring keeps the app offline and avoids CDN flakiness.

### Fonts vendored as woff2, not loaded from Google Fonts

Excalifont is not on Google Fonts. Neither is Virgil. Both are vendored directly under OFL-1.1. Caveat is on Google Fonts, but a network request that blocks first text paint is the wrong default for this app.

Both handwritten faces ship as woff2 in `vendor/fonts/`, declared with `@font-face` and `font-display: block` so text never paints in a fallback face and then reflows. Roughly 30 KB each. The other eight faces are system fonts and cost nothing.

### IndexedDB for persistence

localStorage caps at 5 MB and stores strings only, which rules out image blobs and many canvases. IndexedDB gives us object stores, blob support, and async, unbounded storage.

## Latency budget

The target is that a pointer event changes pixels within the same frame it arrived in. Concretely: 300 elements on screen, dragging a 10-element selection, under 8 ms per frame. The roadmap gates on this with a seeded scene generator.

What that rules out:

**Never regenerate rough.js geometry during a drag.** rough.js rebuilds a wobble path from the seed on every call, producing a fresh path string the browser must reparse. A move drag that mutates `x, y` per frame costs one rebuild per selected element per frame. Instead, a move drag writes `transform="translate(dx,dy)"` on each selected `<g>` and touches no element data. On pointerup we bake the delta into `x, y`, render once, and push one snapshot.

**Preview cheaply while creating and resizing.** A resize drag changes the shape's dimensions every frame, so the wobble reshuffles every frame and the shape visibly crawls. While dragging, we draw a plain `<rect>`, `<ellipse>`, `<line>` or polygon at 1px in the stroke color with `stroke-dasharray` off. The rough path is generated once on pointerup. Faster and steadier at the same time.

**No `getBoundingClientRect()` inside pointermove.** Reading layout mid-handler forces a style and layout flush before anything else can run. The SVG's client rect is read on pointerdown and in the ResizeObserver, then cached on `state.view.rect`. `screenToWorld` reads the cache.

**No rAF throttle on pointermove.** Browsers already coalesce pointermove to one event per frame. Wrapping the handler in `requestAnimationFrame` adds up to a full frame of input lag and buys nothing. Handlers write attributes synchronously. If a handler ever exceeds about 4 ms in the profiler, that handler gets fixed rather than deferred.

**`touch-action: none` on the SVG.** Without it Chrome holds the first pointermove while it decides whether the gesture is a scroll, which is visible lag on the first pixel of every drag. `user-select: none` goes alongside it.

**`setPointerCapture` on pointerdown, released on pointerup.** Without capture, dragging past the SVG edge drops the event stream and the shape freezes under the cursor.

**Style writes never rebuild geometry.** rough.js emits a `<g>` containing one or two `<path>` children. On creation we tag them `data-role="stroke"` and `data-role="fill"`, so a color or opacity change is two `setAttribute` calls.

**Persistence stays off the pointer path.** The IDB write runs in `requestIdleCallback`. Only `blur` and `visibilitychange` force a synchronous flush.

**Thumbnails are generated on idle, for inactive canvases only.** Re-rendering a whole scene through rough.js is the most expensive thing the app does. It never runs for the canvas being drawn on.

## File structure

```
C:\dev\sketchy\
  index.html                markup, <link> to styles.css, <script type="module">
  styles.css                dark theme, layout, toolbar, sidebar, panel
  serve.cmd                 python -m http.server 8000
  src\
    app.js                  boot, state object, event wiring, shortcuts
    render.js               SVG diff render, rough cache, hit paths, selection chrome
    tools.js                pointer state machine, drag handlers, marquee
    view.js                 pan, zoom, zoom-to-fit
    text.js                 <text>/<tspan> layout, <textarea> editor overlay
    history.js              undo/redo stack
    db.js                   IndexedDB wrapper
    thumbs.js               offscreen thumbnail rendering
  vendor\
    rough.js                vendored UMD rough.js
    fonts\excalifont.woff2
    fonts\caveat.woff2
  README.md                 how to run, shortcuts
```

Eight source files rather than one, because ES modules make the split free and `app.js` as a single file would run past 2000 lines. Each module owns one job and exports a handful of functions.

`view.js` is separate from `render.js` because the viewport is state that three callers mutate (the wheel handler, the hand drag, and the two zoom shortcuts) while `render.js` only reads it to write the `viewBox`. It is also the one piece of state that is deliberately outside history.

`index.html` layout: `#app` contains `#sidebar` (the canvas list with thumbnails, a New button, and per-item rename and delete) and `#main` (a top toolbar, the `<svg id="canvas">`, a `<textarea id="text-editor">` overlay hidden by default, and a right-side properties panel that appears only when something is selected).

## State

One module-scoped object in `app.js`, no classes:

```js
state = {
  canvases: CanvasDoc[], activeId,
  elements: Element[],          // z-order is array order, index 0 is furthest back
  selection: Set<id>,
  view: { tx, ty, scale, rect }, // rect is the cached SVG client rect
  bg: 'black' | 'charcoal',
  tool: 'select' | 'arrow' | 'rect' | 'ellipse' | 'diamond' | 'text' | 'pan',
  drag: null | { kind, startWorld, lastWorld, grip, ids },
  clipboard: Element[],
}
```

History lives in `history.js` and is not part of `state`.

## Layers

**Render.** `renderElements()` diffs by id against `Map<id, {node, version}>`. A node is rebuilt only when the element's `version` integer differs, so the change test is an integer compare rather than a deep object compare. Every mutation bumps `version`. The `viewBox` is recomputed from `view` and the container size. `renderHandles()` and `renderSelectionBox()` draw the selection chrome into a separate `<g id="chrome">` that always sits last in document order.

**Events.** One set of SVG listeners (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `wheel`) plus `window` listeners for `keydown`, `keyup`, and `paste`. A tool state machine dispatches pointer events to the right handler.

**Persistence.** Every mutation calls `scheduleSave()`, which coalesces through a microtask plus a 250 ms debounce and then writes in `requestIdleCallback`. `blur` and `visibilitychange` flush synchronously.

## Element model

All coordinates are in world space (SVG user units, before pan and zoom). One union shape, discriminated by `type`:

```js
{
  id,                              // crypto.randomUUID(), with a counter fallback
  type: 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'text' | 'image',
  version,                         // integer, bumped on every mutation
  x, y,                            // origin; for arrows, the anchor for points
  w, h,                            // bounding box size; derived for arrows
  stroke,                          // hex
  fill,                            // hex or null (transparent)
  opacity,                         // 0..1
  seed,                            // rough.js seed, stable across re-renders
  points?: [[dx, dy], [dx, dy]],   // arrow only, relative to x,y
  text?, fontSize?, fontFamily?,   // text only
  align?: 'left' | 'center' | 'right',
  blobId?,                         // image only: ref into the blobs store
}
```

Z-order is array position, with index 0 furthest back. Bring-to-front and send-to-back splice within the array, which is why no `zIndex` field exists.

There is no `angle` field. Rotation is a declared non-goal. Adding it later invalidates every axis-aligned bbox, every grip position, and every marquee intersection in the selection layer, so it is a rewrite of that layer rather than a new field.

- **Arrow.** `x, y` is authoritative as the anchor. `points` are offsets from it, so moving an arrow only touches `x, y`. `w, h` are derived from the point extents on write and used for marquee tests. Rendered as a rough line plus a rough arrowhead polygon.
- **Diamond.** Four mid-edge points computed from `x, y, w, h`, drawn with `rough.svg().polygon()`.
- **Text.** Rendered as `<text>` with one `<tspan>` per line. Not `<foreignObject>`. See the text section.
- **Image.** `blobId` resolves through the IDB `blobs` store to a `URL.createObjectURL` URL, cached in a `Map<blobId, url>` so we do not recreate it on every render.

## Hit-testing

Every shape emits a companion hit path alongside its visible geometry, sharing the same `d`:

```
fill: none; stroke: transparent; stroke-width: 10; pointer-events: stroke
```

Filled shapes emit a second one with `fill: transparent; pointer-events: all`. Visible rough paths carry `pointer-events: none`.

This is what makes the SVG choice pay off. A rough.js rectangle with `fill: none` otherwise only receives events on a wobbly 1px stroke, and users would miss clicks constantly. With hit paths, arrows hit-test for free too, and there is no distance-to-segment math anywhere in the codebase.

The hit stroke width is fixed at 10 in world units and scaled inversely with zoom (`10 / scale`) so the clickable margin stays visually constant.

Selection chrome: the bbox rect is `pointer-events: none` so it does not swallow clicks on what it surrounds. Grips opt back in with `pointer-events: all` and carry a `data-grip` attribute naming their corner.

## Pan, zoom, and hand-mode

`view = { tx, ty, scale }` and `viewBox = "${tx} ${ty} ${cssW / scale} ${cssH / scale}"`.

`screenToWorld(e)` converts pointer coordinates using the cached rect: `wx = (e.clientX - view.rect.left) / scale + tx`, and the same for y. Every pointer handler uses it. Raw client coordinates are never compared to world coordinates.

Wheel handling follows the trackpad convention, because two-finger scroll fires wheel events and a zoom-always mapping means the canvas zooms every time someone tries to pan:

- `ctrlKey` or `metaKey` held: zoom, anchored on the cursor. Trackpad pinch synthesizes `ctrlKey`, so pinch works with no extra code. Adjust `scale` (clamped to 0.2 through 8) and recompute `tx, ty` so the world point under the cursor stays fixed.
- Plain wheel: pan by `deltaX / scale` and `deltaY / scale`.
- Shift held: pan horizontally by `deltaY`.

The listener is registered `{ passive: false }`. Without it the `preventDefault` is ignored and ctrl+wheel zooms the whole page instead of the canvas.

Deltas are normalized before use. Firefox reports mouse wheels in `deltaMode: 1`, which is lines, not pixels, so a raw `deltaY` of 3 would pan three pixels there and a hundred in Chrome. Lines multiply by 16, pages by the viewport height. The zoom factor is `exp(-deltaY * 0.0015)`, which turns one 100px notch into about 14% and keeps trackpad pinch smooth because small deltas produce small factors.

Shift plus wheel is messier than it looks. Chrome already swaps the axes when shift is held and reports the scroll on `deltaX`; Firefox leaves it on `deltaY`. Taking `deltaX || deltaY` covers both without sniffing the browser.

Hand-mode: holding Space sets `tool = 'pan'`, switches the cursor to `grab`, and suppresses shape creation. The pan drag reads raw client deltas against the `tx, ty` cached at pointerdown rather than going through `screenToWorld`, because `tx` is moving underneath the handler and a world reading would chase its own tail. Releasing Space restores the previous tool, and so does a window `blur`, since losing focus mid-hold eats the keyup and would otherwise strand the canvas in hand mode.

A `pointercancel` during a hand drag keeps the pan where it landed instead of rewinding it. Every other drag abort drops transient state that never reached the model, but the view has genuinely moved by then, and snapping it back is more disruptive than leaving it.

Zoom-to-fit (Shift+1) fits the union bbox of all elements with a 40px margin, clamped to the same 0.2 to 8 range, so a lone small shape fills the viewport at 8x rather than at whatever 30x it would take. The shortcut is read off `e.code === 'Digit1'`, since `e.key` for shift+1 is `!` on a US layout and something else on most others. Reset zoom (Ctrl+0) sets `scale = 1` and centers on the content. Pan and zoom are not undoable, only `elements` is. Undoing a pan would be jarring.

A zoom changes `scale`, and grip size, chrome padding, the hit margin and the preview stroke are all divided by it, so a zoom relays the selection chrome. A pan does not touch `scale`, so it writes the `viewBox` and nothing else.

## Selection and bulk edit

- **Click.** Hit-test the top-most element in reverse z-order, replace the selection.
- **Shift-click.** Toggle an id in the set.
- **Empty-space drag.** With the select tool, start a rubber-band marquee in world coordinates. On pointerup, select every element whose bbox intersects the marquee.
- **Chrome.** One bbox rect plus eight grips around the union bbox of the selection.
- **Move.** Dragging the body writes `transform` on the selected `<g>` nodes for the duration of the drag and bakes into `x, y` on pointerup. No geometry rebuild.
- **Resize.** Dragging a grip scales the group. Shapes scale `w, h`, text scales `fontSize`, images scale `w, h`. Live preview uses the cheap non-rough path.
- **Bulk edit.** The properties panel writes stroke color, fill color, and opacity to every selected id in one mutation, which produces one history snapshot.
- **Z-order.** Ctrl+Shift+] brings to front, Ctrl+Shift+[ sends to back, both splice within `elements`.

The opacity slider splits its two events. `input` writes the attribute directly for a live preview with no snapshot. `change` commits and pushes one snapshot. Without the split, one slider drag pushes 40 snapshots and empties the 10-slot history in a single gesture.

## Undo and redo

A snapshot is a deep clone of `state.elements` only. Plain objects, cheap to clone via `structuredClone`.

**The pushed snapshot is the state before the action.** Getting this backwards is the classic bug here, so: at the start of a logical action we clone the current elements and push that clone. Undo therefore pops a state that predates the thing being undone.

One undo step equals one logical action: a completed drag (pointerup, not each pointermove), a bulk property edit, a create, a delete, a z-order change, or a text commit. We never push history mid-drag.

On each new action: `past.push(preSnap); if (past.length > 10) past.shift(); future.length = 0`.

- **Ctrl+Z.** `future.push(clone(current)); elements = past.pop()`. `future` is capped at 10 as well.
- **Redo.** Ctrl+Shift+Z is the primary binding. Ctrl+Y is an alias. Ctrl+R is bound too, as requested, with `preventDefault()` to block the browser refresh. Ctrl+R is preventable in current Chrome and Firefox, but one miss reloads the page, so it is the third binding rather than the first. (`e.returnValue = false` is the `beforeunload` API and does nothing on a keydown, so it is not used.)
- Undo and redo also write to IDB, so undoing then closing persists the undone state.

Canvas deletion is not part of the element history. Deleting a canvas sets `deletedAt` on the record, hides it from the sidebar, and purges on the next boot, which gives a session-long grace period without a confirm dialog on the hot path.

## IndexedDB schema

`db.js` opens `sketchy` v1 with four object stores:

- **canvases** (keyPath `id`): `{ id, name, createdAt, updatedAt, deletedAt, elements, view, bg }`.
- **blobs** (keyPath `id`): `{ id, blob, mime }`. Image bytes live separately so canvas records stay small and blobs dedupe.
- **thumbs** (keyPath `canvasId`): `{ canvasId, dataUrl, elementCount }`. Split out so the hot save path never serializes a thumbnail string alongside the elements.
- **meta** (keyPath `key`): `activeCanvas` and `settings`.

Boot sequence: open the DB, purge soft-deleted canvases, create one "Untitled" canvas if empty, load the active canvas, render.

**Save race.** The debounced write captures `canvasId` in its closure and drops the write if the active canvas has changed since it was scheduled. Without that guard, switching canvases with a save in flight writes the old element list into the new canvas record.

## Sidebar thumbnails

For each canvas, render an offscreen 120 by 80 `<svg>` reusing `renderElements`, with the union bbox fit into 120 by 80 preserving aspect ratio. Serialize with `XMLSerializer` to a data URL and show it as an `<img>`.

Two constraints follow from the `<img>` step, because an SVG loaded into an `<img>` is a sandboxed document that runs no script and fetches nothing external:

- `<foreignObject>` HTML content does not render at all. This is the main reason committed text is `<text>`/`<tspan>` rather than `<foreignObject>`; otherwise every thumbnail would silently drop its text.
- Blob URLs do not resolve. Image elements are inlined as `data:` URIs during thumbnail serialization, read once from the blob store and cached.

Generation runs in `requestIdleCallback`, and only for canvases that are not currently active. Switching away from a canvas queues its thumbnail. `elementCount` on the record lets us skip regeneration when nothing changed.

## Text

Committed text renders as `<text>` with one `<tspan>` per line, wrapped manually against the element width. `text-anchor` handles alignment (`start`, `middle`, `end`).

Editing uses a single `<textarea id="text-editor">` absolutely positioned over the canvas, matching the element's font, size, alignment, and screen position. `<foreignObject>` is avoided for three specific reasons: it does not render in thumbnails as described above, it has long-standing Safari layout and scaling bugs, and `contenteditable="plaintext-only"` only reached Firefox in early 2025.

The text tool plus a click on empty space creates an empty text element and focuses the editor. Double-clicking existing text re-enters edit mode. Commit happens on blur or Ctrl+Enter (push a snapshot, save). Esc cancels, and an empty commit deletes the element.

Five preset sizes in world pixels: Title 32, XL 24, L 18, M 14, S 11. A grip resize scales `fontSize` freely, so a scaled element can sit between presets; clicking a preset button snaps it back to that exact value. The buttons are presets, not an enum, which is the only reading consistent with resizable text.

Ten faces: Excalifont, Caveat, Segoe UI, Arial, Comic Sans MS, Georgia, Courier New, Verdana, Times New Roman, Trebuchet MS.

## Clipboard

`Ctrl+V` has two possible sources and a defined precedence: if the system clipboard carries an `image/*` item, paste the image; otherwise if it carries text beginning with the magic prefix `sketchy:v1:`, parse the JSON payload and paste those elements; otherwise if the internal `state.clipboard` is non-empty, paste from it.

`Ctrl+C` writes both. Elements go into `state.clipboard` and, as `sketchy:v1:` plus JSON, onto the system clipboard, so copy and paste works across browser tabs.

Image paste finds the first `image/*` item, calls `getAsFile()`, stores the blob in the `blobs` store, and creates an image element at the world point under the cursor (or the canvas center) sized from the natural dimensions. The new element is selected.

Pasted elements are cloned with fresh ids and offset 10 px. Images reuse the `blobId`, so pasting an image ten times stores one copy of the bytes.

## Export

`Ctrl+Shift+E` exports the active canvas. SVG export serializes the scene with image blobs inlined as data URIs, the same path the thumbnail uses at full size. PNG export draws that SVG into an `OffscreenCanvas` at 2x and calls `toBlob`. Both download through an `<a download>` and an object URL.

## Background tones

`bg` maps `black` to `#000` and `charcoal` to `#232323`. Two toolbar buttons set it, which sets the SVG background and persists to both the canvas doc and `meta.settings`.

The sidebar and toolbar sit at `#181818` with a 1px `#333` border against the canvas. The original pairing of `#1e1e1e` canvas against a `#252525` sidebar was a 7-unit difference and read as one flat surface.

## Shortcuts and toolbar

The toolbar is a single row: Select, Rectangle, Ellipse, Diamond, Arrow, Text, then Black and Charcoal background buttons, then Undo and Redo, then a zoom readout that resets the zoom when clicked. Color and opacity live in the right-side properties panel, which appears only when something is selected.

Hand-mode has no button. It is space-held only, so nothing in the toolbar shows as active while it is on, and the previous tool lights up again on release.

Shortcuts, all gated to ignore when an `input`, `textarea`, or `contenteditable` is focused:

- Space: hand and pan, hold.
- Delete or Backspace: delete the selection.
- Ctrl+C, Ctrl+V, Ctrl+X: copy, paste, cut.
- Ctrl+A: select all. Ctrl+D: duplicate.
- Esc: clear the selection, cancel a text edit, or cancel a marquee.
- 1 through 6: switch tools.
- Ctrl+Z: undo. Ctrl+Shift+Z, Ctrl+Y, or Ctrl+R: redo.
- Ctrl+Shift+]: bring to front. Ctrl+Shift+[: send to back.
- Shift+1: zoom to fit. Ctrl+0: reset zoom.
- Ctrl+Shift+E: export.

## Edge cases

- **Screen and world math.** Every pointer handler goes through `screenToWorld` against the cached rect. Drag deltas accumulate in world space (`dScreen / scale`), so zooming mid-drag does not desync.
- **Hit margin at zoom.** The companion hit path uses `10 / scale`, so the clickable area stays visually constant across zoom levels.
- **Text focus versus global shortcuts.** The global keydown checks `document.activeElement`. Delete while editing text edits text instead of deleting the element.
- **Undo during a drag.** History pushes on pointerup only. If Ctrl+Z fires mid-drag, abort the drag (drop the transient transforms) first, then apply the undo.
- **Pointer cancel.** `pointercancel` runs the same abort path as a mid-drag undo, so a system gesture interruption does not leave a half-placed shape.
- **Grip versus body versus empty.** Decided by the event target's `data-grip` attribute.
- **Object URL lifecycle.** Revoke a blob URL only when no remaining canvas references that blobId, checked by scanning on canvas purge.
- **viewBox versus CSS size.** A ResizeObserver on the container recomputes the viewBox width and height as `cssW / scale`, and refreshes `view.rect`.
- **Scroll and resize invalidate the cached rect.** Anything that can move the SVG in the viewport refreshes `view.rect`, since a stale rect silently offsets every pointer coordinate.
