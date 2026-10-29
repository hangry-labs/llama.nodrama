<p align="center">
  <img src="../../assets/llama-nodrama_logo.webp" alt="llama.nodrama by HangryLabs" width="720">
</p>

**他の言語で読む:** [🇺🇸 English](../../README.md) | [🇰🇷 한국어](README.ko-KR.md) | [🇯🇵 日本語](README.ja-JP.md) | [🇨🇳 简体中文](README.zh-CN.md) | [🇪🇸 Español](README.es-ES.md)

開発バージョン: **v0.6.0-SNAPSHOT**。[バージョン履歴](../../README.md#version-history)。

`llama.nodrama` は `llama.cpp` サーバーを運用するための小さな Go ダッシュボードです。複数スロットで `llama.cpp` を動かすときに、状態を推測だけで判断しなくて済むように作られています。目的は単純です。自分の llama サーバーを指定すると、わかりやすい視覚的な概要が表示され、運用中の余計な混乱を減らします。

このダッシュボードは、生ログだけでは見えにくい情報に集中します。スロットの活動、クエリの流れ、キュー、トークン処理量、キャッシュ再利用、負荷中に値がどう変化したかを示すタイムラインを確認できます。ブラウザー UI と型付きバックエンド API を提供し、`llama.cpp` の metrics、slots、requests、suggestions、historical values を 1 つのライブビューに整理します。

低予算のマシンで、並行処理と KV キャッシュの挙動が重要な場合に特に役立ちます。複数のクライアントが限られた計算資源とメモリを共有する場合、スロットのバランス、キャッシュ再利用、プロンプト処理、生成速度を調整するには可視性が必要です。`llama.nodrama` は、監視そのものを別プロジェクトにせず、運用状況を明確にするためのツールです。

## UI プレビュー

![llama.nodrama dashboard UI](../ui.webp)

## インストール

Linux と macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/main/install.ps1 | iex
```

Windows インストーラーは `llama-nodrama.exe` をユーザーのローカルインストールディレクトリにコピーし、そのディレクトリをユーザー PATH に追加します。現在の PowerShell セッションも更新されるため、インストール直後に `llama-nodrama --help` が使えるはずです。

どちらのインストーラーも、既定では最新の GitHub Release を使用します。バージョンを固定する場合:

```sh
LLAMA_NODRAMA_VERSION=v0.1.0 sh ./install.sh
```

```powershell
$env:LLAMA_NODRAMA_VERSION = "v0.1.0"; .\install.ps1
```

## 実行

ダッシュボードが必要とするエンドポイントを有効にして `llama-server` を起動します。

```sh
llama-server --metrics
```

次にダッシュボードを起動します。

```sh
llama-nodrama --server http://127.0.0.1:8080 --listen :39080
```

`http://127.0.0.1:39080` を開きます。

`llama.nodrama` は、まだ `llama.cpp` サーバーを自動検出しません。監視したいデプロイ先を `--server` で指定してください。`llama-server` が同じマシンの一般的なポートで動いている場合、既定値はすでに `http://127.0.0.1:8080` です。

起動後は UI の設定ボタンからランタイム設定も変更できます。server URL、log path、backend poll interval、upstream timeout を変更できます。server または log path を変更すると、古い対象と新しい対象の履歴が混ざらないように、収集済みのダッシュボード履歴がリセットされます。listen address と raw proxy routes は起動時にのみ設定できます。

## ソースからビルド

```sh
cd nodrama
go test ./...
go build -o llama-nodrama .
```

便利なフラグ:

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

ダッシュボード上部バーのバージョンラベルはプロジェクト repository にリンクしています。バックエンドは定期的に最新の GitHub Release を確認し、より新しい release がある場合はバージョンラベルを強調表示して、その release へ直接リンクします。

ランタイムログは明示的なレベル (`INFO`, `WARN`, `ERROR`) を使用します。詳細な endpoint probe ログを含めるには `LLAMA_NODRAMA_DEBUG=1` を設定してください。

## プライバシー

`llama.nodrama` はローカルで動作し、Hangry Labs にユーザーデータを収集、販売、送信しません。完全なプライバシー文書は [PRIVACY.md](../../PRIVACY.md) を参照してください。

## リリース

公開リリースには Linux、macOS、Windows 向けの amd64 / arm64 バイナリとチェックサムが含まれます。インストーラーは既定で最新の公開安定版を使用します。ブランチの CI アーティファクトは開発ビルドです。

[バージョン履歴とダウンロード](../../README.md#version-history) · [リリース準備と公開ガイド (英語)](../RELEASING.md)。

## ライセンス

プロジェクトの source code と documentation は [MIT License](../../LICENSE) で提供されます。ロゴ、マスコット、badge、icon、その他の brand artwork は MIT の対象外であり、[BRAND_ASSETS.md](../../BRAND_ASSETS.md) に従います。必要な third-party license text と attribution は [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) に記録されます。release workflow は、新しく生成する archive に 3 つのファイルすべてを含めます。
