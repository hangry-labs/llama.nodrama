<p align="center">
  <img src="../../assets/llama-nodrama_logo.webp" alt="llama.nodrama by HangryLabs" width="720">
</p>

**选择语言:** [🇺🇸 English](../../README.md) | [🇰🇷 한국어](README.ko-KR.md) | [🇯🇵 日本語](README.ja-JP.md) | [🇨🇳 简体中文](README.zh-CN.md) | [🇪🇸 Español](README.es-ES.md)

开发版本：**v0.6.0-SNAPSHOT**。[版本历史](../../README.md#version-history)。

`llama.nodrama` 是一个用于运维 `llama.cpp` 服务器的小型 Go 仪表盘。它的出发点很简单：当你用多个 slot 运行 `llama.cpp` 时，不应该靠猜来判断系统状态。把它指向你的 llama 服务器，就能得到清晰的可视化概览，减少运维中的混乱。

这个仪表盘关注原始日志里很难直接看清的内容：slot 活动、query 流程、队列压力、token 吞吐、缓存复用，以及服务器在负载下各项数值如何变化的时间线。它提供浏览器 UI 和带类型的后端 API，把 `llama.cpp` 的 metrics、slots、requests、suggestions 和 historical values 整理到一个实时视图里。

这对预算有限的机器尤其有用，因为并发和 KV cache 行为会直接影响体验。如果多个客户端需要共享有限的算力和内存，你就需要可见性来平衡 slots、cache reuse、prompt processing 和 generation speed。`llama.nodrama` 的目标是把运行状态讲清楚，而不是让监控本身变成另一个项目。

## UI 预览

![llama.nodrama dashboard UI](../ui.webp)

## 安装

Linux 和 macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/main/install.ps1 | iex
```

Windows 安装脚本会把 `llama-nodrama.exe` 复制到用户本地安装目录，并把该目录加入用户 PATH。当前 PowerShell 会话也会同步更新，因此安装后应能立即运行 `llama-nodrama --help`。

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

公开发布包含 Linux、macOS 和 Windows 的 amd64 / arm64 二进制文件及校验和。安装脚本默认使用最新公开的稳定版本。分支 CI 构建产物属于开发版本。

[版本历史与下载](../../README.md#version-history) · [发布准备与发布指南（英文）](../RELEASING.md)。

## 许可证

项目源代码和文档采用 [MIT License](../../LICENSE)。Logo、吉祥物、badge、icon 及其他品牌图稿不属于 MIT 授权范围，而由 [BRAND_ASSETS.md](../../BRAND_ASSETS.md) 管理。所需的 third-party license text 和 attribution 记录在 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) 中。release workflow 会在新生成的 archives 中包含这三个文件。
