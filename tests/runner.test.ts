import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "../src/config"
import { StreamRunner, type StreamEvent } from "../src/scrcpy/runner"

const FAKE = new URL("./fixtures/fake-scrcpy.sh", import.meta.url).pathname

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
    const r = new StreamRunner({ scrcpyPath: FAKE, restartDelayMs: 50, onEvent })
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
    const r = new StreamRunner({ scrcpyPath: FAKE, restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    await sleep(100)
    await r.stop()
    await sleep(200)
    expect(r.state).toBe("stopped")
    expect(events.map((e) => e.kind)).not.toContain("restarting")
  })

  test("stop() during the restart backoff prevents the respawn", async () => {
    const { events, onEvent } = collect()
    const r = new StreamRunner({ scrcpyPath: fakeScrcpy("exit 1"), restartDelayMs: 400, onEvent })
    await r.start(DEFAULT_CONFIG)
    await waitFor(() => events.some((e) => e.kind === "restarting"))
    await r.stop() // lands mid-backoff; the epoch bump has to abort the pending spawn
    await sleep(600)
    expect(r.state).toBe("stopped")
    expect(events.filter((e) => e.kind === "started").length).toBe(1)
  })

  const DIES_WITH_ERROR = 'echo "ERROR: Could not open v4l2 device: /dev/video9" >&2\nexit 1'

  test("surfaces scrcpy's error line with the exit code", async () => {
    const { events, onEvent } = collect()
    const r = new StreamRunner({
      scrcpyPath: fakeScrcpy(DIES_WITH_ERROR),
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
         const r = new StreamRunner({ scrcpyPath: ${JSON.stringify(scrcpy)}, onEvent() {} })
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
    const r = new StreamRunner({ scrcpyPath: FAKE, restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    await sleep(100)
    await r.restart(DEFAULT_CONFIG)
    await sleep(100)
    expect(r.state).toBe("running")
    const startedEvents = events.filter((e) => e.kind === "started")
    expect(startedEvents.length).toBe(2)
  })

  const COMPANION = { ...DEFAULT_CONFIG, backend: "companion" as const, serial: "R5CT" }
  const UNIX_READY = `cat ${import.meta.dir}/fixtures/proc-net-unix-ready.txt`
  const UNIX_COLD = `cat ${import.meta.dir}/fixtures/proc-net-unix-cold.txt`

  test("companion backend preps the phone, then spawns ffmpeg", async () => {
    const { events, onEvent } = collect()
    const log = join(mkdtempSync(join(tmpdir(), "adblog-")), "calls")
    const r = new StreamRunner({
      adbPath: fakeScrcpy(`echo "$@" >> ${log}\ncase "$*" in *"/proc/net/unix"*) ${UNIX_READY};; esac`),
      ffmpegPath: fakeScrcpy("sleep 600"),
      restartDelayMs: 50,
      onEvent,
    })
    await r.start(COMPANION)
    await waitFor(() => events.some((e) => e.kind === "started"))
    await r.stop()
    const calls = await Bun.file(log).text()
    expect(calls).toContain("forward tcp:27183 localabstract:android-cam")
    expect(calls).toContain("am start-foreground-service")
    expect(r.state).toBe("stopped")
  })

  // The prep is three adb round-trips of awaits. Without an epoch re-check after them, a
  // stop() landing mid-prep leaves ffmpeg spawned and holding the sink.
  test("stop() during the prep never spawns ffmpeg", async () => {
    const { events, onEvent } = collect()
    const r = new StreamRunner({
      adbPath: fakeScrcpy(`case "$*" in *"/proc/net/unix"*) ${UNIX_COLD};; esac`),
      ffmpegPath: fakeScrcpy("sleep 600"),
      restartDelayMs: 50,
      onEvent,
    })
    void r.start(COMPANION)
    await sleep(150) // mid socket-poll
    await r.stop()
    await sleep(600)
    expect(events.filter((e) => e.kind === "started").length).toBe(0)
    expect(r.state).toBe("stopped")
  })

  // A phone still booting is exactly what retries are for, so a prep failure has to land in
  // the same backoff path as a stream that died — not as an unhandled rejection.
  test("a prep failure reports the reason and retries", async () => {
    const { events, onEvent } = collect()
    const r = new StreamRunner({
      adbPath: fakeScrcpy(`case "$*" in *forward*) echo "error: device offline" >&2; exit 1;; esac`),
      ffmpegPath: fakeScrcpy("sleep 600"),
      restartDelayMs: 20,
      maxAttempts: 1,
      onEvent,
    })
    await r.start(COMPANION)
    await waitFor(() => events.some((e) => e.kind === "gave-up"))
    await r.stop()
    const exited = events.find((e) => e.kind === "exited") as Extract<StreamEvent, { kind: "exited" }>
    expect(exited.reason).toContain("device offline")
    expect(events.map((e) => e.kind)).toContain("restarting")
  })
})
