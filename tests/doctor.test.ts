import { describe, expect, test } from "bun:test"
import { detectDistro, parseScrcpyVersion, checks, type Env } from "../src/doctor"
import type { DeviceInfo } from "../src/scrcpy/devices"

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text()

describe("detectDistro", () => {
  test("reads ID first", async () => {
    expect(detectDistro(await fixture("os-release-fedora.txt"))).toBe("fedora")
  })

  test("falls back to ID_LIKE when ID is a derivative", async () => {
    expect(detectDistro(await fixture("os-release-cachyos.txt"))).toBe("arch")
    expect(detectDistro(await fixture("os-release-ubuntu.txt"))).toBe("debian")
  })

  test("maps a derivative of a derivative through the alias table", async () => {
    // Mint's ID_LIKE is `ubuntu`, which is itself not one of the five families.
    expect(detectDistro(await fixture("os-release-mint.txt"))).toBe("debian")
  })

  test("strips quotes and scans every ID_LIKE token", async () => {
    expect(detectDistro(await fixture("os-release-tumbleweed.txt"))).toBe("suse")
  })

  test("returns unknown when neither key matches", async () => {
    expect(detectDistro(await fixture("os-release-bare.txt"))).toBe("unknown")
    expect(detectDistro("")).toBe("unknown")
  })
})

describe("parseScrcpyVersion", () => {
  test("reads the real --version banner", () => {
    expect(parseScrcpyVersion("scrcpy 4.1 <https://github.com/Genymobile/scrcpy>")).toEqual([4, 1])
  })

  test("reads a two-digit minor", () => {
    expect(parseScrcpyVersion("scrcpy 2.10")).toEqual([2, 10])
  })

  test("returns null on anything else", () => {
    expect(parseScrcpyVersion("")).toBeNull()
    expect(parseScrcpyVersion("command not found")).toBeNull()
  })
})

const OK: Env = {
  scrcpy: "/usr/bin/scrcpy",
  adb: "/usr/bin/adb",
  v4l2ctl: "/usr/bin/v4l2-ctl",
  player: "/usr/bin/mpv",
  scrcpyVersion: [4, 1],
  sinks: [{ label: "Phone Cam", path: "/dev/video3" }],
  devices: [{ serial: "R5CT", model: "SM_S911B", wireless: false, state: "device" }],
  distro: "arch",
}

const failed = (env: Env) => checks(env).filter((c) => !c.ok).map((c) => c.id)
const blocked = (env: Env) => checks(env).filter((c) => !c.ok && c.level === "block").map((c) => c.id)
const find = (env: Env, id: string) => checks(env).find((c) => c.id === id)!

describe("checks", () => {
  test("a complete environment fails nothing", () => {
    expect(failed(OK)).toEqual([])
  })

  test("each missing binary raises exactly its own block", () => {
    expect(blocked({ ...OK, scrcpy: null, scrcpyVersion: null })).toEqual(["scrcpy"])
    expect(blocked({ ...OK, adb: null })).toEqual(["adb"])
    expect(blocked({ ...OK, v4l2ctl: null })).toEqual(["v4l2ctl"])
  })

  test("a missing sink blocks — streaming into a device that is not there fails later", () => {
    expect(blocked({ ...OK, sinks: [] })).toEqual(["sink"])
  })

  test("the sink fix ends with the reboot-persistence lines", () => {
    const fix = find({ ...OK, sinks: [] }, "sink").fix
    expect(fix[0]).toContain("pacman -S v4l2loopback-dkms")
    expect(fix.join("\n")).toContain("/etc/modules-load.d/v4l2loopback.conf")
    expect(fix.join("\n")).toContain("/etc/modprobe.d/v4l2loopback.conf")
  })

  test("no device blocks on `device` alone, not on auth or permissions", () => {
    expect(blocked({ ...OK, devices: [] })).toEqual(["device"])
  })

  test("an unauthorized device blocks on auth alone", () => {
    const devices: DeviceInfo[] = [{ serial: "R5CT", model: "", wireless: false, state: "unauthorized" }]
    expect(blocked({ ...OK, devices })).toEqual(["device-auth"])
  })

  test("a no-permissions device blocks on perms alone and names udev", () => {
    const devices: DeviceInfo[] = [{ serial: "R5CT", model: "", wireless: false, state: "no" }]
    expect(blocked({ ...OK, devices })).toEqual(["device-perms"])
    expect(find({ ...OK, devices }, "device-perms").fix.join("\n")).toContain("android-udev")
  })

  // An offline phone is asleep, mid-boot, or has an adbd restarting after `adb tcpip` —
  // installing udev rules fixes none of that, so it must not land in `device-perms`.
  test("an offline device gets its own check, not the udev one", () => {
    const devices: DeviceInfo[] = [{ serial: "R5CT", model: "", wireless: false, state: "offline" }]
    expect(blocked({ ...OK, devices })).toEqual(["device-offline"])
    const fix = find({ ...OK, devices }, "device-offline").fix.join("\n")
    expect(fix).toContain("adb kill-server")
    expect(fix).not.toContain("udev")
  })

  test("states other than offline still reach the udev check", () => {
    for (const state of ["no", "bootloader", "recovery", "sideload", "host"]) {
      const devices: DeviceInfo[] = [{ serial: "R5CT", model: "", wireless: false, state }]
      expect(blocked({ ...OK, devices })).toEqual(["device-perms"])
    }
  })

  test("one usable device clears every device check", () => {
    const devices: DeviceInfo[] = [
      { serial: "R5CT", model: "", wireless: false, state: "device" },
      { serial: "OTHER", model: "", wireless: false, state: "unauthorized" },
      { serial: "THIRD", model: "", wireless: false, state: "offline" },
    ]
    expect(blocked({ ...OK, devices })).toEqual([])
  })

  test("an old scrcpy warns and never blocks", () => {
    const env = { ...OK, scrcpyVersion: [2, 1] as [number, number] }
    expect(blocked(env)).toEqual([])
    expect(failed(env)).toEqual(["scrcpy-version"])
  })

  test("a missing scrcpy does not also fire the version warning", () => {
    expect(failed({ ...OK, scrcpy: null, scrcpyVersion: null })).toEqual(["scrcpy"])
  })

  test("no preview player is a warning only", () => {
    const env = { ...OK, player: null }
    expect(blocked(env)).toEqual([])
    expect(failed(env)).toEqual(["player"])
  })

  test("fix lines follow the distro", () => {
    expect(find({ ...OK, adb: null }, "adb").fix).toEqual(["sudo pacman -S android-tools"])
    expect(find({ ...OK, adb: null, distro: "debian" }, "adb").fix).toEqual(["sudo apt install adb"])
    expect(find({ ...OK, adb: null, distro: "unknown" }, "adb").fix[0]).toContain("https://")
  })

  /**
   * The doctor indents fix lines by two inside a bordered, padded box, so an 80-column
   * terminal leaves 76. Past that the tail wraps to column one and reads as a second
   * command — which is how a user ends up pasting a broken one. RPM Fusion's release-RPM
   * URL is the one exemption: it is 95 characters by itself, so no hand-wrapping helps,
   * and a wrapped URL at least still reads as one thing.
   */
  test("every fix line that can be wrapped by hand fits an 80-column screen", () => {
    const long = (["arch", "debian", "fedora", "suse", "unknown"] as const)
      .flatMap((distro) => checks({ ...OK, distro }).flatMap((c) => c.fix))
      .filter((line) => line.length + 2 > 76 && !line.includes("rpmfusion"))
    expect(long).toEqual([])
  })

  test("fedora enables RPM Fusion before installing scrcpy", () => {
    const fix = find({ ...OK, scrcpy: null, scrcpyVersion: null, distro: "fedora" }, "scrcpy").fix
    expect(fix[0]).toContain("rpmfusion")
    expect(fix[1]).toBe("sudo dnf install scrcpy")
  })
})
