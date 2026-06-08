# llama.nodrama

**Leer en:** [🇺🇸 English](../../README.md) | [🇰🇷 한국어](README.ko-KR.md) | [🇯🇵 日本語](README.ja-JP.md) | [🇨🇳 简体中文](README.zh-CN.md) | [🇪🇸 Español](README.es-ES.md)

`llama.nodrama` es un pequeño panel escrito en Go para operar servidores `llama.cpp`. Existe porque ejecutar `llama.cpp` con varios slots no debería sentirse como ir a ciegas. La idea es simple: apúntalo a tu llama, obtén una vista visual clara y evita el drama.

El panel se centra en lo que cuesta ver solo con logs crudos: actividad de slots, flujo de consultas, cola de espera, rendimiento de tokens, reutilización de caché y líneas de tiempo de lo que cambió mientras el servidor estaba bajo carga. Sirve una UI web y una API backend tipada que organiza metrics, slots, requests, suggestions e historical values de `llama.cpp` en una vista en vivo.

Es especialmente útil en máquinas de presupuesto limitado, donde la concurrencia y el comportamiento de KV cache importan mucho. Si varios clientes tienen que compartir cómputo y memoria limitados, necesitas visibilidad para balancear slots, cache reuse, prompt processing y generation speed. `llama.nodrama` busca mostrar ese estado operativo sin convertir el monitoreo en otro proyecto.

## Vista previa de la UI

![llama.nodrama dashboard UI](../ui.jpg)

## Instalación

Linux y macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/master/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/master/install.ps1 | iex
```

El instalador de Windows copia `llama-nodrama.exe` a un directorio local del usuario y añade ese directorio al PATH del usuario. También actualiza la sesión actual de PowerShell, así que `llama-nodrama --help` debería funcionar inmediatamente después de instalar.

Ambos instaladores usan por defecto el GitHub Release más reciente. Para fijar una versión:

```sh
LLAMA_NODRAMA_VERSION=v0.1.0 sh ./install.sh
```

```powershell
$env:LLAMA_NODRAMA_VERSION = "v0.1.0"; .\install.ps1
```

## Ejecución

Inicia `llama-server` con los endpoints que el panel necesita:

```sh
llama-server --metrics
```

Después ejecuta el panel:

```sh
llama-nodrama --server http://127.0.0.1:8080 --listen :39080
```

Abre `http://127.0.0.1:39080`.

`llama.nodrama` todavía no detecta automáticamente servidores `llama.cpp`. Apúntalo al despliegue específico que quieres monitorear con `--server`; si `llama-server` corre en la misma máquina con el puerto habitual, el valor por defecto ya es `http://127.0.0.1:8080`.

También puedes cambiar ajustes en tiempo de ejecución desde el botón de configuración de la UI: server URL, log path, backend poll interval y upstream timeout. Cambiar el server o el log path reinicia el historial recopilado por el panel para que los datos antiguos y nuevos no se mezclen. El listen address y las raw proxy routes solo se configuran al inicio.

## Compilar desde el código fuente

```sh
cd nodrama
go test ./...
go build -o llama-nodrama .
```

Flags útiles:

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

La etiqueta de versión en la barra superior del panel enlaza al repositorio del proyecto. El backend comprueba periódicamente el GitHub Release más nuevo; cuando existe una versión más reciente, la etiqueta de versión se resalta y enlaza directamente a ese release.

Los logs de ejecución usan niveles explícitos (`INFO`, `WARN`, `ERROR`). Define `LLAMA_NODRAMA_DEBUG=1` para incluir logs detallados de endpoint probe.

## Privacidad

`llama.nodrama` se ejecuta localmente y no recopila, vende ni transmite datos de usuario a Hangry Labs. Consulta [PRIVACY.md](../../PRIVACY.md) para la declaración completa de privacidad.

## Releases

CI ejecuta Go formatting, vet, tests y cross-platform builds en pushes y pull requests a `master` y `main`.

La versión fuente está en `nodrama/VERSION`. Los snapshot builds usan `vX.Y.Z-SNAPSHOT`; los release tags usan la forma final `vX.Y.Z`.

Para crear un release:

```sh
task release
```

`task release` requiere un working tree limpio. Elimina `-SNAPSHOT`, crea commit y tag de esa versión final, luego incrementa la minor version al siguiente `vX.Y.0-SNAPSHOT`, crea otro commit y empuja `HEAD` más los tags a `origin`. Ejecutar esta tarea es el punto de decisión manual que hace oficial el release.

Los tags que coinciden con `v*` publican binarios de GitHub Release para:

- Linux amd64/arm64
- macOS amd64/arm64
- Windows amd64/arm64

Los nombres de los archives de release incluyen platform y architecture. El ejecutable dentro de cada archive usa intencionalmente el nombre de comando estable: `llama-nodrama` en Linux/macOS y `llama-nodrama.exe` en Windows. Esto mantiene consistentes las instalaciones manuales y las de package managers.

Los scripts de instalación consumen esos release assets. Los CI build artifacts de branch pushes son solo para validación. Las instalaciones públicas deben usar tagged releases. Normalmente no deberías compilar release binaries localmente; empuja el tag y deja que el release workflow los compile y los adjunte al GitHub Release.

El release workflow también adjunta `HangryLabs.LlamaNodrama.winget.zip`, un bundle de manifests Winget para los portable zips de Windows amd64 y arm64. Para enviarlo a Winget, extrae ese bundle en el manifest path de `microsoft/winget-pkgs`, valídalo con `winget validate`, pruébalo con `winget install --manifest` y abre el PR al repositorio comunitario de Winget.

Los binarios Windows de release incluyen application icon, manifest y file properties generados desde `nodrama/VERSION` por `go-winres`. Los PNG icon source assets están en `nodrama/winres/icons/`; el resource generator conserva esos archivos y solo crea fallback placeholders cuando falta un tamaño esperado. Los Windows binaries no se strippean para que los sistemas de reputación antivirus tengan metadata de debug más normal para inspeccionar.

Los binarios Linux crudos no llevan desktop icons del mismo modo que los `.exe` de Windows. En Linux, los iconos normalmente los aporta el paquete (`.deb`, `.rpm`, AppImage, Flatpak, etc.) mediante un archivo `.desktop` y assets de iconos instalados. Los PNG source assets existentes se pueden reutilizar cuando se agregue packaging para Linux.

El release workflow soporta Authenticode signing opcional. Agrega estos repository secrets para habilitarlo:

- `WINDOWS_CODESIGN_PFX_BASE64`: certificado de firma `.pfx` codificado en base64
- `WINDOWS_CODESIGN_PASSWORD`: contraseña del `.pfx`

Sin esos secrets, los binarios Windows se compilan con icon/version resources pero siguen sin firma.

## Licencia

MIT. La atribución de terceros está registrada en [LICENSE](../../LICENSE).
