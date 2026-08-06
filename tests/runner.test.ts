import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config"
import { StreamRunner, type StreamEvent } from "../src/scrcpy/runner"

const FAKE = new URL("./fixtures/fake-scrcpy.sh", import.meta.url).pathname
const SLOW_ADB = new URL("./fixtures/slow-adb.sh", import.meta.url).pathname

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
})
