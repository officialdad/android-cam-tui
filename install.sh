#!/bin/sh
# Installs the latest android-cam-tui release into ~/.local/bin.
#   curl -fsSL https://raw.githubusercontent.com/officialdad/android-cam-tui/main/install.sh | sh
# Override the destination with PREFIX=/somewhere/bin.
set -eu

REPO=officialdad/android-cam-tui
PREFIX=${PREFIX:-$HOME/.local/bin}

# The releases are Linux ELF binaries and the whole point is a v4l2loopback sink, which
# only exists on Linux. Without this a mac reports arm64 and installs an unrunnable file.
if [ "$(uname -s)" != Linux ]; then
  echo "android-cam-tui is Linux-only — it streams into a v4l2loopback device" >&2
  exit 1
fi

for cmd in curl tar sha256sum; do
  command -v "$cmd" >/dev/null || { echo "need $cmd on PATH to install" >&2; exit 1; }
done

case $(uname -m) in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
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
        line="fish_add_path \"$PREFIX\""
        ;;
      *) rc="" ;;
    esac
    if [ -z "$rc" ]; then
      echo "add this to your shell rc: $line"
    # Whole-line match: a bare substring search hits any unrelated mention of the path —
    # a comment, another tool's line, a longer path — and then we skip the append and the
    # user gets "command not found". A duplicate append is the safer way to be wrong.
    elif grep -qxF "$line" "$rc" 2>/dev/null; then
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
