import { APK_CACHE, companionState, materializeApk, PKG } from "./companion"
import type { StreamConfig } from "./config"
import { listDevices, type DeviceInfo } from "./scrcpy/devices"
import { probeSinks, type SinkInfo } from "./scrcpy/probe"

export type Distro = "arch" | "debian" | "fedora" | "suse" | "unknown"

/**
 * Derivatives that do not name one of the five families in `ID` or `ID_LIKE`.
 * Mint reports `ID_LIKE=ubuntu`; Tumbleweed reports `ID_LIKE="opensuse suse"`.
 * Everything else is reached through ID_LIKE alone and needs no entry here.
 */
const ALIASES: Record<string, Distro> = {
  arch: "arch",
  debian: "debian",
  ubuntu: "debian",
  fedora: "fedora",
  suse: "suse",
  opensuse: "suse",
}

export function detectDistro(osRelease: string): Distro {
  const field = (key: string) =>
    osRelease.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1].replace(/"/g, "").trim() ?? ""
  for (const id of [field("ID"), ...field("ID_LIKE").split(/\s+/)]) {
    if (ALIASES[id]) return ALIASES[id]
  }
  return "unknown"
}

/** `scrcpy --version` prints "scrcpy 4.1 <url>" on its first line. */
export function parseScrcpyVersion(text: string): [number, number] | null {
  const m = text.match(/\bscrcpy\s+(\d+)\.(\d+)/i)
  return m ? [Number(m[1]), Number(m[2])] : null
}

export type Level = "block" | "warn"

export interface Check {
  id: string
  level: Level
  ok: boolean
  /** One line naming what is wrong. */
  detail: string
  /** Shell lines to paste, in order. */
  fix: string[]
}

export interface Env {
  scrcpy: string | null
  adb: string | null
  v4l2ctl: string | null
  /** The companion backend pipes the phone's H.264 through it into the sink. */
  ffmpeg: string | null
  /** First of ffplay/mpv/vlc found, for the dashboard's `p` preview. */
  player: string | null
  scrcpyVersion: [number, number] | null
  sinks: SinkInfo[]
  devices: DeviceInfo[]
  distro: Distro
  /** Where `probeEnv` put the vendored APK, for the install fix line. Null if it could not. */
  apkPath: string | null
}

/** Camera capture predates the 4.x line, so this is a warning floor, not a hard gate. */
const MIN_SCRCPY: [number, number] = [3, 0]

/**
 * Android 12. The camera *listing* works further back — `--list-cameras` is a plain camera
 * manager query — so an Android 10 phone reaches the setup screen looking healthy and only
 * fails once capture starts, with "Server connection failed" hiding the real reason. This
 * is a hard gate: no scrcpy flag makes an older phone work.
 */
export const MIN_SDK = 31

/**
 * Android 8.0. The APK's own manifest says 21, but `prepPhone` drives the service with
 * `am start-foreground-service`, and that `am` subcommand does not exist before 8.0 — an
 * older phone installs the APK fine and then fails invisibly. Nothing installs its way
 * out of this one, so it is a hard floor rather than a prerequisite.
 */
export const COMPANION_MIN_SDK = 26

/**
 * The one place the floor is compared. An undefined sdk means the phone never answered
 * `getprop` — unauthorized, offline, mid-boot — and each of those has its own check, so
 * it is not treated as old.
 */
export function backendFor(sdk?: number): StreamConfig["backend"] {
  return sdk !== undefined && sdk < MIN_SDK ? "companion" : "scrcpy"
}

interface Pkgs {
  scrcpy: string[]
  adb: string[]
  v4l2ctl: string[]
  ffmpeg: string[]
  module: string[]
  udev: string[]
}

const PKGS: Record<Distro, Pkgs> = {
  arch: {
    scrcpy: ["sudo pacman -S scrcpy"],
    adb: ["sudo pacman -S android-tools"],
    v4l2ctl: ["sudo pacman -S v4l-utils"],
    ffmpeg: ["sudo pacman -S ffmpeg"],
    module: ["sudo pacman -S v4l2loopback-dkms"],
    udev: ["sudo pacman -S android-udev", "sudo usermod -aG adbusers $USER"],
  },
  debian: {
    scrcpy: ["sudo apt install scrcpy"],
    adb: ["sudo apt install adb"],
    v4l2ctl: ["sudo apt install v4l-utils"],
    ffmpeg: ["sudo apt install ffmpeg"],
    module: ["sudo apt install v4l2loopback-dkms"],
    udev: ["sudo apt install android-sdk-platform-tools-common", "sudo usermod -aG plugdev $USER"],
  },
  fedora: {
    // scrcpy and the module both live in RPM Fusion free, which is not enabled by default.
    scrcpy: [
      "sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm",
      "sudo dnf install scrcpy",
    ],
    adb: ["sudo dnf install android-tools"],
    v4l2ctl: ["sudo dnf install v4l-utils"],
    ffmpeg: ["sudo dnf install ffmpeg-free"],
    module: ["sudo dnf install akmod-v4l2loopback"],
    udev: ["sudo dnf install android-tools"],
  },
  suse: {
    scrcpy: ["sudo zypper install scrcpy"],
    adb: ["sudo zypper install android-tools"],
    v4l2ctl: ["sudo zypper install v4l-utils"],
    ffmpeg: ["sudo zypper install ffmpeg"],
    module: ["sudo zypper install v4l2loopback-kmp-default"],
    udev: ["sudo zypper install android-tools"],
  },
  unknown: {
    scrcpy: ["# https://github.com/Genymobile/scrcpy/blob/master/doc/linux.md"],
    adb: ["# https://developer.android.com/tools/releases/platform-tools"],
    v4l2ctl: ["# install v4l-utils with your package manager"],
    ffmpeg: ["# install ffmpeg with your package manager"],
    module: ["# https://github.com/v4l2loopback/v4l2loopback#install"],
    udev: ["# https://github.com/M0Rf30/android-udev-rules"],
  },
}

/**
 * Load it now, then keep it across reboots — the one-shot modprobe is lost at the next boot.
 * Every line stays under 76 columns: the doctor screen indents fix lines by two inside a
 * bordered, padded box, so anything longer wraps mid-path at an 80-column terminal and the
 * user pastes a broken command.
 */
const MODPROBE = [
  'sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"',
  "echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf",
  `echo 'options v4l2loopback exclusive_caps=1 card_label="Phone Cam"' \\`,
  "  | sudo tee /etc/modprobe.d/v4l2loopback.conf",
]

const atLeast = (v: [number, number], min: [number, number]) =>
  v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1])

export function checks(env: Env): Check[] {
  const pkg = PKGS[env.distro]
  // The device *state* checks are mutually exclusive: one usable phone satisfies all of
  // them, so a second handset stuck unauthorized never blocks a working session.
  // The api-level ones below are not, because the backend is chosen per selected device:
  // "some other phone works" does not answer "will the one you are about to pick work?".
  // Two bands, split at the companion floor and disjoint by construction — which is what
  // stops `device-android` and the three companion checks ever describing the same phone,
  // however many old handsets are attached.
  const tooOld = env.devices.find((d) => d.state === "device" && d.sdk !== undefined && d.sdk < COMPANION_MIN_SDK)
  const old = env.devices.find(
    (d) => d.state === "device" && d.sdk !== undefined && d.sdk >= COMPANION_MIN_SDK && d.sdk < MIN_SDK,
  )
  const needsCompanion = old !== undefined
  const companion = old?.companion
  // An unknown sdk counts as usable: only a phone that answered getprop with a number below
  // the floor is provably too old, and every other device state has a check of its own. A
  // phone the companion path can serve *right now* counts too — it is a working handset, so
  // neither an ancient sibling nor an unauthorized one may hand the screen to <Doctor> in
  // front of it.
  const usable =
    env.devices.some((d) => d.state === "device" && (d.sdk ?? MIN_SDK) >= MIN_SDK) ||
    (needsCompanion && env.ffmpeg !== null && (companion?.granted ?? false))
  // One usable handset never makes an unusable one work; it only decides how loud the
  // report about it is.
  const level: Level = usable ? "warn" : "block"
  const unauthorized = env.devices.some((d) => d.state === "unauthorized")
  // `offline` is its own diagnosis: adb sees the phone but adbd is not answering — asleep,
  // mid-boot, or restarting after `adb tcpip`. udev rules fix none of that.
  const offline = env.devices.some((d) => d.state === "offline")
  const broken = env.devices.find(
    (d) => !["device", "unauthorized", "offline"].includes(d.state),
  )
  const version = env.scrcpyVersion

  return [
    {
      id: "scrcpy",
      level: "block",
      ok: env.scrcpy !== null,
      detail: "scrcpy is not on PATH",
      fix: pkg.scrcpy,
    },
    {
      id: "adb",
      level: "block",
      ok: env.adb !== null,
      detail: "adb is not on PATH",
      fix: pkg.adb,
    },
    {
      id: "v4l2ctl",
      level: "block",
      ok: env.v4l2ctl !== null,
      detail: "v4l2-ctl is not on PATH",
      fix: pkg.v4l2ctl,
    },
    {
      id: "sink",
      level: "block",
      ok: env.sinks.length > 0,
      detail: "no v4l2loopback sink — there is nothing to stream into",
      fix: [...pkg.module, ...MODPROBE],
    },
    {
      id: "device",
      level: "block",
      ok: env.devices.length > 0,
      detail: "no phone detected",
      fix: [
        "# plug the phone in over USB",
        "# Settings → About phone → tap Build number 7 times",
        "# Settings → Developer options → USB debugging",
        "# USB notification → File transfer — MIDI/charging-only modes",
        "# carry no adb interface, so no prompt ever appears",
      ],
    },
    {
      id: "device-auth",
      level: "block",
      ok: usable || !unauthorized,
      detail: "phone is unauthorized — it has not accepted this computer",
      fix: [
        "# unlock the phone and tap Allow on the USB debugging prompt",
        "adb kill-server && adb devices",
      ],
    },
    {
      id: "device-offline",
      level: "block",
      ok: usable || !offline,
      detail: 'phone reports state "offline" — adbd is not answering',
      fix: [
        "# unlock the phone and leave the screen on",
        "adb kill-server && adb devices",
        "# if it stays offline, unplug and replug the cable",
      ],
    },
    {
      id: "device-perms",
      level: "block",
      ok: usable || !broken,
      detail: `phone reports state "${broken?.state ?? ""}" — udev rules are probably missing`,
      fix: [
        ...pkg.udev,
        "sudo udevadm control --reload-rules",
        "# unplug and replug the phone, then:",
        "adb kill-server",
      ],
    },
    {
      id: "device-android",
      level,
      ok: tooOld === undefined,
      detail: `phone runs API ${tooOld?.sdk ?? ""} — too old for either stream backend`,
      fix: [
        "# scrcpy cannot mirror a camera before Android 12, and the companion app",
        "# is launched with `am start-foreground-service`, added in Android 8.0",
        "# nothing installs its way past this — use a newer phone",
      ],
    },
    {
      id: "ffmpeg",
      level,
      ok: !needsCompanion || env.ffmpeg !== null,
      detail: "ffmpeg is not on PATH — the companion backend streams through it",
      fix: pkg.ffmpeg,
    },
    {
      id: "companion-apk",
      level,
      ok: !needsCompanion || (companion?.installed ?? false),
      detail: `phone runs API ${old?.sdk ?? ""} — it needs the Android Cam companion app`,
      fix: [
        "# scrcpy cannot mirror a camera before Android 12, so an installed app",
        "# holding its own CAMERA permission streams it instead",
        env.apkPath
          ? `adb install -r -g ${env.apkPath}`
          : "# build it: https://github.com/officialdad/android-cam",
      ],
    },
    {
      id: "companion-perm",
      level,
      ok: !needsCompanion || !companion?.installed || companion.granted,
      detail: "Android Cam has no camera permission — this ROM refused `install -g`",
      fix: [
        `adb shell pm grant ${PKG} android.permission.CAMERA`,
        "# or by hand: Settings > Apps > Android Cam > Permissions > Camera",
      ],
    },
    {
      id: "scrcpy-version",
      level: "warn",
      // A missing scrcpy is already the `scrcpy` block; do not report it twice.
      ok: env.scrcpy === null || version === null || atLeast(version, MIN_SCRCPY),
      detail: `scrcpy ${version?.join(".")} is too old for camera capture — needs ${MIN_SCRCPY.join(".")}+`,
      fix: ["# prebuilt: https://github.com/Genymobile/scrcpy/releases/latest"],
    },
    {
      id: "player",
      level: "warn",
      ok: env.player !== null,
      detail: "no preview player — `p` on the dashboard will do nothing",
      fix: ["# install one of ffmpeg (ffplay), mpv or vlc"],
    },
  ]
}

/**
 * The failing checks as a shell script, for the doctor screen's `c` key. Details become
 * comments and every `fix` line is already shell-valid — prose in a fix array carries its
 * own `#`, which is what lets the whole block paste into a terminal and run. A fix line
 * added without that prefix breaks the paste, so `tests/doctor.test.ts` enforces it.
 */
export function fixScript(list: Check[]): string {
  return list
    .filter((c) => !c.ok)
    .map((c) => [`# ${c.detail}`, ...c.fix].join("\n"))
    .join("\n\n")
}

const PLAYERS = ["ffplay", "mpv", "vlc"]

/** Never rejects: every failure becomes a null field, so the doctor is always renderable. */
export async function probeEnv(): Promise<Env> {
  const scrcpy = Bun.which("scrcpy")
  const [sinks, devices, osRelease, versionText] = await Promise.all([
    probeSinks(),
    listDevices(),
    Bun.file("/etc/os-release").text().catch(() => ""),
    scrcpy ? run([scrcpy, "--version"]) : Promise.resolve(""),
  ])
  // Only phones that provably answered below the floor need the companion app, so nothing
  // else is asked and nothing is written on a modern-phone-only machine.
  const old = devices.filter((d) => d.state === "device" && d.sdk !== undefined && d.sdk < MIN_SDK)
  // Kept as two entries rather than a spread, so this stays a tuple and `apkPath` keeps
  // its `string | null` type instead of widening to include the probes' void.
  const [apkPath] = await Promise.all([
    old.length > 0 ? materializeApk(APK_CACHE) : Promise.resolve(null),
    Promise.all(
      old.map(async (d) => {
        d.companion = await companionState(d.serial)
      }),
    ),
  ])
  return {
    scrcpy,
    adb: Bun.which("adb"),
    v4l2ctl: Bun.which("v4l2-ctl"),
    ffmpeg: Bun.which("ffmpeg"),
    player: PLAYERS.map((p) => Bun.which(p)).find((p) => p !== null) ?? null,
    scrcpyVersion: parseScrcpyVersion(versionText),
    sinks,
    devices,
    distro: detectDistro(osRelease),
    apkPath,
  }
}

async function run(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout as ReadableStream).text()
    await proc.exited
    return out
  } catch {
    return ""
  }
}
