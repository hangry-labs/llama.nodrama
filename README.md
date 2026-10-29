<p align="center">
  <img src="assets/llama-nodrama_logo.webp" alt="llama.nodrama by HangryLabs" width="720">
</p>

**Read this in:** [🇺🇸 English](README.md) | [🇰🇷 한국어](docs/readme/README.ko-KR.md) | [🇯🇵 日本語](docs/readme/README.ja-JP.md) | [🇨🇳 简体中文](docs/readme/README.zh-CN.md) | [🇪🇸 Español](docs/readme/README.es-ES.md)

# llama.nodrama

Development version **v0.6.0-SNAPSHOT**. See the [version history](#version-history).
The latest published release is [v0.5.0](https://github.com/hangry-labs/llama.nodrama/releases/tag/v0.5.0).

`llama.nodrama` is a small Go dashboard for operating `llama.cpp` servers. It
exists because running `llama.cpp` with multiple slots should not feel like
guesswork. The goal is simple: point it at your llama, get a clear visual
overview, and have no drama.

The dashboard focuses on the things that are hard to see from raw logs alone:
slot activity, query flow, queueing, token throughput, cache reuse, and timelines
of what changed while the server was under load. It serves a browser UI and a
typed backend API that normalize `llama.cpp` metrics, slots, requests,
suggestions, and historical values into one live view.

This is especially useful when running on a budget machine where concurrency and
KV cache behavior matter. If you need several clients to share limited compute
and memory, balancing slots, cache reuse, prompt processing, and generation speed
requires visibility. `llama.nodrama` is meant to make that operational picture
obvious without turning monitoring itself into another project.

## Quick Start

Install published **v0.5.0**. The dashboard is a single binary for
Linux, macOS and Windows; it connects to an existing `llama.cpp` server.

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/v0.5.0/install.sh | LLAMA_NODRAMA_VERSION=v0.5.0 sh
```

Windows PowerShell:

```powershell
$env:LLAMA_NODRAMA_VERSION = "v0.5.0"
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/v0.5.0/install.ps1 | iex
```

The Windows installer copies `llama-nodrama.exe` to a user-local install
directory and adds that directory to the user PATH. The current PowerShell
session is updated too, so `llama-nodrama --help` should work immediately after
install.

<details markdown="1">
<summary><strong>Follow the newest published release</strong></summary>

Omit the version override to let the installers select GitHub's latest stable
release. This selection moves as new releases are published.

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/main/install.sh | sh
```

```powershell
Remove-Item Env:LLAMA_NODRAMA_VERSION -ErrorAction SilentlyContinue
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/main/install.ps1 | iex
```

</details>

## Run

Start `llama-server` with the endpoints the dashboard needs:

```sh
llama-server --metrics
```

Then run the dashboard:

```sh
llama-nodrama --server http://127.0.0.1:8080 --listen :39080
```

Open `http://127.0.0.1:39080`.

The screenshot and feature descriptions below follow the development branch;
check the [release notes](#version-history) for what is in a published binary.

## Browser UI

![llama.nodrama dashboard UI](docs/ui.webp)

## Runtime Settings

`llama.nodrama` does not auto-discover `llama.cpp` servers yet. Point it at the
specific deployment you want to monitor with `--server`; if `llama-server` runs
on the same machine with the usual port, the default is already
`http://127.0.0.1:8080`.

You can also change runtime settings from the UI settings button after startup:
server URL, log path, backend poll interval, and upstream timeout. Changing the
server or log path resets collected dashboard history so old and new targets do
not mix. The listen address and raw proxy routes are startup-only settings.

Settings now persist across restarts in `settings.json` under the current user's
configuration folder:

| Platform | Default folder |
| --- | --- |
| Windows | `%APPDATA%\llama-nodrama` |
| Linux | `$XDG_CONFIG_HOME/llama-nodrama`, or `~/.config/llama-nodrama` |
| macOS | `~/Library/Application Support/llama-nodrama` |

Use `--config-dir <folder>` to choose another location, such as a mounted volume
for a container, or `--config-dir none` for an ephemeral instance. The Settings
dialog shows the actual file location. Startup loads defaults, then saved
settings, then explicitly supplied flags; the effective settings are saved at
startup and whenever you save in the UI. Explicit service/CLI flags continue to
override saved values on each restart. To use saved operator defaults, start the
service with only `--config-dir` after its initial configuration.

Settings files contain server/listen addresses, log path, proxy preference and
timing controls. They belong outside the checkout and may contain private
deployment details. Chat content and metric histories remain in memory. Invalid
settings and failed writes report errors; a failed UI save leaves the active
configuration unchanged.

## Log Setup

Log paths refer to the machine running **llama.nodrama**, which may be different
from the browser or llama.cpp host. The HTTP endpoints do not advertise an
arbitrary log-file location, so the dashboard uses an explicit path rather than
guessing folders or inspecting machine-specific launchers.

For a local server, ask llama.cpp to write a log file alongside its usual model
and server options:

```sh
llama-server --metrics --log-file llama-server.log --log-verbosity 4
```

In a second terminal in the same working directory, start the dashboard:

```sh
llama-nodrama --server http://127.0.0.1:8080 --log ./llama-server.log
```

Alternatively, enter the absolute path in **Settings → Log file path** and save.
Trace verbosity (`--log-verbosity 4`) supplies detailed prompt-cache events.
Keep the file readable by the dashboard's service account. If the server runs
elsewhere or inside a container, explicitly forward its logs or mount its log
directory into the dashboard's environment; use the path visible there.
Docker stdout and systemd journal ingestion are not currently supported.

## Build From Source

```sh
cd nodrama
go test ./...
go build -o llama-nodrama .
```

For development, run `task check` from the repository root, or:

```sh
cd nodrama
go run ./tools/check
```

This requires Go 1.25 and Node.js 22 or newer. It checks Go formatting, vet,
Go tests, browser script syntax and loading order, translation keys, and chat
stream/history regressions. No npm packages, GPU, or running model are needed.
To run just the chat regressions: `node --test tests/chat.test.cjs` from `nodrama`.

For browser regression tests, run `task check-browser`, or from `nodrama`:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

These launch a temporary local dashboard and check offline mode, demo charts,
cache/slot/query links, launch-option layouts, model/settings actions and chat
at phone, tablet and desktop widths. CI runs them in Chromium. Browser testing
uses development dependencies only; distributed binaries still need no Node.js.

For a manual preview without llama.cpp, open `/?demo=1` or `/?demo=router` on
the local dashboard. Demo activity, histories, cache, logs and model/slot actions
are synthetic and stay in the browser. Demo server/log settings are read-only;
polling and timeout controls apply to the preview.
Section navigation lives in the top bar. Its status badge shows **Demo** for
synthetic previews and the current connection state for a real server.

The compact overview keeps all 15 statistics accessible: server uptime lives
beside the connection status in the top bar, with start time/source in its tooltip
and history on click. The eight live timeline cards sit on the left at equal size,
including Tokens max and Container CPU; the six cumulative summaries sit on the
right. On narrow screens, timelines appear above the summaries. Cumulative totals show the
current value and observed increases over **1m / 5m / 1h**. A label such as
`2m / 5m` means only two minutes of that five-minute window have been observed;
the increase is not extrapolated. Resets and collection gaps show an unknown
increase, and quiet covered intervals show `+0`. Click a total title or the uptime
control to open its historical
overview; totals show observed increase and coverage rather than average/peak.
The detailed view scales to the observed range and uses full numbers so small
changes remain visible. Changes follow the counters llama.cpp publishes, which
can round large totals.

Timeline previews
retain 5-minute/all-time peaks and show their actual observed
window; click a metric title for a larger chart with 1h/6h/24h selection,
axis labels and sample statistics. Inspect points by pointer, touch, or the
arrow/Home/End keys when a chart has focus. Live charts move samples by their
timestamps, keeping peak shapes intact as the window scrolls. Motion follows
the update cadence and respects reduced-motion preferences. **Pause updates**
freezes the view without stopping work on llama.cpp. Collection gaps remain gaps in the charts,
and unknown token limits show no percentage rather than a false zero.

The highlighted **Chat** link opens the chat panel and focuses its input.
Chat keeps up to 40 turns in memory; reloading clears the conversation. Stopped
partial replies are labelled and retained in history. Failed or interrupted
turns are excluded from outgoing history and the input is restored for retry.
Parallel stress requests use the first completed reply in request order for
history and label that reply. Token statistics use server usage when available;
otherwise the footer shows characters.

Use **Attach**, drag files into the composer, or paste an image from the
clipboard. Draft attachments have removable previews and are shown beside the
sent message. Images use llama.cpp's multimodal input and require a vision
model; a server that advertises text-only support is rejected before sending.
If support is unknown, the server validates the request. Text/code files are
included as named UTF-8 text blocks. Attachments stay in conversation memory
and are restored with the draft when a request fails.

Up to eight files can be attached to a message. Text files are limited to
256 KiB each; source images to 10 MiB. Images are resized to a maximum 2048 px
edge and normalized to PNG/JPEG. The complete conversation request must fit
within 4 MiB. PDF, office documents, audio and archives are not supported.

Parallel chat launches up to eight upstream requests from Go and streams the
indexed replies over one browser connection. This leaves monitoring responsive
on HTTP/1 connections while llama.cpp queues requests beyond its slot count.
**Stop** cancels both running and queued requests. The UI uses
`POST /api/chat/completions/batch?count=2` (count 1–8, streaming JSON request,
4 MiB body limit); its NDJSON frames carry a reply index and headers, base64
data, completion, or error. Individual request failures leave other replies running.

Raster artwork, documentation screenshots and browser icons use WebP. Windows
builds decode the WebP icon sources into ignored `winres/generated/` PNG
intermediates for native executable resources; no PNG/JPG source assets are
required. The decoder is a build-tool dependency, and the dashboard still ships
as a single Go binary.

Useful flags:

```text
--server   llama.cpp server base URL, default http://127.0.0.1:8080
--listen   dashboard listen address, default :39080
--log        optional llama.cpp log file path for /api/logs/tail
--poll       polling interval, default 1s
--raw-proxy  expose selected raw llama.cpp proxy routes for debugging
--timeout    upstream request timeout, default 5s
--config-dir settings folder, default OS user configuration folder/llama-nodrama
             use "none" to disable persistence
--update     print repository and latest release links, then exit
--version    print build version and exit
```

The version label in the dashboard top bar links to the project repository. The
backend periodically checks the newest GitHub Release; when a newer release
exists, the version label highlights and links directly to that release.

Runtime logs use explicit levels (`INFO`, `WARN`, `ERROR`). Set
`LLAMA_NODRAMA_DEBUG=1` to include detailed endpoint probe logs.

## Privacy

`llama.nodrama` runs locally and does not collect, sell, or transmit user data
to Hangry Labs. See [PRIVACY.md](PRIVACY.md) for the full privacy statement.

## Releases

Install published binaries from [GitHub Releases](https://github.com/hangry-labs/llama.nodrama/releases).
Each release has Linux, macOS and Windows archives for amd64 and arm64, plus
`SHA256SUMS`. Branch CI artifacts are development builds. Creating a source
tag alone does not establish that release downloads are available.

The [release guide](docs/RELEASING.md) covers snapshot promotion, checks,
publication, archive contents, Windows signing and Winget manifests. Release
preparation belongs in the development workflow; GitHub Actions builds the
distributable binaries after a release tag is pushed.

## Version History

<details open markdown="1">
<summary><strong>v0.6.0-SNAPSHOT development notes</strong></summary>

### v0.6.0-SNAPSHOT

Development after `v0.5.0`. These changes are on `main` and have not been
published as a `v0.6.0` release. Build from source to try them.

- Keep all 15 statistics in a compact diagnostic overview, with live timelines
  on the left, cumulative summaries on the right and server uptime in the top bar.
- Show observed counter increases over 1m / 5m / 1h, with explicit partial
  coverage, resets and gaps. Open historical views without charting every total.
- Scroll live charts by sample timestamps so peaks retain their shape. Support
  inspection, pause, reduced motion and narrow screens.
- Persist runtime settings in the user's configuration folder, with explicit
  CLI overrides and atomic saves. Keep chat and telemetry history in memory.
- Expand prompt-cache diagnostics, restored-context information, cache reuse,
  and links between cache entries, slots and queries. Surface log-source hints.
- Improve chat stream parsing, stopped replies, retryable failures, reasoning
  controls and deterministic conversation history for parallel requests.
- Add image paste, drag-and-drop and file attachments, with previews, model
  capability checks and named text/code context retained in chat history.
- Send up to eight parallel chat requests through Go over one browser stream,
  keeping monitoring responsive while llama.cpp queues requests. Cancel queued
  work with Stop and distinguish monitoring timeouts from deliberate aborts.
- Add automated Go/UI checks and Chromium coverage for offline, demo, live
  concurrency and responsive behavior. Make demo activity internally consistent.
- Keep Go source checkouts in LF format on Windows as well as Linux/macOS, so
  Git's CRLF conversion does not cause the CI formatting check to fail.
- Convert raster source artwork and icons to WebP; retain native Windows icon
  resources. Document brand restrictions and bundled third-party notices.

</details>

### v0.5.0

Published **2026-06-08**. [Release and downloads](https://github.com/hangry-labs/llama.nodrama/releases/tag/v0.5.0)
· [Source tag](https://github.com/hangry-labs/llama.nodrama/tree/v0.5.0).

<details markdown="1">
<summary><strong>v0.5.0 release notes</strong></summary>

- Expand the web dashboard, context tracking and configuration help.
- Improve slot/task mapping, cache-reuse tracking and offline handling.
- Add chat thinking controls, pinned slots and additional history options.
- Improve log filtering, idle-line handling, layout and scrolling.
- Refine interface languages, LoRA controls and Windows installation behavior.

</details>

<details markdown="1">
<summary><strong>Earlier releases</strong></summary>

### v0.4.0

Published **2026-06-07**. [Release and downloads](https://github.com/hangry-labs/llama.nodrama/releases/tag/v0.4.0).
Correct cross-platform build environment handling and refine Winget manifests
and checksum generation.

### v0.3.0

Published **2026-06-07**. [Release and downloads](https://github.com/hangry-labs/llama.nodrama/releases/tag/v0.3.0).
Use stable executable names inside platform archives, add Winget manifest
generation and improve browser icons.

### v0.2.0

Published **2026-06-07**. [Release and downloads](https://github.com/hangry-labs/llama.nodrama/releases/tag/v0.2.0).
Add release-update checks, local build tools, clearer runtime logging and
release-task automation.

### v0.1.0

Published **2026-06-07**. [Release and downloads](https://github.com/hangry-labs/llama.nodrama/releases/tag/v0.1.0).
Initial public release with standalone dashboard binaries for Linux, macOS and
Windows on amd64 and arm64.

</details>

## License

The project source code and documentation are licensed under the
[MIT License](LICENSE). Logos, mascots, badges, icons, and other brand artwork
are excluded from MIT and governed by [BRAND_ASSETS.md](BRAND_ASSETS.md).
Required third-party license text and attribution are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The release workflow includes
all three files in newly built archives.
