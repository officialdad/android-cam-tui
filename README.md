# android-cam-tui

Terminal UI for using an Android phone as a Linux webcam via
[scrcpy](https://github.com/Genymobile/scrcpy) and v4l2loopback.

Probes your phone's real cameras (lenses, resolutions, fps, zoom ranges),
streams the one you pick into a virtual webcam device, and supervises the
stream — auto-restarting when Android evicts the camera (phone locked,
face unlock, camera app opened).

## Requirements

- Linux with `v4l2loopback` (`sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"`)
- `scrcpy` ≥ 4.0, `adb`, `v4l2-ctl` on PATH
- Bun
- Phone: USB debugging enabled, plugged in, **unlocked** (Android kills
  camera access for adb clients when the keyguard engages)

## Run

```bash
bun install
bun start
```

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

Dashboard: `z` cycle zoom presets, `l` cycle camera, `r` restart,
`s` back to setup, `q` quit.

To check the UI without a phone attached, `bun run demo` renders the setup
screen against fixture cameras.

Last-used config persists at `~/.config/android-cam-tui/config.json`.
