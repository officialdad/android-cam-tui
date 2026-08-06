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

/** Throwaway fake scrcpy with the behaviour baked in — env vars don't reach spawned children here. */
function fakeScrcpy(body: string) {
  const bin = join(mkdtempSync(join(tmpdir(), "scrcpy-")), "scrcpy")
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}

function collect() {
  const events: StreamEvent[] = []
  return { events, onEvent: (e: StreamEvent) => events.push(e) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll instead of budgeting wall-clock — a loaded CI runner misses a fixed sleep. */
async function waitFor(pred: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!pred() && Date.now() < deadline) await sleep(10)
}

describe("StreamRunner", () => {
  test("classifies eviction death and auto-restarts", async () => {
    const { events, onEvent } = collect()
    process.env.MODE = "die-evicted"
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: "true", restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    // fake dies at ~200ms, restarts 50ms later, dies again — wait for the second restart
    const restarts = () => events.filter((e) => e.kind === "restarting").length
    await waitFor(() => restarts() >= 2)
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

  const DIES_WITH_ERROR = 'echo "ERROR: Could not open v4l2 device: /dev/video9" >&2\nexit 1'

  test("surfaces scrcpy's error line with the exit code", async () => {
    const { events, onEvent } = collect()
    const r = new StreamRunner({
      scrcpyPath: fakeScrcpy(DIES_WITH_ERROR),
      adbPath: "true",
      restartDelayMs: 10,
      onEvent,
    })
    await r.start(DEFAULT_CONFIG)
    await sleep(300)
    await r.stop()
    const exited = events.find((e) => e.kind === "exited") as Extract<StreamEvent, { kind: "exited" }>
    expect(exited.code).toBe(1)
    expect(exited.reason).toBe("ERROR: Could not open v4l2 device: /dev/video9")
  })

  test("gives up instead of respawning a config scrcpy rejects forever", async () => {
    const { events, onEvent } = collect()
    const r = new StreamRunner({
      scrcpyPath: fakeScrcpy(DIES_WITH_ERROR),
      adbPath: "true",
      restartDelayMs: 10,
      maxAttempts: 2,
      onEvent,
    })
    await r.start(DEFAULT_CONFIG)
    await sleep(1500)
    expect(events.filter((e) => e.kind === "restarting").length).toBe(2)
    const gaveUp = events.find((e) => e.kind === "gave-up") as Extract<StreamEvent, { kind: "gave-up" }>
    expect(gaveUp?.attempts).toBe(2)
    expect(r.state).toBe("stopped")
    expect(events.filter((e) => e.kind === "started").length).toBe(3) // initial + 2 retries
  })

  test("kills scrcpy when the parent process exits", async () => {
    const pidfile = join(mkdtempSync(join(tmpdir(), "orphan-")), "pid")
    const scrcpy = fakeScrcpy(`echo $$ > ${pidfile}\nsleep 600`)
    const runner = new URL("../src/scrcpy/runner.ts", import.meta.url).pathname
    const config = new URL("../src/config.ts", import.meta.url).pathname
    // A child that exits on its own, the way opentui's signal handlers exit on Ctrl+C.
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `const { StreamRunner } = await import(${JSON.stringify(runner)})
         const { DEFAULT_CONFIG } = await import(${JSON.stringify(config)})
         const r = new StreamRunner({ scrcpyPath: ${JSON.stringify(scrcpy)}, adbPath: "true", onEvent() {} })
         await r.start(DEFAULT_CONFIG)
         setTimeout(() => process.exit(0), 200)`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    await child.exited
    await sleep(200)
    const pid = Number(readFileSync(pidfile, "utf8").trim())
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow() // reaped, not orphaned holding the sink
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
