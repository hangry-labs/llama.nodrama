# llama.nodrama

`llama.nodrama` is a small Go dashboard for operating `llama.cpp` servers. It
serves a browser UI, proxies selected llama.cpp endpoints, and normalizes slot
and metrics data so concurrency, queueing, and token throughput are easier to
inspect.

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
--poll     polling interval, default 1s
--timeout  upstream request timeout, default 5s
--version  print build version and exit
```

## Releases

CI runs Go formatting, vet, tests, and cross-platform builds on pushes and pull
requests to `master` and `main`.

Tags matching `v*` publish GitHub Release binaries for:

- Linux amd64/arm64
- macOS amd64/arm64
- Windows amd64/arm64

The install scripts consume those release assets. CI build artifacts from branch
pushes are for validation only; public installs should use tagged releases.

## License

MIT. Third-party attribution is recorded in `LICENSE`.
