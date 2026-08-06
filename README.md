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

Setup screen: pick camera/size/fps/zoom/bitrate/sink (all probed live),
Enter to start. Dashboard: `z` cycle zoom presets, `l` cycle camera,
`r` restart, `s` back to setup, `q` quit.

Last-used config persists at `~/.config/android-cam-tui/config.json`.
