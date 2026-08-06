# android-cam-tui

[![ci](https://github.com/officialdad/android-cam-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/officialdad/android-cam-tui/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/officialdad/android-cam-tui)](https://github.com/officialdad/android-cam-tui/releases/latest)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Terminal UI for using an Android phone as a Linux webcam via
[scrcpy](https://github.com/Genymobile/scrcpy) and v4l2loopback.

Probes your phone's real cameras (lenses, resolutions, fps, zoom ranges),
streams the one you pick into a virtual webcam device, and supervises the
stream — auto-restarting when Android evicts the camera (phone locked,
face unlock, camera app opened).

![setup screen](docs/demo.gif)

## Requirements

- Linux with `v4l2loopback` (`sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"`)
- `scrcpy` ≥ 4.0, `adb`, `v4l2-ctl` on PATH
- Phone: USB debugging enabled, plugged in, **unlocked** (Android kills
  camera access for adb clients when the keyguard engages)

## Install

Standalone binaries are on the
[latest release](https://github.com/officialdad/android-cam-tui/releases/latest) —
`linux-x64` and `linux-arm64`, no Bun needed at runtime:

```bash
curl -fsSL https://github.com/officialdad/android-cam-tui/releases/latest/download/android-cam-tui-linux-x64.tar.gz | tar -xz
./android-cam-tui
```

Each archive ships a `.sha256` next to it. From source instead (needs
[Bun](https://bun.sh) ≥ 1.3):

```bash
git clone https://github.com/officialdad/android-cam-tui
cd android-cam-tui && bun install
bun start
```

`bun run build` rebuilds the same binary into `dist/`.

## Run

```bash
./android-cam-tui            # setup screen
./android-cam-tui --start    # skip setup, stream the last-used config
```

From source, `bun start` and `bun start --start`.

Setup screen: a device row, then three columns — camera, resolution, and output
(fps/zoom/bitrate/rotate/buffer/sink), all probed live. `Tab`/`Shift-Tab` move
between fields, `1`-`3` jump to a column, `↑↓` pick from a list, `←→` adjust,
`/` filters a list (`Esc` clears), `Enter` starts. Under 100 columns wide it
shows one section at a time.

Rates marked `hs` are Android high-speed capture (`--camera-high-speed`), which
is where 120/240 fps live — they only appear on the resolutions that support
them, so pick the resolution first. Actual output can fall below the requested
rate in low light, since auto-exposure lengthens the exposure time.

`rotate` maps to scrcpy's `--capture-orientation`, so it rotates what reaches the
v4l2 device (not just a preview window) — use it when the phone sits in a mount.

## Wireless

`w` on the setup screen promotes the selected USB device to WiFi: it runs
`adb tcpip 5555`, reads the phone's WLAN address, connects, and re-probes. The
cable can then be unplugged. Every scrcpy/adb call is scoped with `-s <serial>`,
so a USB and a wireless device can be attached at once without "more than one
device" errors.

`w` again on a wireless device goes back: `adb usb` restarts adbd on USB and
`adb disconnect` drops the TCP link, so the phone stops listening on 5555.
**Plug the cable in first** — `adb usb` travels over the very connection it
closes, so with no cable the phone drops off entirely and you have to replug
(or reboot it) to get it back. Equivalent by hand:

```bash
adb -s 192.168.1.42:5555 usb
adb disconnect 192.168.1.42:5555
```

Until you do that (or the phone reboots), port 5555 stays open on your LAN —
anyone on the network who is already `adb`-authorised on that phone can connect.

Wireless adds jitter — raise `buffer` (`--v4l2-buffer`, in ms) if the feed stutters.

## Dashboard

`z` cycle zoom presets, `l` cycle camera, `t` toggle the camera torch (fill
light), `p` open a preview window, `r` restart, `s` back to setup, `q` quit.

Every camera parameter is fixed when the capture session opens, so zoom, torch
and camera changes restart the stream — the sink drops for about a second.

`p` shells out to whichever of `ffplay`, `mpv` or `vlc` is installed and points
it at the sink, since scrcpy itself runs with `--no-window`. The preview window
is detached: close it yourself, it survives stream restarts.

## Recovering from failures

The stream is supervised. When it dies, the exit code **and scrcpy's own last
error line** are logged, then it restarts with an exponential backoff, giving up
after 6 attempts so a config the phone rejects can't respawn forever. `r` clears
the count and retries. A stream that stayed up over a minute before dying starts
from a fresh budget, so a phone that locks once an hour never exhausts it.

Quitting — `q`, Ctrl+C, or a crash — kills scrcpy with it, so the camera and the
v4l2 sink are released rather than left busy for the next run.

To check the UI without a phone attached, `bun run demo` renders the setup
screen against fixture cameras. That is also what the GIF above records —
`vhs docs/demo.tape` regenerates it (needs [vhs](https://github.com/charmbracelet/vhs),
`ttyd` and `ffmpeg`).

Last-used config persists at `~/.config/android-cam-tui/config.json`.

## License

MIT
