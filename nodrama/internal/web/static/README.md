# Static UI Asset Layout

The dashboard intentionally uses plain browser scripts and CSS files loaded by
`index.html` in a fixed order. There is no bundler yet, so order matters.

## JavaScript

- `i18n/`: shared translation table plus one file per language.
- `app/core/`: global state, DOM helpers, networking/demo mode, snapshots, and pollers.
- `app/shell/`: boot sequence, root scaffold, model/config panels, modals, actions, and guidance.
- `app/history/`: history normalization and sparkline rendering.
- `app/metrics/`: metric catalog, formatting, and metric-card rendering.
- `app/cache/`: shared prompt-cache overview rendering.
- `app/chat/`: chat state, markdown rendering, UI rendering, and streaming transport.
- `app/99-start.js`: final boot trigger. Keep this last.

Compatibility stubs such as `app.js`, `styles.css`, `i18n.js`, and
`app/50-chat.js` remain only to avoid stale direct references serving old code.

Chat loads `25-transport.js` before `30-stream.js`. The transport reader parses
SSE events and completion/error markers independently of the DOM. Regression
checks live in `nodrama/tests/` and use Node's built-in test runner with synthetic
streams; run `task check` from the repository root for the full development check.

`core/05-demo-data.js` produces normalized demo snapshots on an injectable clock.
Keep demo fixtures consistent with the Go snapshot contract, including bounded
histories and cache/query references. Chromium checks under `tests/browser/`
exercise the actual embedded page; run `task check-browser` separately.

## CSS

CSS is split by UI area and loaded in cascade order from `index.html`.

When adding new UI:

- Put shared tokens/base layout in `css/00-base-layout.css`.
- Put area-specific styles in the closest matching `css/*.css` file.
- Prefer DOM construction with `el(...)` and `textContent`; avoid rendering
  untrusted text with `innerHTML`.
