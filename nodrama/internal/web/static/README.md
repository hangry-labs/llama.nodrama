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

## CSS

CSS is split by UI area and loaded in cascade order from `index.html`.

When adding new UI:

- Put shared tokens/base layout in `css/00-base-layout.css`.
- Put area-specific styles in the closest matching `css/*.css` file.
- Prefer DOM construction with `el(...)` and `textContent`; avoid rendering
  untrusted text with `innerHTML`.
