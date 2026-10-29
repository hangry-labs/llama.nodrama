<p align="center">
  <img src="../../assets/llama-nodrama_logo.webp" alt="llama.nodrama by HangryLabs" width="720">
</p>

**Leer en:** [🇺🇸 English](../../README.md) | [🇰🇷 한국어](README.ko-KR.md) | [🇯🇵 日本語](README.ja-JP.md) | [🇨🇳 简体中文](README.zh-CN.md) | [🇪🇸 Español](README.es-ES.md)

Versión de desarrollo: **v0.6.0-SNAPSHOT**. [Historial de versiones](../../README.md#version-history).

`llama.nodrama` es un pequeño panel escrito en Go para operar servidores `llama.cpp`. Existe porque ejecutar `llama.cpp` con varios slots no debería sentirse como ir a ciegas. La idea es simple: apúntalo a tu llama, obtén una vista visual clara y evita el drama.

El panel se centra en lo que cuesta ver solo con logs crudos: actividad de slots, flujo de consultas, cola de espera, rendimiento de tokens, reutilización de caché y líneas de tiempo de lo que cambió mientras el servidor estaba bajo carga. Sirve una UI web y una API backend tipada que organiza metrics, slots, requests, suggestions e historical values de `llama.cpp` en una vista en vivo.

Es especialmente útil en máquinas de presupuesto limitado, donde la concurrencia y el comportamiento de KV cache importan mucho. Si varios clientes tienen que compartir cómputo y memoria limitados, necesitas visibilidad para balancear slots, cache reuse, prompt processing y generation speed. `llama.nodrama` busca mostrar ese estado operativo sin convertir el monitoreo en otro proyecto.

## Vista previa de la UI

![llama.nodrama dashboard UI](../ui.webp)

## Instalación

Linux y macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/hangry-labs/llama.nodrama/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hangry-labs/llama.nodrama/main/install.ps1 | iex
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

Las versiones publicadas incluyen binarios para Linux, macOS y Windows en amd64 y arm64, junto con sumas de comprobación. Los instaladores usan la última versión estable publicada de forma predeterminada. Los artefactos de CI de las ramas son compilaciones de desarrollo.

[Historial y descargas publicadas](../../README.md#version-history) · [Guía de preparación y publicación de versiones (inglés)](../RELEASING.md).

## Licencia

El código fuente y la documentación del proyecto están bajo la [Licencia MIT](../../LICENSE). Los logotipos, mascotas, badges, iconos y demás arte de marca están excluidos de MIT y se rigen por [BRAND_ASSETS.md](../../BRAND_ASSETS.md). Los textos de licencia y las atribuciones de terceros requeridos se registran en [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). El workflow de release incluye los tres archivos en los nuevos archives que genera.
