import { buildArgs, type StreamConfig } from "../config"

export type StreamEvent =
  | { kind: "started" }
  | { kind: "camera-evicted" }
  | { kind: "device-lost" }
  | { kind: "exited"; code: number | null }
  | { kind: "restarting"; attempt: number }

export type RunnerState = "idle" | "running" | "restarting" | "stopped"

interface RunnerOpts {
  scrcpyPath?: string
  adbPath?: string
  restartDelayMs?: number
  onEvent: (e: StreamEvent) => void
}

export class StreamRunner {
  state: RunnerState = "idle"
  startedAt: number | null = null
  private proc: Bun.Subprocess | null = null
  private config!: StreamConfig
  private attempt = 0
  private epoch = 0
  private readonly scrcpyPath: string
  private readonly adbPath: string
  private readonly restartDelayMs: number
  private readonly onEvent: (e: StreamEvent) => void

  constructor(opts: RunnerOpts) {
    this.scrcpyPath = opts.scrcpyPath ?? "scrcpy"
    this.adbPath = opts.adbPath ?? "adb"
    this.restartDelayMs = opts.restartDelayMs ?? 2000
    this.onEvent = opts.onEvent
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
    if (this.proc) {
      this.proc.kill()
      await this.proc.exited
      this.proc = null
    }
  }

  private async prepPhone(): Promise<void> {
    // Samsung evicts adb camera clients the moment the keyguard engages.
    for (const args of [
      ["shell", "input", "keyevent", "KEYCODE_WAKEUP"],
      ["shell", "wm", "dismiss-keyguard"],
    ]) {
      try {
        await Bun.spawn([this.adbPath, ...args], { stdout: "ignore", stderr: "ignore" }).exited
      } catch {
        // phone prep is best-effort
      }
    }
  }

  private spawn(): void {
    this.state = "running"
    this.startedAt = Date.now()
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
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.includes("Camera disconnected")) this.onEvent({ kind: "camera-evicted" })
        if (line.includes("Device disconnected")) this.onEvent({ kind: "device-lost" })
      }
    }
  }

  private async onExit(code: number | null): Promise<void> {
    if (this.state !== "running") return
    const myEpoch = this.epoch
    this.onEvent({ kind: "exited", code })
    this.attempt += 1
    this.state = "restarting"
    this.onEvent({ kind: "restarting", attempt: this.attempt })
    await new Promise((r) => setTimeout(r, this.restartDelayMs))
    if (this.epoch !== myEpoch) return // stop() called, abort restart
    await this.prepPhone()
    if (this.epoch !== myEpoch) return // stop() called during prepPhone()
    this.spawn()
  }
}
