#!/bin/sh
# Installs the latest android-cam-tui release into ~/.local/bin.
#   curl -fsSL https://raw.githubusercontent.com/officialdad/android-cam-tui/main/install.sh | sh
# Override the destination with PREFIX=/somewhere/bin.
set -eu

REPO=officialdad/android-cam-tui
PREFIX=${PREFIX:-$HOME/.local/bin}

case $(uname -m) in
  x86_64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *)
    echo "unsupported architecture $(uname -m) — releases cover x86_64 and aarch64" >&2
    exit 1
    ;;
esac

NAME="android-cam-tui-linux-$ARCH.tar.gz"
BASE="https://github.com/$REPO/releases/latest/download"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "downloading $NAME…"
curl -fsSL "$BASE/$NAME" -o "$TMP/$NAME"
curl -fsSL "$BASE/$NAME.sha256" -o "$TMP/$NAME.sha256"
(cd "$TMP" && sha256sum -c "$NAME.sha256" >/dev/null) || {
  echo "checksum mismatch — aborting" >&2
  exit 1
}

tar -xzf "$TMP/$NAME" -C "$TMP"
mkdir -p "$PREFIX"
install -m 755 "$TMP/android-cam-tui" "$PREFIX/android-cam-tui"
echo "installed $PREFIX/android-cam-tui"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    line="export PATH=\"$PREFIX:\$PATH\""
    case $(basename "${SHELL:-sh}") in
      zsh) rc=$HOME/.zshrc ;;
      bash) rc=$HOME/.bashrc ;;
      fish)
        rc=$HOME/.config/fish/config.fish
        line="fish_add_path $PREFIX"
        ;;
      *) rc="" ;;
    esac
    if [ -z "$rc" ]; then
      echo "add this to your shell rc: $line"
    elif grep -qF "$PREFIX" "$rc" 2>/dev/null; then
      echo "$rc already puts $PREFIX on PATH — open a new shell to pick it up"
    else
      mkdir -p "$(dirname "$rc")"
      printf '\n%s\n' "$line" >>"$rc"
      echo "added $PREFIX to PATH in $rc — open a new shell to pick it up"
    fi
    ;;
esac

# Report whatever runtime dependency is still missing. --doctor exits non-zero
# when something blocks, which is information, not an installer failure.
"$PREFIX/android-cam-tui" --doctor || true
