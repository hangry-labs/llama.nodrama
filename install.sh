#!/usr/bin/env sh
set -eu

repo="${LLAMA_NODRAMA_REPO:-hangry-labs/llama.nodrama}"
version="${LLAMA_NODRAMA_VERSION:-latest}"

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

download() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    fail "missing downloader: install curl or wget"
  fi
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo ""
  fi
}

install_file() {
  src="$1"
  dst="$2"
  dir="$(dirname "$dst")"
  if [ -w "$dir" ]; then
    if command -v install >/dev/null 2>&1; then
      install -m 0755 "$src" "$dst"
    else
      cp "$src" "$dst"
      chmod 0755 "$dst"
    fi
  elif command -v sudo >/dev/null 2>&1; then
    sudo install -m 0755 "$src" "$dst"
  else
    fail "$dir is not writable and sudo is unavailable"
  fi
}

os="$(detect_os)"
arch="$(detect_arch)"
ext=""
archive_ext="tar.gz"
if [ "$os" = "windows" ]; then
  ext=".exe"
  archive_ext="zip"
fi

asset="llama-nodrama-${os}-${arch}.${archive_ext}"
binary="llama-nodrama-${os}-${arch}${ext}"

if [ "$version" = "latest" ]; then
  base_url="https://github.com/${repo}/releases/latest/download"
else
  base_url="https://github.com/${repo}/releases/download/${version}"
fi

if [ -n "${LLAMA_NODRAMA_INSTALL_DIR:-}" ]; then
  install_dir="$LLAMA_NODRAMA_INSTALL_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  install_dir="/usr/local/bin"
else
  install_dir="${HOME}/.local/bin"
fi

tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t llama-nodrama)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

archive_path="${tmp_dir}/${asset}"
sums_path="${tmp_dir}/SHA256SUMS"

echo "Downloading ${repo} ${version} ${os}/${arch}..."
download "${base_url}/${asset}" "$archive_path"

if download "${base_url}/SHA256SUMS" "$sums_path" 2>/dev/null; then
  expected="$(grep "  ${asset}$" "$sums_path" | awk '{print $1}' || true)"
  actual="$(sha256_file "$archive_path")"
  if [ -n "$expected" ] && [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
    fail "checksum mismatch for ${asset}"
  fi
fi

case "$archive_ext" in
  tar.gz)
    need_cmd tar
    tar -xzf "$archive_path" -C "$tmp_dir"
    ;;
  zip)
    need_cmd unzip
    unzip -q "$archive_path" -d "$tmp_dir"
    ;;
esac

[ -f "${tmp_dir}/${binary}" ] || fail "release archive did not contain ${binary}"

mkdir -p "$install_dir"
target="${install_dir}/llama-nodrama${ext}"
install_file "${tmp_dir}/${binary}" "$target"

echo "Installed: ${target}"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) echo "Add ${install_dir} to PATH if llama-nodrama is not found by your shell." ;;
esac
