import { buildArgs, type StreamConfig } from "../config"

export type StreamEvent =
  | { kind: "started" }
  | { kind: "camera-evicted" }
  | { kind: "device-lost" }
  | { kind: "exited"; code: number | null; reason: string | null }
  | { kind: "restarting"; attempt: number }
  | { kind: "gave-up"; attempts: number }

export type RunnerState = "idle" | "running" | "restarting" | "stopped"

interface RunnerOpts {
  scrcpyPath?: string
  adbPath?: string
  restartDelayMs?: number
  maxAttempts?: number
  onEvent: (e: StreamEvent) => void
}

/**
 * Bun does not reap children when the parent exits, so a Ctrl+C would leave scrcpy
 * holding the camera and the v4l2 sink — the next run then fails with a "device busy"
 * that points nowhere. `exit` fires for every path opentui's own signal handlers take,
 * and kill() is synchronous, which is all an exit listener is allowed to be.
 */
const live = new Set<StreamRunner>()
let hooked = false
function killChildrenOnExit(): void {
  if (hooked) return
  hooked = true
  process.on("exit", () => {
    for (const r of live) r.kill()
  })
}

export class StreamRunner {
  state: RunnerState = "idle"
  startedAt: number | null = null
  private proc: Bun.Subprocess | null = null
  private config!: StreamConfig
  private attempt = 0
  private epoch = 0
  private lastLine: string | null = null
  private lastError: string | null = null
  private readonly scrcpyPath: string
  private readonly adbPath: string
  private readonly restartDelayMs: number
  private readonly maxAttempts: number
  private readonly onEvent: (e: StreamEvent) => void

  constructor(opts: RunnerOpts) {
    this.scrcpyPath = opts.scrcpyPath ?? "scrcpy"
    this.adbPath = opts.adbPath ?? "adb"
    this.restartDelayMs = opts.restartDelayMs ?? 2000
    this.maxAttempts = opts.maxAttempts ?? 6
    this.onEvent = opts.onEvent
    killChildrenOnExit()
  }

  /** Synchronous teardown for the process `exit` hook — no awaiting allowed there. */
  kill(): void {
    this.epoch++
    this.proc?.kill()
  }

  async start(config: StreamConfig): Promise<void> {
    this.config = config
    this.attempt = 0
    const myEpoch = ++this.epoch
    this.state = "idle"
    await this.prepPhone()
    if (this.epoch !== myEpoch) return // stop() or newer start() superseded us
    this.spawn()
  }

  async restart(config: StreamConfig): Promise<void> {
    await this.stop()
    await this.start(config)
  }

  async stop(): Promise<void> {
    this.epoch++
    this.state = "stopped"
    live.delete(this)
    if (this.proc) {
      this.proc.kill()
      await this.proc.exited
      this.proc = null
    }
  }

  private async prepPhone(): Promise<void> {
    // Samsung evicts adb camera clients the moment the keyguard engages.
    const sel = this.config.serial ? ["-s", this.config.serial] : [] // must precede `shell`
    for (const args of [
      ["shell", "input", "keyevent", "KEYCODE_WAKEUP"],
      ["shell", "wm", "dismiss-keyguard"],
    ]) {
      try {
        await Bun.spawn([this.adbPath, ...sel, ...args], { stdout: "ignore", stderr: "ignore" })
          .exited
      } catch {
        // phone prep is best-effort
      }
    }
  }

  private spawn(): void {
    this.state = "running"
    this.startedAt = Date.now()
    this.lastLine = null
    this.lastError = null
    live.add(this)
    this.proc = Bun.spawn([this.scrcpyPath, ...buildArgs(this.config)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    this.onEvent({ kind: "started" })
    this.watch(this.proc.stdout as ReadableStream)
    this.watch(this.proc.stderr as ReadableStream)
    this.proc.exited.then((code) => this.onExit(code))
  }

  private async watch(stream: ReadableStream): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ""
    for await (const chunk of stream) {
      buf += decoder.decode(chunk)
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.includes("Camera disconnected")) this.onEvent({ kind: "camera-evicted" })
        if (line.includes("Device disconnected")) this.onEvent({ kind: "device-lost" })
        // Everything else scrcpy prints is dropped, so a fatal ("Could not open v4l2
        // device", an unsupported size) would otherwise surface as a bare exit code.
        if (line) this.lastLine = line
        if (/\bERROR\b/.test(line)) this.lastError = line
      }
    }
  }

  private async onExit(code: number | null): Promise<void> {
    if (this.state !== "running") return
    const myEpoch = this.epoch
    this.onEvent({ kind: "exited", code, reason: this.lastError ?? this.lastLine })
    // A stream that ran a while and then died is a fresh incident, not an escalation:
    // a phone that locks once an hour must not exhaust the attempt budget.
    if (this.startedAt && Date.now() - this.startedAt > 60_000) this.attempt = 0
    this.attempt += 1
    if (this.attempt > this.maxAttempts) {
      this.state = "stopped"
      live.delete(this)
      this.onEvent({ kind: "gave-up", attempts: this.attempt - 1 })
      return
    }
    this.state = "restarting"
    this.onEvent({ kind: "restarting", attempt: this.attempt })
    // Backoff: a config scrcpy rejects instantly would otherwise respawn twice a second forever.
    await new Promise((r) => setTimeout(r, Math.min(30_000, this.restartDelayMs * 2 ** (this.attempt - 1))))
    if (this.epoch !== myEpoch) return // stop() called, abort restart
    await this.prepPhone()
    if (this.epoch !== myEpoch) return // stop() called during prepPhone()
    this.spawn()
  }
}
