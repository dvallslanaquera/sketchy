# Sketchy

A hand-drawn sketching tool for the browser, built to keep the time between a mouse event and a pixel change under a single frame.

## Features

- **Hand-drawn shapes:** rectangles, ellipses, diamonds, and arrows rendered with rough.js.
- **Flexible selection:** click, shift-click to toggle, and rubber-band marquee.
- **Move and resize:** live preview during the drag, one history entry on release.
- **Style editing:** stroke color, fill, and opacity per element or across a multi-selection in one edit.
- **Pan and zoom:** hold space to drag the canvas, scroll to pan, pinch or `Ctrl`-scroll to zoom on the cursor.
- **Undo and redo:** a 10-step history, one entry per completed action.
- **Auto-save:** every change writes to IndexedDB; reload and your work is still there.
- **Multiple canvases:** a sidebar to create and switch between drawings.
- **Background tones:** pure black or charcoal grey.
- **No build step:** static files, no node_modules, no transpile, runs offline.

## Getting Started

Sketchy needs a real origin. `file://` blocks ES module loading and has historically broken IndexedDB, so serve the directory over http.

```bash
git clone https://github.com/dvallslanaquera/sketchy.git
cd sketchy
python -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000). On Windows, `serve.cmd` runs the same command.

## Requirements

- A current version of Chrome, Firefox, or Edge. `localhost` is a secure context, which `crypto.randomUUID()` and IndexedDB rely on.
- Python 3 for the dev server, or any other static file server.

## Shortcuts

| Action | Shortcut |
|--------|----------|
| Undo | `Ctrl+Z` |
| Redo | `Ctrl+Shift+Z` (primary), `Ctrl+Y`, `Ctrl+R` |
| Pan | Hold `Space` and drag, or scroll |
| Pan horizontally | `Shift` and scroll |
| Zoom | `Ctrl` and scroll, or pinch on a trackpad |
| Zoom to fit | `Shift+1` |
| Reset zoom | `Ctrl+0`, or click the zoom readout |
| New canvas | New button |
| Background | Black / Charcoal buttons |

`Ctrl+R` is bound to redo as well, but one miss reloads the page, so `Ctrl+Shift+Z` is the reliable one. Shortcuts are ignored while typing in a control.

Zoom clamps to 0.2x through 8x. Pan and zoom are per canvas and persist across reloads, but they are not undoable, so `Ctrl+Z` will not rewind a pan.

## Tech Stack

- Vanilla JavaScript with ES modules, no framework, no bundler.
- SVG rendering via [rough.js](https://github.com/rough-stuff/wired), vendored locally.
- IndexedDB persistence with separate canvases, blobs, thumbnails, and meta stores.
- Excalifont and Caveat, vendored as woff2 under OFL-1.1.

## Architecture

See [architecture.md](architecture.md) for the full design and the features still in progress. It covers the latency budget, the SVG hit-path scheme, the version-diff renderer, the undo contract, and the IndexedDB schema.

## License

The Excalifont and Caveat fonts in `vendor/fonts/` are OFL-1.1. The application code has no license chosen yet.