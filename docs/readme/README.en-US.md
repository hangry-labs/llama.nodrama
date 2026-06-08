# llama.nodrama

**Read this in:** [🇺🇸 English](../../README.md) | [🇰🇷 한국어](README.ko-KR.md) | [🇯🇵 日本語](README.ja-JP.md) | [🇨🇳 简体中文](README.zh-CN.md) | [🇪🇸 Español](README.es-ES.md)

`llama.nodrama` is a small Go dashboard for operating `llama.cpp` servers. It exists because running `llama.cpp` with multiple slots should not feel like guesswork. The goal is simple: point it at your llama, get a clear visual overview, and have no drama.

The dashboard focuses on the things that are hard to see from raw logs alone: slot activity, query flow, queueing, token throughput, cache reuse, and timelines of what changed while the server was under load. It serves a browser UI and a typed backend API that normalize `llama.cpp` metrics, slots, requests, suggestions, and historical values into one live view.

This is especially useful when running on a budget machine where concurrency and KV cache behavior matter. If you need several clients to share limited compute and memory, balancing slots, cache reuse, prompt processing, and generation speed requires visibility. `llama.nodrama` is meant to make that operational picture obvious without turning monitoring itself into another project.

## UI Preview

![llama.nodrama dashboard UI](../ui.jpg)

## Install

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/master/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/master/install.ps1 | iex
```

Both installers use the newest GitHub Release by default. To pin a version:

```sh
LLAMA_NODRAMA_VERSION=v0.1.0 sh ./install.sh
```

```powershell
$env:LLAMA_NODRAMA_VERSION = "v0.1.0"; .\install.ps1
```

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

`llama.nodrama` does not auto-discover `llama.cpp` servers yet. Point it at the specific deployment you want to monitor with `--server`; if `llama-server` runs on the same machine with the usual port, the default is already `http://127.0.0.1:8080`.

You can also change runtime settings from the UI settings button after startup: server URL, log path, backend poll interval, and upstream timeout. Changing the server or log path resets collected dashboard history so old and new targets do not mix. The listen address and raw proxy routes are startup-only settings.

## Build From Source

```sh
cd nodrama
go test ./...
go build -o llama-nodrama .
```

Useful flags:

```text
--server     llama.cpp server base URL, default http://127.0.0.1:8080
--listen     dashboard listen address, default :39080
--log        optional llama.cpp log file path for /api/logs/tail
--poll       polling interval, default 1s
--raw-proxy  expose selected raw llama.cpp proxy routes for debugging
--timeout    upstream request timeout, default 5s
--update     print repository and latest release links, then exit
--version    print build version and exit
```

The version label in the dashboard top bar links to the project repository. The backend periodically checks the newest GitHub Release; when a newer release exists, the version label highlights and links directly to that release.

Runtime logs use explicit levels (`INFO`, `WARN`, `ERROR`). Set `LLAMA_NODRAMA_DEBUG=1` to include detailed endpoint probe logs.

## Privacy

`llama.nodrama` runs locally and does not collect, sell, or transmit user data to Hangry Labs. See [PRIVACY.md](../../PRIVACY.md) for the full privacy statement.

## Releases

CI runs Go formatting, vet, tests, and cross-platform builds on pushes and pull requests to `master` and `main`.

The source version lives in `nodrama/VERSION`. Snapshot builds use `vX.Y.Z-SNAPSHOT`; release tags use the finalized `vX.Y.Z` form.

To cut a release:

```sh
task release
```

`task release` requires a clean working tree. It removes `-SNAPSHOT`, commits and tags that finalized version, then bumps the minor version to the next `vX.Y.0-SNAPSHOT`, commits that, and pushes `HEAD` plus tags to `origin`. Running this task is the manual decision point that makes the release official.

Tags matching `v*` publish GitHub Release binaries for:

- Linux amd64/arm64
- macOS amd64/arm64
- Windows amd64/arm64

Release archive filenames include platform and architecture. The executable inside each archive intentionally uses the stable command name: `llama-nodrama` on Linux/macOS and `llama-nodrama.exe` on Windows. This keeps manual installs and package-manager installs consistent.

The install scripts consume those release assets. CI build artifacts from branch pushes are for validation only; public installs should use tagged releases. Normally you should not compile release binaries locally; push the tag and let the release workflow build and attach them to the GitHub Release.

The release workflow also attaches `HangryLabs.LlamaNodrama.winget.zip`, a Winget manifest bundle for the Windows amd64 and arm64 portable zips. To submit it to Winget, extract that bundle into the `microsoft/winget-pkgs` manifest path, validate it with `winget validate`, test it with `winget install --manifest`, and open the PR to the Winget community repository.

Windows release binaries include an application icon, manifest, and file properties generated from `nodrama/VERSION` by `go-winres`. The PNG icon source assets live in `nodrama/winres/icons/`; the resource generator preserves those files and only creates fallback placeholders when an expected size is missing. Windows binaries are not stripped so antivirus reputation systems have more normal debug metadata to inspect.

Raw Linux binaries do not carry desktop icons in the same way Windows `.exe` files do. Linux icons are normally supplied by packages (`.deb`, `.rpm`, AppImage, Flatpak, etc.) through a `.desktop` file and installed icon assets. The existing PNG source assets can be reused when Linux packaging is added.

Optional Authenticode signing is supported in the release workflow. Add these repository secrets to enable it:

- `WINDOWS_CODESIGN_PFX_BASE64`: base64-encoded `.pfx` signing certificate
- `WINDOWS_CODESIGN_PASSWORD`: password for the `.pfx`

Without those secrets, Windows binaries are built with icon/version resources but remain unsigned.

## License

MIT. Third-party attribution is recorded in [LICENSE](../../LICENSE).
