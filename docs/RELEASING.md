# Releases and version history

The root [README version history](../README.md#version-history) is the public
record of development changes and published releases. `nodrama/VERSION` is the
source version. Keep this project's `vX.Y.Z-SNAPSHOT` / `vX.Y.Z` format.

## Development and published releases

| Source | Meaning | Installation |
| --- | --- | --- |
| `main`, `vX.Y.Z-SNAPSHOT` | Moving development source | Build from source or install a tested preview |
| `preview-<full commit>` | Immutable tested build from `main` | Select **Latest tested preview** in Updates |
| Stable `vX.Y.Z` tag | Release source passed to the publishing workflow | Use its GitHub Release after downloads are published and verified |
| GitHub Releases `latest` | Newest published stable release selected by GitHub | Default used by the install scripts; it is a moving selection |

Stable tags publish release archives. Successful pushes to `main` also publish
an immutable **preview** for that commit with the six tested binaries and an
`update.json` manifest. Pull requests validate without publishing. No container
images are published.

Routine stable releases advance the last number within the current version
line: `v0.6.0`, `v0.6.1`, `v0.6.2`. Moving to `v0.7.0` or `v1.0.0` is a
deliberate product decision, not an automatic consequence of publishing.
Previews retain the current snapshot version and use the full commit for
their unique build identity; testing does not consume stable version numbers.

## Test new builds without a stable release

Push reviewed changes to `main`. Once checks, browser tests and all six builds
pass, CI creates the `preview-<full commit>` prerelease automatically. The
dashboard's version link opens **Updates**; select **Latest tested preview**,
click **Check for updates**, then choose **Update now**. The header's **↻**
button also starts an explicit check. Opening the dialog or changing its channel
does not contact GitHub. Preview identity uses the commit, so newer
snapshots do not need a version bump or manual Git tag. The first preview
becomes available after this workflow has been pushed and completed.

The manifest follows the same version/download/size/SHA-256 approach used by
[Listen2Me](https://github.com/hangry-labs/Listen2Me), with platform selection
for this Go application. Each build is staged as a draft with all binaries,
notices, checksums and manifest attached, then published once. Published tags
and assets stay unchanged. The updater discovers the most recently published
immutable preview with a manifest among the 500 most recent releases, skipping
drafts, incomplete releases and the legacy `preview` tag. It pins the manifest
and binary to the selected commit's release. An older CI run is skipped if
`main` has advanced. Stable release tags remain separate.

Updates are fetched and verified by the dashboard host, which must have internet
access and write permission to the installation folder. The updater validates
the Go application identity and platform, keeps the previous executable as
`llama-nodrama.previous` (or `llama-nodrama.exe.previous`) and restarts with the
same arguments. Settings persist; in-memory history and peaks reset. On Unix,
restart replaces the process in place so a service manager keeps its main PID.
Windows launches the replacement after the listener closes. Installations
without write permission report an error; use the existing administrator or
package-management process for those deployments.

## Keep the README current

During development, add concise, user-visible changes to the open snapshot
section. Describe final behavior, fixes and material limits. Group related
commits rather than copying the Git log or internal implementation history.

For a release, retain its notes under its stable version. Once publication
finishes, record the actual publication date and link to the GitHub Release
and source tag. Do not label a planned version as published or invent download
links, checksums or validation results. Keep older notes in collapsed sections.
Open a new snapshot section for subsequent development and update the version
near the README title to match `nodrama/VERSION`.

Keep language files in `docs/readme/`. Their release sections link to this guide
and the canonical version history rather than maintaining separate release
procedures that can drift.

## Prepare a release

Qualify changes during development. The normal CI workflow checks Go and UI
behavior on Linux, Windows and macOS, runs Linux race tests and Chromium
regressions, and cross-builds all six supported targets. Offline release tests
exercise draft staging, retries and immutable manifests without contacting
GitHub. The release workflow runs Go/UI and release tests again before packaging.

Before promotion, review the version history and checks, use a clean `main`
synchronized with `origin/main`, and confirm the intended stable tag is unused.
Run checks from the repository root:

```sh
task check
```

`task check-browser` runs Chromium regressions when browser behavior changed.
Release preparation should not require building distributable archives for
all platforms locally; GitHub Actions handles those builds.

Preview a stable promotion without changing files, building binaries, fetching
refs, committing, tagging or pushing:

```sh
task release DRY_RUN=1
```

For a qualified stable candidate, the promotion command is:

```sh
task release
```

This is a publishing action, not a preview. The current Go tool requires a
clean synchronized `main`, fetches remote refs, checks that the stable tag is
unused and runs `tools/check`, then:

1. Removes `-SNAPSHOT` from `nodrama/VERSION` and refreshes Windows resources.
2. Commits the release and creates its annotated stable tag.
3. Advances the last number to `vX.Y.(Z+1)-SNAPSHOT`, refreshes resources and commits.
4. Atomically pushes `main` and that exact annotated tag to `origin`.

For example, `v0.6.0-SNAPSHOT` promotes to `v0.6.0` and opens
`v0.6.1-SNAPSHOT`. To start a different version line, deliberately change
`nodrama/VERSION` and the README snapshot section before promotion, and refresh
Windows resources with `task windows-res`. The command returns after the Git
push; it does not wait for GitHub Actions to build or publish downloads.

The tool does not update README release history or published download pointers;
review those explicitly. `NEXT_VERSION` and `SKIP_VALIDATION` overrides are not
implemented. `DRY_RUN=1` previews the version/ref plan even in a dirty checkout.

If a step fails, inspect the working tree and local/remote refs before retrying.
Do not rerun promotion blindly or move an already published tag. If the atomic
push fails, inspect refs and use the exact retry command printed by the tool.
No unrelated annotated tags are pushed.

## Publication and verification

The [release workflow](../.github/workflows/release.yml) runs on `v*` tag pushes
and requires the tag to match `nodrama/VERSION` at that commit. It builds:

| Platform | Architectures | Archive |
| --- | --- | --- |
| Linux | amd64, arm64 | `llama-nodrama-linux-<arch>.tar.gz` |
| macOS | amd64, arm64 | `llama-nodrama-darwin-<arch>.tar.gz` |
| Windows | amd64, arm64 | `llama-nodrama-windows-<arch>.zip` |

Executables inside archives use the stable name `llama-nodrama`, or
`llama-nodrama.exe` on Windows. Newly built archives include `LICENSE`,
`BRAND_ASSETS.md` and `THIRD_PARTY_NOTICES.md`. The workflow also attaches
`SHA256SUMS` and `HangryLabs.LlamaNodrama.winget.zip`.

After Actions completes, verify the release is public, all six archives exist,
checksums match, and a downloaded binary reports the intended `--version`.
Then update the README's latest published release and publication date. A tag
or successful branch CI run alone does not establish download availability.

Both workflows create a draft, upload the complete asset set and then publish,
so repository release immutability can remain enabled. A retry can replace
assets only while the release is still a draft. Rerunning a published tag skips
publication and leaves its tag and assets untouched. Use a new patch version
or preview commit for corrections; do not move tags or overwrite published
downloads. The empty legacy `preview` release does not need to be modified for
new previews to work.

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
