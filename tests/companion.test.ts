import { describe, expect, test } from "bun:test"
import {
  COMPANION_CAM,
  ffmpegArgs,
  parseBitrate,
  parseCompanionProbe,
  parseCompanionState,
  serviceExtras,
  socketReady,
} from "../src/companion"

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

const FF = { sink: "/dev/video3", fps: 30, orientation: "0" as const, aspect: "native" as const }

describe("ffmpegArgs", () => {
  test("puts -r before -i", () => {
    // Annex-B carries no timestamps. With -r only on the output, ffmpeg guesses a 1200k
    // tbr for the input and drops ~98% of the frames converting down to 30. This ordering
    // is the difference between 30 fps and a slideshow, and nothing else would catch a
    // reorder during a refactor.
    const args = ffmpegArgs(27183, FF)
    expect(args.indexOf("-r")).toBeGreaterThan(-1)
    expect(args.indexOf("-r")).toBeLessThan(args.indexOf("-i"))
    expect(args[args.indexOf("-r") + 1]).toBe("30")
  })

  test("reads the forwarded port on localhost and writes the sink last", () => {
    const args = ffmpegArgs(27183, FF)
    expect(args[args.indexOf("-i") + 1]).toBe("tcp://127.0.0.1:27183")
    expect(args.at(-1)).toBe("/dev/video3")
    expect(args).toContain("passthrough")
  })

  const vf = (args: string[]) => args[args.indexOf("-vf") + 1]

  test("no rotation and native aspect leave only the format filter", () => {
    expect(vf(ffmpegArgs(27183, FF))).toBe("format=yuv420p")
  })

  // Rotation is host-side: raw Annex-B has no rotation metadata to carry a phone-side
  // one, and the numbers are clockwise to match scrcpy's --capture-orientation.
  test("rotation adds a transpose, after the aspect crop", () => {
    expect(vf(ffmpegArgs(27183, { ...FF, orientation: "90" }))).toBe("transpose=1,format=yuv420p")
    expect(vf(ffmpegArgs(27183, { ...FF, orientation: "270" }))).toBe("transpose=2,format=yuv420p")
    expect(vf(ffmpegArgs(27183, { ...FF, orientation: "flip0" }))).toBe("hflip,format=yuv420p")
    // Crop first: scrcpy applies --crop before --capture-orientation, and the two
    // backends must not disagree about what an aspect means under rotation.
    const both = vf(ffmpegArgs(27183, { ...FF, orientation: "90", aspect: "1:1" }))
    expect(both.indexOf("crop")).toBeLessThan(both.indexOf("transpose"))
  })

  // Expression-based on iw/ih, not the config size: the phone clamps the requested size
  // and there is no reply channel, so only ffmpeg knows what actually arrived.
  test("aspect crops center on the decoded stream's own dimensions", () => {
    expect(vf(ffmpegArgs(27183, { ...FF, aspect: "1:1" }))).toBe(
      "crop=w='min(iw,ih)':h='min(iw,ih)',format=yuv420p",
    )
    expect(vf(ffmpegArgs(27183, { ...FF, aspect: "4:3" }))).toContain("ih*4/3")
    expect(vf(ffmpegArgs(27183, { ...FF, aspect: "16:9" }))).toContain("ih*16/9")
  })
})

describe("COMPANION_CAM", () => {
  // Sizes are requests the phone clamps; fps stays a single stop because ffmpeg's `-r`
  // must match the actual stream rate and there is no reply channel to learn a clamp.
  test("offers sizes to request but exactly one rate", () => {
    expect(COMPANION_CAM.sizes).toEqual(["1920x1080", "1280x720", "640x480"])
    expect(COMPANION_CAM.fps).toEqual([30])
    expect(COMPANION_CAM.highSpeed).toEqual({})
    // Optimistic range: the phone clamps to its real max digital zoom, overshoot pins there.
    expect(COMPANION_CAM.zoomRange).toEqual([1, 4])
  })
})

describe("parseBitrate", () => {
  test("reads scrcpy-style suffixes into bits/s", () => {
    expect(parseBitrate("16M")).toBe(16_000_000)
    expect(parseBitrate("8000K")).toBe(8_000_000)
    expect(parseBitrate("8000000")).toBe(8_000_000)
  })

  // 0 would mean "keep the current config" to the service, not "use the default".
  test("falls back to the APK default rather than 0 on garbage", () => {
    expect(parseBitrate("fast")).toBe(8_000_000)
    expect(parseBitrate("")).toBe(8_000_000)
  })
})

describe("serviceExtras", () => {
  test("splits the size and converts the bitrate, zoom and camera for the intent", () => {
    expect(serviceExtras({ size: "1920x1080", fps: 30, bitrate: "8M", zoom: 1.5, cameraId: "1" })).toEqual([
      ...["--ei", "width", "1920", "--ei", "height", "1080"],
      ...["--ei", "fps", "30", "--ei", "bitrate", "8000000"],
      ...["--ei", "zoom", "150"],
      ...["--es", "camera", "1"],
    ])
  })

  // A re-run `am` keeps absent extras at their previous values, so "auto" must be an
  // explicit 100 (= off to the service) — dropping the extra would leave the phone zoomed.
  test("auto zoom is sent as an explicit 100, never omitted", () => {
    const extras = serviceExtras({ size: "1280x720", fps: 30, bitrate: "8M", zoom: null, cameraId: "0" })
    expect(extras.slice(extras.indexOf("zoom"), extras.indexOf("zoom") + 2)).toEqual(["zoom", "100"])
  })
})

describe("parseCompanionProbe", () => {
  test("reads real cameras out of the dumpsys wrapper", async () => {
    const cams = parseCompanionProbe(await fixture("dumpsys-service-probe.txt"))!
    expect(cams.map((c) => c.id)).toEqual(["0", "1"])
    expect(cams[0]).toMatchObject({
      facing: "back",
      maxSize: "4000x3000",
      fps: [15, 30], // distinct AE upper bounds, ascending
      zoomRange: [1, 4],
      orientation: 90,
    })
    // maxZoom 1.0 means no digital zoom, not a [1,1] range; the front sensor sits at 270.
    expect(cams[1].zoomRange).toBeNull()
    expect(cams[1].orientation).toBe(270)
    expect(cams[1].facing).toBe("front")
  })

  // An old APK has no dump() override — the framework prints its generic service dump and
  // no JSON. Null is the signal to fall back to the COMPANION_CAM constants.
  test("an old APK's dump yields null, not a crash or an empty picker", async () => {
    expect(parseCompanionProbe(await fixture("dumpsys-service-old.txt"))).toBeNull()
    expect(parseCompanionProbe("")).toBeNull()
    expect(parseCompanionProbe('  {"cameras": not json}')).toBeNull()
  })

  test("a camera with no sizes is dropped rather than breaking the picker", () => {
    const cams = parseCompanionProbe(
      '{"cameras":[{"id":"0","facing":"back","sizes":[],"fpsRanges":[]},{"id":"1","facing":"front","sizes":["1280x720"],"fpsRanges":[]}]}',
    )!
    expect(cams.map((c) => c.id)).toEqual(["1"])
    // No AE ranges reported: fall back to the constant's rate rather than an empty stepper.
    expect(cams[0].fps).toEqual(COMPANION_CAM.fps)
  })
})

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { companionState, materializeApk, prepPhone, probeCompanionCams } from "../src/companion"

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
    await prepPhone("R5CT", bin, serviceExtras({ size: "1920x1080", fps: 30, bitrate: "8M", zoom: null, cameraId: "0" }))
    const calls = await Bun.file(log).text()
    expect(calls).toContain("-s R5CT forward tcp:27183 localabstract:android-cam")
    expect(calls).toContain(
      "-s R5CT shell am start-foreground-service -n com.officialdad.androidcam/.CamService --ei width 1920 --ei height 1080 --ei fps 30 --ei bitrate 8000000 --ei zoom 100 --es camera 0",
    )
    // No activity is ever started: waking a locked phone starts face unlock, which opens a
    // camera of its own and gets our own open rejected.
    expect(calls).not.toContain("am start -n")
  })

  test("throws with the permission hint when the service never listens", async () => {
    const bin = fakeAdb(`case "$*" in *"/proc/net/unix"*) ${UNIX_COLD};; esac`)
    expect(prepPhone("R5CT", bin, [], 2)).rejects.toThrow(/pm grant/)
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

describe("probeCompanionCams", () => {
  const DUMPSYS_PROBE = `case "$*" in *dumpsys*) cat ${import.meta.dir}/fixtures/dumpsys-service-probe.txt;; esac`

  test("starts the service, then reads real cameras over dumpsys", async () => {
    const bin = fakeAdb(DUMPSYS_PROBE)
    const cams = (await probeCompanionCams("R5CT", bin))!
    expect(cams.map((c) => c.id)).toEqual(["0", "1"])
  })

  // An old APK answers dumpsys with the framework's generic dump forever — the poll must
  // give up and report null so the caller falls back to COMPANION_CAM.
  test("an old APK yields null after the poll runs dry", async () => {
    const bin = fakeAdb(`case "$*" in *dumpsys*) cat ${import.meta.dir}/fixtures/dumpsys-service-old.txt;; esac`)
    expect(await probeCompanionCams("R5CT", bin, 2)).toBeNull()
  })

  test("a failed service start yields null without polling", async () => {
    const bin = fakeAdb(`case "$*" in *start-foreground-service*) echo "Error: not found";; esac`)
    expect(await probeCompanionCams("R5CT", bin)).toBeNull()
    expect(await probeCompanionCams("R5CT", "/nonexistent/adb")).toBeNull()
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
