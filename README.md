# llama.nodrama

`llama.nodrama` is a small Go dashboard for operating `llama.cpp` servers. It
serves a browser UI and a typed backend API that normalizes slots, metrics,
requests, suggestions, and timelines so concurrency, queueing, and token
throughput are easier to inspect.

## UI Preview

![llama.nodrama dashboard UI](docs/ui.jpg)

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
llama-nodrama --server http://127.0.0.1:18080 --listen :39080
```

Open `http://127.0.0.1:39080`.

`llama.nodrama` does not auto-discover `llama.cpp` servers yet. Point it at the
specific deployment you want to monitor with `--server`; if `llama-server` runs
on the same machine with the usual port, the default is already
`http://127.0.0.1:18080`.

You can also change runtime settings from the UI settings button after startup:
server URL, log path, backend poll interval, and upstream timeout. Changing the
server or log path resets collected dashboard history so old and new targets do
not mix. The listen address and raw proxy routes are startup-only settings.

## Build From Source

```sh
cd nodrama
go test ./...
go build -o llama-nodrama .
```

Useful flags:

```text
--server   llama.cpp server base URL, default http://127.0.0.1:18080
--listen   dashboard listen address, default :39080
--log        optional llama.cpp log file path for /api/logs/tail
--poll       polling interval, default 1s
--raw-proxy  expose selected raw llama.cpp proxy routes for debugging
--timeout    upstream request timeout, default 5s
--version    print build version and exit
```

## Releases

CI runs Go formatting, vet, tests, and cross-platform builds on pushes and pull
requests to `master` and `main`.

The source version lives in `nodrama/VERSION`. Snapshot builds use
`vX.Y.Z-SNAPSHOT`; release tags use the finalized `vX.Y.Z` form.

To cut a release:

```sh
task release
```

`task release` requires a clean working tree. It removes `-SNAPSHOT`, commits
and tags that finalized version, then bumps the minor version to the next
`vX.Y.0-SNAPSHOT`, commits that, and pushes `HEAD` plus tags to `origin`.
Running this task is the manual decision point that makes the release official.

Tags matching `v*` publish GitHub Release binaries for:

- Linux amd64/arm64
- macOS amd64/arm64
- Windows amd64/arm64

The install scripts consume those release assets. CI build artifacts from branch
pushes are for validation only; public installs should use tagged releases.
Normally you should not compile release binaries locally; push the tag and let
the release workflow build and attach them to the GitHub Release.

## License

MIT. Third-party attribution is recorded in `LICENSE`.
