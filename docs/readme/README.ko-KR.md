# llama.nodrama

**다른 언어로 읽기:** [🇺🇸 English](../../README.md) | [🇰🇷 한국어](README.ko-KR.md) | [🇯🇵 日本語](README.ja-JP.md) | [🇨🇳 简体中文](README.zh-CN.md) | [🇪🇸 Español](README.es-ES.md)

`llama.nodrama`는 `llama.cpp` 서버를 운영하기 위한 작은 Go 대시보드입니다. 여러 슬롯으로 `llama.cpp`를 실행할 때 상태를 추측으로 판단하지 않아도 되도록 만들었습니다. 목표는 단순합니다. 사용하는 llama 서버를 지정하면 명확한 시각적 개요를 보여 주고, 운영 중 불필요한 혼란을 줄입니다.

이 대시보드는 원시 로그만으로 보기 어려운 부분에 집중합니다. 슬롯 활동, 쿼리 흐름, 대기열, 토큰 처리량, 캐시 재사용, 부하가 걸린 동안 값이 어떻게 변했는지 보여 주는 타임라인을 한 화면에서 볼 수 있습니다. 브라우저 UI와 타입이 정의된 백엔드 API를 제공하며, `llama.cpp`의 metrics, slots, requests, suggestions, historical values를 하나의 실시간 뷰로 정리합니다.

예산이 제한된 머신에서 동시성과 KV 캐시 동작이 중요한 경우 특히 유용합니다. 여러 클라이언트가 제한된 연산 자원과 메모리를 공유해야 한다면 슬롯 균형, 캐시 재사용, 프롬프트 처리, 생성 속도를 조정하기 위한 가시성이 필요합니다. `llama.nodrama`는 모니터링 자체를 또 다른 프로젝트로 만들지 않고 운영 상태를 명확하게 보여 주기 위한 도구입니다.

## UI 미리보기

![llama.nodrama dashboard UI](../ui.jpg)

## 설치

Linux 및 macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/master/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/master/install.ps1 | iex
```

Windows 설치 스크립트는 `llama-nodrama.exe`를 사용자 로컬 설치 디렉터리에 복사하고 그 디렉터리를 사용자 PATH에 추가합니다. 현재 PowerShell 세션도 함께 업데이트하므로 설치 직후 `llama-nodrama --help`가 동작해야 합니다.

두 설치 스크립트는 기본적으로 최신 GitHub Release를 사용합니다. 특정 버전을 고정하려면 다음처럼 실행합니다.

```sh
LLAMA_NODRAMA_VERSION=v0.1.0 sh ./install.sh
```

```powershell
$env:LLAMA_NODRAMA_VERSION = "v0.1.0"; .\install.ps1
```

## 실행

대시보드가 필요한 엔드포인트를 사용할 수 있도록 `llama-server`를 시작합니다.

```sh
llama-server --metrics
```

그 다음 대시보드를 실행합니다.

```sh
llama-nodrama --server http://127.0.0.1:8080 --listen :39080
```

브라우저에서 `http://127.0.0.1:39080`을 엽니다.

`llama.nodrama`는 아직 `llama.cpp` 서버를 자동 탐색하지 않습니다. 모니터링하려는 배포를 `--server`로 명시하세요. `llama-server`가 같은 머신의 일반 포트에서 실행 중이라면 기본값은 이미 `http://127.0.0.1:8080`입니다.

시작 후 UI의 설정 버튼에서도 런타임 설정을 변경할 수 있습니다. 서버 URL, 로그 경로, 백엔드 폴링 간격, upstream timeout을 조정할 수 있습니다. 서버나 로그 경로를 변경하면 이전 대상과 새 대상의 데이터가 섞이지 않도록 수집된 대시보드 기록이 초기화됩니다. listen 주소와 raw proxy 라우트는 시작할 때만 설정할 수 있습니다.

## 소스에서 빌드

```sh
cd nodrama
go test ./...
go build -o llama-nodrama .
```

유용한 플래그:

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

대시보드 상단 바의 버전 라벨은 프로젝트 저장소로 연결됩니다. 백엔드는 주기적으로 최신 GitHub Release를 확인하며, 더 새 릴리스가 있으면 버전 라벨이 강조되고 해당 릴리스로 직접 연결됩니다.

런타임 로그는 명시적인 레벨(`INFO`, `WARN`, `ERROR`)을 사용합니다. 자세한 엔드포인트 probe 로그를 보려면 `LLAMA_NODRAMA_DEBUG=1`을 설정하세요.

## 개인정보

`llama.nodrama`는 로컬에서 실행되며 Hangry Labs로 사용자 데이터를 수집, 판매, 전송하지 않습니다. 전체 개인정보 안내는 [PRIVACY.md](../../PRIVACY.md)를 참고하세요.

## 릴리스

CI는 `master` 및 `main` 브랜치의 push와 pull request에서 Go formatting, vet, test, cross-platform build를 실행합니다.

소스 버전은 `nodrama/VERSION`에 있습니다. Snapshot 빌드는 `vX.Y.Z-SNAPSHOT` 형식을 사용하고, 릴리스 태그는 finalized `vX.Y.Z` 형식을 사용합니다.

릴리스를 만들려면:

```sh
task release
```

`task release`는 깨끗한 working tree가 필요합니다. 이 작업은 `-SNAPSHOT`을 제거하고 finalized 버전을 커밋 및 태그한 다음, minor 버전을 다음 `vX.Y.0-SNAPSHOT`으로 올리고 다시 커밋한 뒤 `HEAD`와 tags를 `origin`으로 push합니다. 이 작업을 실행하는 시점이 릴리스를 공식화하는 수동 결정 지점입니다.

`v*`와 일치하는 태그는 다음 GitHub Release 바이너리를 게시합니다.

- Linux amd64/arm64
- macOS amd64/arm64
- Windows amd64/arm64

릴리스 archive 파일명에는 platform과 architecture가 포함됩니다. 각 archive 안의 실행 파일은 안정적인 명령 이름을 사용합니다. Linux/macOS에서는 `llama-nodrama`, Windows에서는 `llama-nodrama.exe`입니다. 이렇게 하면 수동 설치와 package manager 설치가 일관됩니다.

설치 스크립트는 이 릴리스 asset을 사용합니다. 브랜치 push에서 생성되는 CI build artifact는 검증용입니다. 공개 설치는 tagged release를 사용해야 합니다. 일반적으로 릴리스 바이너리를 로컬에서 직접 컴파일하지 말고, 태그를 push한 뒤 release workflow가 GitHub Release에 빌드 결과를 첨부하도록 두는 것이 좋습니다.

release workflow는 Windows amd64 및 arm64 portable zip용 Winget manifest bundle인 `HangryLabs.LlamaNodrama.winget.zip`도 첨부합니다. Winget에 제출하려면 이 bundle을 `microsoft/winget-pkgs` manifest path에 압축 해제하고, `winget validate`로 검증하고, `winget install --manifest`로 테스트한 뒤 Winget community repository에 PR을 열면 됩니다.

Windows 릴리스 바이너리에는 `go-winres`가 `nodrama/VERSION`을 사용해 생성한 application icon, manifest, file properties가 포함됩니다. PNG icon source asset은 `nodrama/winres/icons/`에 있습니다. resource generator는 해당 파일을 보존하며 필요한 크기가 없을 때만 fallback placeholder를 생성합니다. Windows 바이너리는 antivirus reputation 시스템이 일반적인 debug metadata를 확인할 수 있도록 strip하지 않습니다.

원시 Linux 바이너리는 Windows `.exe`와 같은 방식으로 desktop icon을 포함하지 않습니다. Linux icon은 일반적으로 package(`.deb`, `.rpm`, AppImage, Flatpak 등)가 `.desktop` 파일과 설치된 icon asset을 통해 제공합니다. Linux packaging을 추가할 때 기존 PNG source asset을 재사용할 수 있습니다.

선택적 Authenticode signing은 release workflow에서 지원됩니다. 사용하려면 repository secret을 추가하세요.

- `WINDOWS_CODESIGN_PFX_BASE64`: base64로 인코딩한 `.pfx` signing certificate
- `WINDOWS_CODESIGN_PASSWORD`: `.pfx` password

이 secret이 없으면 Windows 바이너리는 icon/version resource를 포함하지만 unsigned 상태로 빌드됩니다.

## 라이선스

MIT. Third-party attribution은 [LICENSE](../../LICENSE)에 기록되어 있습니다.
