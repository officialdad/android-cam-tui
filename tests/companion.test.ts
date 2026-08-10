import { describe, expect, test } from "bun:test"
import { COMPANION_CAM, ffmpegArgs, parseCompanionState, socketReady } from "../src/companion"

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text()

describe("parseCompanionState", () => {
  test("reads installed and granted from one dumpsys", async () => {
    expect(parseCompanionState(await fixture("dumpsys-granted.txt"))).toEqual({
      installed: true,
      granted: true,
    })
  })

  test("an installed app with the permission refused is not granted", async () => {
    expect(parseCompanionState(await fixture("dumpsys-ungranted.txt"))).toEqual({
      installed: true,
      granted: false,
    })
  })

  test("a missing package is neither installed nor granted", async () => {
    expect(parseCompanionState(await fixture("dumpsys-absent.txt"))).toEqual({
      installed: false,
      granted: false,
    })
    expect(parseCompanionState("")).toEqual({ installed: false, granted: false })
  })
})

describe("socketReady", () => {
  test("finds the abstract socket by its leading @", async () => {
    expect(socketReady(await fixture("proc-net-unix-ready.txt"))).toBe(true)
  })

  test("is false before the service has bound", async () => {
    expect(socketReady(await fixture("proc-net-unix-cold.txt"))).toBe(false)
    expect(socketReady("")).toBe(false)
  })

  // A filesystem socket at that path is a different thing and must not count.
  test("does not match the name without the @", () => {
    expect(socketReady("ffff8a2d: 00000002 00000000 00010000 0001 01 22104 /tmp/android-cam")).toBe(false)
  })
})

describe("ffmpegArgs", () => {
  test("puts -r before -i", () => {
    // Annex-B carries no timestamps. With -r only on the output, ffmpeg guesses a 1200k
    // tbr for the input and drops ~98% of the frames converting down to 30. This ordering
    // is the difference between 30 fps and a slideshow, and nothing else would catch a
    // reorder during a refactor.
    const args = ffmpegArgs(27183, "/dev/video3")
    expect(args.indexOf("-r")).toBeGreaterThan(-1)
    expect(args.indexOf("-r")).toBeLessThan(args.indexOf("-i"))
    expect(args[args.indexOf("-r") + 1]).toBe("30")
  })

  test("reads the forwarded port on localhost and writes the sink last", () => {
    const args = ffmpegArgs(27183, "/dev/video3")
    expect(args[args.indexOf("-i") + 1]).toBe("tcp://127.0.0.1:27183")
    expect(args.at(-1)).toBe("/dev/video3")
    expect(args).toContain("passthrough")
  })
})

describe("COMPANION_CAM", () => {
  // The APK compiles these in and has no control channel, so the setup screen must offer
  // exactly one of each rather than a list the phone cannot honour.
  test("offers exactly one camera, size and rate", () => {
    expect(COMPANION_CAM.sizes).toEqual(["1280x720"])
    expect(COMPANION_CAM.fps).toEqual([30])
    expect(COMPANION_CAM.highSpeed).toEqual({})
    expect(COMPANION_CAM.zoomRange).toBeNull()
  })
})

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { companionState, materializeApk, prepPhone } from "../src/companion"

/**
 * A fake adb that answers by subcommand. Written to a tmpdir per test because env vars do
 * not reach spawned children here — the behaviour is baked into the script instead.
 */
function fakeAdb(body: string) {
  const bin = join(mkdtempSync(join(tmpdir(), "adb-")), "adb")
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}

const DUMPSYS_GRANTED = `cat ${import.meta.dir}/fixtures/dumpsys-granted.txt`
const UNIX_READY = `cat ${import.meta.dir}/fixtures/proc-net-unix-ready.txt`
const UNIX_COLD = `cat ${import.meta.dir}/fixtures/proc-net-unix-cold.txt`

describe("companionState", () => {
  test("reads the phone's install state through adb", async () => {
    const bin = fakeAdb(DUMPSYS_GRANTED)
    expect(await companionState("R5CT", bin)).toEqual({ installed: true, granted: true })
  })

  test("an adb that is not there reports not installed rather than throwing", async () => {
    expect(await companionState("R5CT", "/nonexistent/adb")).toEqual({
      installed: false,
      granted: false,
    })
  })
})

describe("prepPhone", () => {
  // Every adb call is serial-scoped, and `-s <serial>` has to precede the subcommand.
  test("forwards the port and starts the service before the socket poll", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "adblog-")), "calls")
    const bin = fakeAdb(`echo "$@" >> ${log}\ncase "$*" in *"/proc/net/unix"*) ${UNIX_READY};; esac`)
    await prepPhone("R5CT", bin)
    const calls = await Bun.file(log).text()
    expect(calls).toContain("-s R5CT forward tcp:27183 localabstract:android-cam")
    expect(calls).toContain("-s R5CT shell am start-foreground-service -n com.officialdad.androidcam/.CamService")
    // No activity is ever started: waking a locked phone starts face unlock, which opens a
    // camera of its own and gets our own open rejected.
    expect(calls).not.toContain("am start -n")
  })

  test("throws with the permission hint when the service never listens", async () => {
    const bin = fakeAdb(`case "$*" in *"/proc/net/unix"*) ${UNIX_COLD};; esac`)
    expect(prepPhone("R5CT", bin, 2)).rejects.toThrow(/pm grant/)
  })

  // `am` reports its real failures on stdout with exit code 0 — an Android below 8.0 has no
  // `start-foreground-service` at all. Without reading that, every one of those collapses
  // into the same 6-second timeout and a camera-permission hint that is wrong.
  test("an `am` error is reported instead of waiting out the socket poll", async () => {
    const bin = fakeAdb(
      `case "$*" in *start-foreground-service*) echo "Error: Unknown command: start-foreground-service";; esac`,
    )
    expect(prepPhone("R5CT", bin)).rejects.toThrow(/Unknown command/)
  })

  test("a failed forward is reported rather than swallowed", async () => {
    const bin = fakeAdb(`case "$*" in *forward*) echo "error: device offline" >&2; exit 1;; esac`)
    expect(prepPhone("R5CT", bin)).rejects.toThrow(/device offline/)
  })
})

describe("materializeApk", () => {
  // The imported path addresses Bun's embedded filesystem in a compiled binary, which adb
  // cannot open. This is what turns it into a real one.
  test("writes a real, non-empty apk adb could install", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "apk-")), "android-cam.apk")
    expect(await materializeApk(dest)).toBe(dest)
    expect(Bun.file(dest).size).toBeGreaterThan(4096)
    // Every APK is a zip.
    const head = new Uint8Array(await Bun.file(dest).slice(0, 2).arrayBuffer())
    expect([head[0], head[1]]).toEqual([0x50, 0x4b])
  })

  test("an unwritable destination yields null rather than throwing", async () => {
    expect(await materializeApk("/proc/nope/android-cam.apk")).toBeNull()
  })
})
