# Setup & install UX — design

Date: 2026-08-06

## Problem

A new user has to assemble the runtime themselves, and every way that goes wrong
produces a bad message.

1. **The binary never lands on PATH.** The README's install is
   `curl … | tar -xz` then `./android-cam-tui` from the current directory. There
   is no install script and no update path.
2. **Missing dependencies are misdiagnosed.** `src/ui/setup.tsx` appends
   `— is scrcpy installed?` to *every* probe failure. `probeSinks`
   (`src/scrcpy/probe.ts`) spawns `v4l2-ctl` with no ENOENT guard and
   `Bun.spawn` throws synchronously, so a missing `v4l2-ctl` is reported as a
   missing scrcpy. `src/scrcpy/devices.ts` already has the guard that
   `probe.ts` lacks.
3. **A too-old scrcpy looks like a broken phone.** Debian 12 ships scrcpy 1.25
   and Ubuntu 24.04 ships 2.1; neither can capture from the camera.
   `apt install scrcpy` succeeds, `--list-camera-sizes` produces nothing the
   parser recognises, and the user sees `No cameras on <serial>`. Nothing
   reports the installed version.
4. **v4l2loopback is three steps and the UI hints at one.** The user needs the
   kernel module package (named differently on every distro), a `modprobe` with
   options, and persistence across reboot. The setup screen's yellow line covers
   only the `modprobe`, which is lost at the next boot.
5. **adb permission failures are opaque.** `adb devices -l` reports
   `no permissions` for a device without udev rules; `parseDevices` records the
   state as `no` and the screen prints `No cameras on 1234 (no)`. The fix — a
   udev-rules package and a group membership — is never mentioned.

## Scope

Two deliverables plus an Arch package:

- `install.sh` — a curl-pipe installer that puts the binary on PATH.
- An in-app **doctor** that diagnoses every dependency and prints the exact
  command for the detected distro, plus a `--doctor` flag for the same output on
  stdout.
- `packaging/PKGBUILD` — an AUR package for Arch-family users.

Out of scope, and why:

- **Shell completion.** The CLI has two flags (`--start`, `-h`). Nothing to complete.
- **The doctor running privileged commands.** It prints; the user pastes. A sudo
  password prompt inside a raw-mode TUI is a broken interaction, and running
  package installs as root is a support surface this project should not own.
- **deb / COPR / nix packaging.** One package (AUR) first. More when someone asks.

## Architecture

### `src/doctor.ts` — pure checks, one spawner

Follows the repo's existing parser/spawner split: everything that decides
anything is pure and tested against fixtures; one async function gathers the
environment.

```ts
export type Level = "block" | "warn"
export type Distro = "arch" | "debian" | "fedora" | "suse" | "unknown"

export interface Check {
  id: string
  level: Level
  ok: boolean
  detail: string    // what is wrong, one line
  fix: string[]     // shell lines to paste, in order
}

export interface Env {
  scrcpy: string | null          // resolved path, or null when absent
  adb: string | null
  v4l2ctl: string | null
  player: string | null          // first of ffplay/mpv/vlc found
  scrcpyVersion: [number, number] | null
  sinks: SinkInfo[]
  devices: DeviceInfo[]
  distro: Distro
}

export function checks(env: Env): Check[]
export function detectDistro(osRelease: string): Distro
export function parseScrcpyVersion(text: string): [number, number] | null
export async function probeEnv(): Promise<Env>
```

`probeEnv` uses `Bun.which` for the four binary lookups — the same call
`src/preview.ts` already uses to find a player — reads `/etc/os-release`, runs
`scrcpy --version`, and reuses the existing `probeSinks` and `listDevices`.
Every one of those failing is a result, not an exception: `probeEnv` never
throws.

`checks` returns one entry per check in a fixed order, including the passing
ones, so `--doctor` can print a full report and the UI can filter.

### Check levels

**block** — nothing can work:

| id | condition | fix |
|---|---|---|
| `scrcpy` | `env.scrcpy === null` | distro install line |
| `adb` | `env.adb === null` | distro install line |
| `v4l2ctl` | `env.v4l2ctl === null` | distro install line |
| `sink` | `env.sinks.length === 0` | module package + modprobe + persistence |
| `device` | `env.devices.length === 0` | plug in, enable USB debugging |
| `device-auth` | no device is in state `device`, and one is `unauthorized` | accept the RSA prompt on the phone |
| `device-perms` | no device is in state `device`, and one is in any other non-`device` state (`no`, from `no permissions`) | udev-rules package + group + `adb kill-server` |

The three device checks are mutually exclusive and evaluated in that order. One
usable device satisfies all three, so a second phone stuck in `unauthorized`
never blocks a session on the working one.

`sink` moves from today's warning to blocking. A config pointing at a
`/dev/videoN` that does not exist fails at stream start with a scrcpy error
instead of at preflight with an explanation.

**warn** — degraded, still usable:

| id | condition | fix |
|---|---|---|
| `scrcpy-version` | version `< 3.0` | scrcpy's own prebuilt Linux release |
| `player` | `env.player === null` | install ffmpeg / mpv / vlc |

The version check is advisory, never blocking. Camera capture predates the
README's stated 4.0 minimum, so a hard gate would reject working installs; the
value is in attaching "you are on scrcpy 2.1" to the `No cameras` symptom rather
than in refusing to start.

### Distro hints

One `const` table keyed by `Distro`. `detectDistro` reads `ID` first, then
`ID_LIKE` — CachyOS reports `ID=cachyos, ID_LIKE=arch`, Pop!\_OS reports
`ID_LIKE=ubuntu debian`.

| | arch | debian | fedora | suse |
|---|---|---|---|---|
| scrcpy | `pacman -S scrcpy` | `apt install scrcpy` | `dnf install scrcpy` (RPM Fusion) | `zypper in scrcpy` |
| adb | `pacman -S android-tools` | `apt install adb` | `dnf install android-tools` | `zypper in android-tools` |
| v4l2-ctl | `pacman -S v4l-utils` | `apt install v4l-utils` | `dnf install v4l-utils` | `zypper in v4l-utils` |
| module | `pacman -S v4l2loopback-dkms` | `apt install v4l2loopback-dkms` | `dnf install akmod-v4l2loopback` | `zypper in v4l2loopback-kmp-default` |
| udev | `pacman -S android-udev` + `usermod -aG adbusers $USER` | `apt install android-sdk-platform-tools-common` + `usermod -aG plugdev $USER` | shipped with `android-tools` | shipped with `android-tools` |

The Fedora module and scrcpy packages live in RPM Fusion free, so the Fedora fix
lines begin with the repository-enable command. `unknown` yields a fix that
names the three upstream project URLs.

The `sink` fix always ends with persistence, which the current hint omits:

```sh
sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"
echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo 'options v4l2loopback exclusive_caps=1 card_label="Phone Cam"' \
  | sudo tee /etc/modprobe.d/v4l2loopback.conf
```

Every fix line stays under 76 columns. The doctor indents them by two inside a
bordered, padded box, so at an 80-column terminal anything longer wraps to
column one and reads as a second command — a user pasting it gets a broken one.

### `src/ui/doctor.tsx` — the failure screen

A presentational component: takes `Check[]`, renders each failing check as its
detail line in red (block) or yellow (warn) followed by its indented fix lines,
and a footer offering `r` to re-check and `q` to quit. No probing, no state.
Its own file because `src/ui/setup.tsx` is already 363 lines.

### Wiring — no new screen

The two-screen state machine in `src/app.tsx` is unchanged. `Setup` already runs
a one-time probe effect; that effect calls `probeEnv()` instead of `listDevices`
and `probeSinks` separately, then:

- any `block` check failing → render `<Doctor>` in place of the current error
  box, with `r` re-running `probeEnv`;
- `warn` checks → the existing yellow line area, now fed from the check list
  rather than the hardcoded modprobe string;
- otherwise → the setup screen exactly as it is today.

This deletes the misleading catch-all message rather than adding a screen in
front of it.

`Setup`'s injection prop changes shape: `probes.sinks` and `probes.devices` are
folded into a single `env()`, and `probes.cameras(serial)` stays, since cameras
are re-probed on every device switch. Only `src/ui/demo.tsx` constructs that
prop — `tests/setup.test.ts` exercises the pure functions and does not render
`Setup`.

`src/scrcpy/probe.ts` gets the ENOENT guard `devices.ts` already has, so a
missing binary is a typed error rather than a synchronous throw from a spawn.

### `--doctor`

In `src/index.tsx`, before the renderer is created: run `probeEnv`, print each
check as `ok`/`warn`/`FAIL` plus its detail and fix lines, exit non-zero if any
block check failed. No React, no terminal takeover — output that pastes into a
bug report.

### `install.sh`

POSIX `sh` at the repo root, fetched over `curl -fsSL … | sh`:

1. `uname -m` → `x86_64` = x64, `aarch64` = arm64; anything else is an error
   naming the two supported architectures.
2. Download `android-cam-tui-linux-$arch.tar.gz` and its `.sha256` from the
   latest release — both already produced by `.github/workflows/release.yml`.
3. Verify with `sha256sum -c`, aborting on mismatch. Extract to a temp dir.
4. Install to `${PREFIX:-$HOME/.local/bin}`, creating it, and `chmod +x`.
5. If that directory is not in `$PATH`, append the appropriate line to the rc
   file for `$SHELL`: `~/.zshrc`, `~/.bashrc`, or
   `~/.config/fish/config.fish` (`fish_add_path`). The append is guarded by a
   `grep` so re-running the installer does not duplicate it, and the script
   prints what it changed. An unrecognised shell gets the line printed for the
   user to add.
6. Run `android-cam-tui --doctor` so any remaining runtime dependency is visible
   immediately.

No sudo anywhere: `~/.local/bin` and the shell rc file both belong to the user.

The README's Install section collapses to the single curl line, with the manual
tarball steps kept as the fallback for people who will not pipe to a shell.

### `packaging/PKGBUILD`

`pkgname=android-cam-tui-bin`, source is the `linux-x64` release tarball,
`depends=(scrcpy android-tools v4l-utils v4l2loopback-dkms)`,
`optdepends` for ffmpeg / mpv / vlc, `install` file printing the modprobe and
persistence lines. The version is bumped by hand at release time; automating the
AUR push waits until there is a reason.

## Error handling

`probeEnv` never rejects — a missing binary, an unreadable `/etc/os-release`, or
a non-zero `scrcpy --version` all become `null` fields, and `checks` turns those
into checks. The doctor screen is therefore reachable from any environment,
including one where nothing at all is installed.

`install.sh` runs under `set -e` and fails loudly on a checksum mismatch, an
unsupported architecture, or a download error, leaving nothing behind.

## Testing

`tests/doctor.test.ts`:

- `detectDistro` against `/etc/os-release` fixtures for CachyOS (`ID_LIKE=arch`),
  Ubuntu, Fedora, openSUSE, and a file with neither key.
- `parseScrcpyVersion` against real `scrcpy --version` output, a 2.x line, and
  garbage.
- `checks` against hand-built `Env` values: a fully working environment produces
  no failures; each missing piece produces exactly its own blocking check; a
  loaded sink with an old scrcpy produces one warning and no blocks; the fix
  lines for one missing binary differ between two distros.

`sh -n install.sh` in the CI workflow. No integration test for the installer —
it needs network and a real shell, and its risky step (checksum verification) is
`sha256sum`'s job.

## Files

New: `src/doctor.ts`, `src/ui/doctor.tsx`, `install.sh`, `packaging/PKGBUILD`,
`tests/doctor.test.ts`, `tests/fixtures/os-release-*.txt`.

Changed: `src/ui/setup.tsx`, `src/ui/demo.tsx`, `src/index.tsx`,
`src/scrcpy/probe.ts`, `README.md`, `.github/workflows/ci.yml`.
