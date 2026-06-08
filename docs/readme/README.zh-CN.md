# llama.nodrama

**选择语言:** [🇺🇸 English](../../README.md) | [🇰🇷 한국어](README.ko-KR.md) | [🇯🇵 日本語](README.ja-JP.md) | [🇨🇳 简体中文](README.zh-CN.md) | [🇪🇸 Español](README.es-ES.md)

`llama.nodrama` 是一个用于运维 `llama.cpp` 服务器的小型 Go 仪表盘。它的出发点很简单：当你用多个 slot 运行 `llama.cpp` 时，不应该靠猜来判断系统状态。把它指向你的 llama 服务器，就能得到清晰的可视化概览，减少运维中的混乱。

这个仪表盘关注原始日志里很难直接看清的内容：slot 活动、query 流程、队列压力、token 吞吐、缓存复用，以及服务器在负载下各项数值如何变化的时间线。它提供浏览器 UI 和带类型的后端 API，把 `llama.cpp` 的 metrics、slots、requests、suggestions 和 historical values 整理到一个实时视图里。

这对预算有限的机器尤其有用，因为并发和 KV cache 行为会直接影响体验。如果多个客户端需要共享有限的算力和内存，你就需要可见性来平衡 slots、cache reuse、prompt processing 和 generation speed。`llama.nodrama` 的目标是把运行状态讲清楚，而不是让监控本身变成另一个项目。

## UI 预览

![llama.nodrama dashboard UI](../ui.jpg)

## 安装

Linux 和 macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/master/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/master/install.ps1 | iex
```

两个安装脚本默认使用最新的 GitHub Release。如需固定版本：

```sh
LLAMA_NODRAMA_VERSION=v0.1.0 sh ./install.sh
```

```powershell
$env:LLAMA_NODRAMA_VERSION = "v0.1.0"; .\install.ps1
```

## 运行

启动 `llama-server`，并启用仪表盘需要的端点：

```sh
llama-server --metrics
```

然后运行仪表盘：

```sh
llama-nodrama --server http://127.0.0.1:8080 --listen :39080
```

打开 `http://127.0.0.1:39080`。

`llama.nodrama` 目前还不会自动发现 `llama.cpp` 服务器。请用 `--server` 指向你要监控的具体部署。如果 `llama-server` 在同一台机器上使用常见端口运行，默认值已经是 `http://127.0.0.1:8080`。

启动后，你也可以通过 UI 的设置按钮修改运行时设置：server URL、log path、backend poll interval 和 upstream timeout。修改 server 或 log path 会重置已收集的仪表盘历史，避免旧目标和新目标的数据混在一起。listen address 和 raw proxy routes 只能在启动时配置。

## 从源码构建

```sh
cd nodrama
go test ./...
go build -o llama-nodrama .
```

常用参数：

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

仪表盘顶部栏的版本标签会链接到项目仓库。后端会定期检查最新的 GitHub Release；如果发现更新版本，版本标签会高亮并直接链接到该 release。

运行时日志使用明确的等级 (`INFO`, `WARN`, `ERROR`)。设置 `LLAMA_NODRAMA_DEBUG=1` 可以包含详细的 endpoint probe 日志。

## 隐私

`llama.nodrama` 在本地运行，不会向 Hangry Labs 收集、出售或传输用户数据。完整隐私说明见 [PRIVACY.md](../../PRIVACY.md)。

## 发布

CI 会在推送和 pull request 到 `master` 与 `main` 时运行 Go formatting、vet、tests 和 cross-platform builds。

源码版本位于 `nodrama/VERSION`。Snapshot builds 使用 `vX.Y.Z-SNAPSHOT`，release tags 使用 finalized `vX.Y.Z` 格式。

创建 release：

```sh
task release
```

`task release` 要求 working tree 是干净的。它会移除 `-SNAPSHOT`，提交并标记 finalized version，然后把 minor version 增加到下一个 `vX.Y.0-SNAPSHOT`，再次提交，并把 `HEAD` 和 tags 推送到 `origin`。运行这个任务就是正式发布 release 的人工决定点。

匹配 `v*` 的 tag 会发布以下 GitHub Release binaries：

- Linux amd64/arm64
- macOS amd64/arm64
- Windows amd64/arm64

Release archive 文件名包含 platform 和 architecture。每个 archive 内部的 executable 使用稳定的命令名：Linux/macOS 为 `llama-nodrama`，Windows 为 `llama-nodrama.exe`。这样手动安装和 package-manager 安装保持一致。

安装脚本会使用这些 release assets。分支 push 产生的 CI build artifacts 只用于验证。公开安装应使用 tagged releases。通常不需要在本地编译 release binaries；推送 tag，让 release workflow 构建并附加到 GitHub Release 即可。

release workflow 还会附加 `HangryLabs.LlamaNodrama.winget.zip`，这是用于 Windows amd64 和 arm64 portable zips 的 Winget manifest bundle。提交到 Winget 时，把该 bundle 解压到 `microsoft/winget-pkgs` manifest path，使用 `winget validate` 验证，使用 `winget install --manifest` 测试，然后向 Winget community repository 提交 PR。

Windows release binaries 包含 application icon、manifest 和 file properties，这些由 `go-winres` 根据 `nodrama/VERSION` 生成。PNG icon source assets 位于 `nodrama/winres/icons/`；resource generator 会保留这些文件，只在缺少预期尺寸时创建 fallback placeholders。Windows binaries 不会被 strip，以便 antivirus reputation systems 能检查更常见的 debug metadata。

原始 Linux binaries 不像 Windows `.exe` 那样携带 desktop icons。Linux icons 通常由 package (`.deb`, `.rpm`, AppImage, Flatpak 等) 通过 `.desktop` file 和 installed icon assets 提供。以后添加 Linux packaging 时，可以复用现有 PNG source assets。

release workflow 支持可选的 Authenticode signing。添加以下 repository secrets 即可启用：

- `WINDOWS_CODESIGN_PFX_BASE64`: base64 编码的 `.pfx` signing certificate
- `WINDOWS_CODESIGN_PASSWORD`: `.pfx` password

如果没有这些 secrets，Windows binaries 会包含 icon/version resources，但仍然是 unsigned。

## 许可证

MIT。Third-party attribution 记录在 [LICENSE](../../LICENSE)。
