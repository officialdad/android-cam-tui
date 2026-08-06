import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config"
import { StreamRunner, type StreamEvent } from "../src/scrcpy/runner"

const FAKE = new URL("./fixtures/fake-scrcpy.sh", import.meta.url).pathname
const SLOW_ADB = new URL("./fixtures/slow-adb.sh", import.meta.url).pathname

/** Throwaway fake adb that records each invocation's argv, same injection seam as SLOW_ADB. */
function recordingAdb() {
  const dir = mkdtempSync(join(tmpdir(), "adb-argv-"))
  const bin = join(dir, "adb")
  const log = join(dir, "argv.log")
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\n`, { mode: 0o755 })
  return { bin, argv: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []) }
}

function collect() {
  const events: StreamEvent[] = []
  return { events, onEvent: (e: StreamEvent) => events.push(e) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("StreamRunner", () => {
  test("classifies eviction death and auto-restarts", async () => {
    const { events, onEvent } = collect()
    process.env.MODE = "die-evicted"
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: "true", restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    await sleep(700) // fake dies at ~200ms, restart at ~250ms, dies again ~450ms
    await r.stop()
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain("started")
    expect(kinds).toContain("camera-evicted")
    expect(kinds).toContain("device-lost")
    expect(kinds).toContain("restarting")
    const attempts = events.filter((e) => e.kind === "restarting").map((e: any) => e.attempt)
    expect(attempts[0]).toBe(1)
    expect(attempts.length).toBeGreaterThanOrEqual(2)
  })

  test("stop() prevents restart and reaches stopped state", async () => {
    const { events, onEvent } = collect()
    process.env.MODE = "run-forever"
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: "true", restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    await sleep(100)
    await r.stop()
    await sleep(200)
    expect(r.state).toBe("stopped")
    expect(events.map((e) => e.kind)).not.toContain("restarting")
  })

  test("start/stop race: stop() during prepPhone() prevents spawn", async () => {
    const { events, onEvent } = collect()
    process.env.MODE = "run-forever"
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: SLOW_ADB, restartDelayMs: 50, onEvent })
    const startPromise = r.start(DEFAULT_CONFIG)
    await sleep(50) // stop during prepPhone (which sleeps 200ms)
    await r.stop()
    await startPromise
    await sleep(100) // wait for any pending spawns
    expect(r.state).toBe("stopped")
    expect(events.map((e) => e.kind)).not.toContain("started")
  })

  test("prepPhone() argv is unchanged when no serial is set", async () => {
    const { onEvent } = collect()
    process.env.MODE = "run-forever"
    const adb = recordingAdb()
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: adb.bin, restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    await r.stop()
    expect(adb.argv()).toEqual(["shell input keyevent KEYCODE_WAKEUP", "shell wm dismiss-keyguard"])
  })

  test("prepPhone() puts -s <serial> before the shell subcommand", async () => {
    const { onEvent } = collect()
    process.env.MODE = "run-forever"
    const adb = recordingAdb()
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: adb.bin, restartDelayMs: 50, onEvent })
    await r.start({ ...DEFAULT_CONFIG, serial: "192.168.1.5:5555" })
    await r.stop()
    expect(adb.argv()).toEqual([
      "-s 192.168.1.5:5555 shell input keyevent KEYCODE_WAKEUP",
      "-s 192.168.1.5:5555 shell wm dismiss-keyguard",
    ])
  })

  test("restart() works and generates two started events", async () => {
    const { events, onEvent } = collect()
    process.env.MODE = "run-forever"
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: "true", restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    await sleep(100)
    await r.restart(DEFAULT_CONFIG)
    await sleep(100)
    expect(r.state).toBe("running")
    const startedEvents = events.filter((e) => e.kind === "started")
    expect(startedEvents.length).toBe(2)
  })
})
