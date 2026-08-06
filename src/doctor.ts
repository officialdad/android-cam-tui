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
  /** First of ffplay/mpv/vlc found, for the dashboard's `p` preview. */
  player: string | null
  scrcpyVersion: [number, number] | null
  sinks: SinkInfo[]
  devices: DeviceInfo[]
  distro: Distro
}

/** Camera capture predates the 4.x line, so this is a warning floor, not a hard gate. */
const MIN_SCRCPY: [number, number] = [3, 0]

interface Pkgs {
  scrcpy: string[]
  adb: string[]
  v4l2ctl: string[]
  module: string[]
  udev: string[]
}

const PKGS: Record<Distro, Pkgs> = {
  arch: {
    scrcpy: ["sudo pacman -S scrcpy"],
    adb: ["sudo pacman -S android-tools"],
    v4l2ctl: ["sudo pacman -S v4l-utils"],
    module: ["sudo pacman -S v4l2loopback-dkms"],
    udev: ["sudo pacman -S android-udev", "sudo usermod -aG adbusers $USER"],
  },
  debian: {
    scrcpy: ["sudo apt install scrcpy"],
    adb: ["sudo apt install adb"],
    v4l2ctl: ["sudo apt install v4l-utils"],
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
    module: ["sudo dnf install akmod-v4l2loopback"],
    udev: ["sudo dnf install android-tools"],
  },
  suse: {
    scrcpy: ["sudo zypper install scrcpy"],
    adb: ["sudo zypper install android-tools"],
    v4l2ctl: ["sudo zypper install v4l-utils"],
    module: ["sudo zypper install v4l2loopback-kmp-default"],
    udev: ["sudo zypper install android-tools"],
  },
  unknown: {
    scrcpy: ["https://github.com/Genymobile/scrcpy/blob/master/doc/linux.md"],
    adb: ["https://developer.android.com/tools/releases/platform-tools"],
    v4l2ctl: ["install v4l-utils with your package manager"],
    module: ["https://github.com/v4l2loopback/v4l2loopback#install"],
    udev: ["https://github.com/M0Rf30/android-udev-rules"],
  },
}

/** Load it now, then keep it across reboots — the one-shot modprobe is lost at the next boot. */
const MODPROBE = [
  'sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"',
  "echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf",
  `printf 'options v4l2loopback exclusive_caps=1 card_label="Phone Cam"\\n' | sudo tee /etc/modprobe.d/v4l2loopback.conf`,
]

const atLeast = (v: [number, number], min: [number, number]) =>
  v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1])

export function checks(env: Env): Check[] {
  const pkg = PKGS[env.distro]
  // The three device checks are mutually exclusive: one usable phone satisfies all of
  // them, so a second handset stuck unauthorized never blocks a working session.
  const usable = env.devices.some((d) => d.state === "device")
  const unauthorized = env.devices.some((d) => d.state === "unauthorized")
  const broken = env.devices.find((d) => d.state !== "device" && d.state !== "unauthorized")
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
        "plug the phone in over USB",
        "Settings → About phone → tap Build number 7 times",
        "Settings → Developer options → USB debugging",
      ],
    },
    {
      id: "device-auth",
      level: "block",
      ok: usable || !unauthorized,
      detail: "phone is unauthorized — it has not accepted this computer",
      fix: [
        "unlock the phone and tap Allow on the USB debugging prompt",
        "adb kill-server && adb devices",
      ],
    },
    {
      id: "device-perms",
      level: "block",
      ok: usable || !broken,
      detail: `phone reports state "${broken?.state ?? ""}" — udev rules are probably missing`,
      fix: [...pkg.udev, "sudo udevadm control --reload-rules", "unplug and replug the phone, then: adb kill-server"],
    },
    {
      id: "scrcpy-version",
      level: "warn",
      // A missing scrcpy is already the `scrcpy` block; do not report it twice.
      ok: env.scrcpy === null || version === null || atLeast(version, MIN_SCRCPY),
      detail: `scrcpy ${version?.join(".")} is too old for camera capture — needs ${MIN_SCRCPY.join(".")}+`,
      fix: ["grab a prebuilt build: https://github.com/Genymobile/scrcpy/releases/latest"],
    },
    {
      id: "player",
      level: "warn",
      ok: env.player !== null,
      detail: "no preview player — `p` on the dashboard will do nothing",
      fix: ["install one of ffmpeg (ffplay), mpv or vlc"],
    },
  ]
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
  return {
    scrcpy,
    adb: Bun.which("adb"),
    v4l2ctl: Bun.which("v4l2-ctl"),
    player: PLAYERS.map((p) => Bun.which(p)).find((p) => p !== null) ?? null,
    scrcpyVersion: parseScrcpyVersion(versionText),
    sinks,
    devices,
    distro: detectDistro(osRelease),
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
