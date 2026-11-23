# Releases and version history

The root [README version history](../README.md#version-history) records product
changes. Reviewed pushes to `main` publish **normal immutable numbered releases**
after CI passes, following the distribution approach used by
[Listen2Me](https://github.com/hangry-labs/Listen2Me/releases).

## Version numbers

Routine releases advance the last number: `v0.6.0`, `v0.6.1`, `v0.6.2`.
Changing to `v0.7.0` or `v1.0.0` is a deliberate product decision.

`nodrama/VERSION` defines the source development line and minimum patch. For
example, `v0.6.0-SNAPSHOT` allows CI to select the next unused `v0.6.x` number,
starting at `v0.6.0`. Source builds can still show the snapshot version. CI writes
the selected regular version only in its runner checkout before building, so
the executable, Windows file/product properties, update metadata, release tag
and Winget manifests all use the actual published number. No version-bump commit
or manually created tag is needed for routine releases.

The planner reads all regular releases, drafts and existing version tags;
previews do not select the release number. It reuses an interrupted draft for
the same commit, skips a commit already published, and avoids reusing reserved
tags. Version allocation through publication runs in one serialized job. A stale
main build is skipped; it cannot replace a newer main build. A draft older than
an already published version is not promoted over it.

To select a new product/version line, change `nodrama/VERSION` and the README
development heading deliberately, then refresh resources with `task windows-res`.
The planner rejects a source line older than the newest regular release.

## Publish reviewed changes

1. Review the implementation, user-visible README notes and checks.
2. Commit and push reviewed changes to `main` using the owner's normal process.
3. CI checks Go/UI on Linux, Windows and macOS, Linux race tests, Chromium
   behavior, and offline release staging/version/manifest tests.
4. Once checks pass, CI calls the [release workflow](../.github/workflows/release.yml)
   to select the patch, build all six archives and stage a draft with its assets.
5. The complete draft is published as a regular release and marked Latest.

Pull requests run checks and six-platform cross-builds without publishing.
Publication uses the repository's GitHub token; no personal access token is
needed. Existing immutable releases and tags remain untouched.

Local checks from the repository root:

```sh
task check
task check-browser
```

`task release` runs readiness checks and explains the automatic version policy.
It does not commit, tag, fetch, push or publish. `task release DRY_RUN=1` explains
the source version line without building, checking, contacting GitHub or changing
files/refs. The exact next number is selected from live inventory inside CI.

## Downloads and updates

| Platform | Architectures | Archive |
| --- | --- | --- |
| Linux | amd64, arm64 | `llama-nodrama-linux-<arch>.tar.gz` |
| macOS | amd64, arm64 | `llama-nodrama-darwin-<arch>.tar.gz` |
| Windows | amd64, arm64 | `llama-nodrama-windows-<arch>.zip` |

Each archive contains `llama-nodrama` (or `llama-nodrama.exe`), `LICENSE`,
`BRAND_ASSETS.md` and `THIRD_PARTY_NOTICES.md`. The release also attaches those
notices, `SHA256SUMS`, `update.json` with platform/download/size/SHA-256 metadata,
and `HangryLabs.LlamaNodrama.winget.zip`. Generated notes compare with the previous
regular release rather than a legacy preview tag. The install scripts and
`/releases/latest` now follow the same regular releases as the UI.

The version label opens **Updates** without contacting GitHub. Click **↻** or
**Check for updates** to check the latest regular release. A newer version
highlights the label and exposes **Update now**. Only that explicit click starts
download, verification, replacement and restart. There is one release stream.

The dashboard host needs internet access and write permission to the installation
folder. The updater validates source URLs, size, SHA-256, application identity
and platform, keeps the previous executable as `llama-nodrama.previous` (or
`llama-nodrama.exe.previous`), and restarts with the same arguments. Settings
persist; in-memory history and peaks reset. Unix replaces the process in place;
Windows starts the replacement after the listener closes.

For an older installed build that still offers channels, select **Stable release**
once to install the first regular release. Newly installed code also accepts
old browser `channel=preview` requests as an alias for the regular release stream.
Existing `preview` and `preview-<commit>` releases remain immutable historical
artifacts; CI no longer creates them, and the new updater does not discover them.

## Retry and verify

An upload failure leaves a draft. Rerun the failed workflow to resume the same
draft/version for that commit; only draft assets can be replaced. Already
published commits skip publication. A release belonging to another commit is
never modified. Correct a published build with a new commit and patch version.

After CI finishes, verify the release is regular, public, immutable and Latest;
all six archives and metadata exist; checksums match; and a downloaded binary
reports the release version. Then record its actual publication date and release
link in README history. Do not label planned downloads as published. Keep locale
READMEs under `docs/readme/`, linking the canonical history and this guide.

## Windows resources, signing and Winget

Windows executables include an icon, manifest and version properties generated
from `nodrama/VERSION`. Icon sources are WebP in `nodrama/winres/icons/`;
`tools/windowsres` decodes them to ignored PNG build intermediates for
`go-winres`. Windows binaries retain debug metadata rather than being stripped.
Linux desktop packages and desktop-icon installation are not currently shipped.

Optional Authenticode signing uses these repository secrets:

- `WINDOWS_CODESIGN_PFX_BASE64`: base64-encoded signing certificate (`.pfx`).
- `WINDOWS_CODESIGN_PASSWORD`: its password.

Without those secrets the binaries remain unsigned. These signing credentials
belong in GitHub secrets, never in source files or public release notes.

The Winget bundle describes the amd64 and arm64 portable ZIPs. Publication on
GitHub does not submit it to Winget. For a separate Winget submission, extract
the bundle into the `microsoft/winget-pkgs` manifest layout, validate with
`winget validate`, test with `winget install --manifest`, and submit the reviewed
manifests through that repository's process.
