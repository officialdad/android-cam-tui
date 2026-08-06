import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { SelectOption } from "@opentui/core"
import { buildArgs, loadConfig, ORIENTATIONS, type StreamConfig } from "../config"
import { checks, probeEnv, type Check, type Env } from "../doctor"
import { goUsb, goWireless, type DeviceInfo } from "../scrcpy/devices"
import { probeCameras, type CameraInfo, type SinkInfo } from "../scrcpy/probe"
import { Doctor } from "./doctor"
import { annotateSizes } from "./sizes"
import { FilteredSelect, Stepper } from "./widgets"

const FIELDS = ["device", "camera", "size", "fps", "zoom", "bitrate", "orientation", "buffer", "sink"] as const
type Field = (typeof FIELDS)[number]
const OUTPUT_FIELDS: Field[] = ["fps", "zoom", "bitrate", "orientation", "buffer", "sink"]

const BITRATES = ["4M", "8M", "16M", "24M", "32M"]
const ZOOM_PRESETS = [0.5, 0.6, 0.8, 1, 1.5, 2, 3, 5, 10]
const BUFFERS = [0, 30, 60, 100, 200]

const ORIENT_LABELS: Record<string, string> = {
  "0": "none",
  "90": "90°",
  "180": "180°",
  "270": "270°",
  flip0: "flip",
  flip90: "flip 90°",
  flip180: "flip 180°",
  flip270: "flip 270°",
}

/** "auto" plus presets strictly inside the camera's range, with both endpoints always reachable. */
export function zoomStops(range: [number, number] | null): (number | null)[] {
  if (!range) return [null]
  const [lo, hi] = range
  if (lo >= hi) return [null, lo]
  return [null, lo, ...ZOOM_PRESETS.filter((z) => z > lo && z < hi), hi]
}

const zoomLabel = (z: number | null) => (z === null ? "auto" : `${z}x`)

/** Next stop after `current`, wrapping. A value not in the list (a config from another phone) lands on the first. */
export function nextStop<T>(stops: T[], current: T): T {
  return stops[(stops.indexOf(current) + 1) % stops.length]
}

/** Keep a saved custom bitrate selectable instead of silently snapping it to a preset. */
export function bitrateStops(current: string): string[] {
  if (BITRATES.includes(current)) return BITRATES
  return [...BITRATES, current].sort((a, b) => parseFloat(a) - parseFloat(b))
}

/** Normal sizes plus any reachable only in high-speed mode, deduped — most devices list both. */
export function camSizes(cam: CameraInfo): string[] {
  return [...new Set([...cam.sizes, ...Object.keys(cam.highSpeed)])]
}

export interface FpsStop {
  fps: number
  highSpeed: boolean
}

/**
 * Frame rates this size can actually run at. The camera-level fps list only applies to
 * sizes in the normal list; high-speed rates are per size and need a different flag, so
 * fps and the mode are picked together rather than as two fields that can disagree.
 */
export function fpsStops(cam: CameraInfo, size: string): FpsStop[] {
  const normal = cam.sizes.includes(size) ? cam.fps.map((fps) => ({ fps, highSpeed: false })) : []
  const fast = (cam.highSpeed[size] ?? []).map((fps) => ({ fps, highSpeed: true }))
  return [...normal, ...fast]
}

export const fpsLabel = (s: FpsStop) => (s.highSpeed ? `${s.fps} hs` : String(s.fps))

export const deviceLabel = (d: DeviceInfo) =>
  [d.serial, d.model, d.state === "device" ? (d.wireless ? "wifi" : "usb") : d.state].filter(Boolean).join("  ")

/**
 * Snap a saved config onto what the selected phone actually reports. A config can
 * name a camera, size or fps that this device does not have — after a device switch
 * it almost always does — so every dependent field is re-validated together.
 */
export function reconcile(cfg: StreamConfig, cams: CameraInfo[], sinks: SinkInfo[]): StreamConfig {
  const cam = cams.find((c) => c.id === cfg.cameraId) ?? cams[0]
  const zoomOk = cfg.zoom !== null && cam.zoomRange && cfg.zoom >= cam.zoomRange[0] && cfg.zoom <= cam.zoomRange[1]
  const all = camSizes(cam)
  const size = all.includes(cfg.size) ? cfg.size : all[0]
  const stops = fpsStops(cam, size)
  // Prefer a normal rate on fallback: high-speed is opt-in, never inherited by accident.
  const stop =
    stops.find((s) => s.fps === cfg.fps && s.highSpeed === cfg.highSpeed) ??
    stops.filter((s) => !s.highSpeed).at(-1) ??
    stops.at(-1)
  return {
    ...cfg,
    cameraId: cam.id,
    size,
    fps: stop?.fps ?? cfg.fps,
    highSpeed: stop?.highSpeed ?? false,
    zoom: zoomOk ? cfg.zoom : null,
    sink: sinks.find((s) => s.path === cfg.sink)?.path ?? sinks[0]?.path ?? cfg.sink,
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * A failure the probe found rather than one `checks()` can see. Pushed onto the same
 * `checkList` so it renders through `<Doctor>` alongside the real warnings — `checkList`
 * is the only source of user-facing dependency truth in this file.
 */
const blocker = (id: string, detail: string, fix: string[]): Check => ({ id, level: "block", ok: false, detail, fix })

export function Setup(props: {
  onStart: (c: StreamConfig) => void
  probes?: {
    cameras(serial: string | null): Promise<CameraInfo[]>
    env(): Promise<Env>
  }
}) {
  const [cameras, setCameras] = useState<CameraInfo[] | null>(null)
  const [sinks, setSinks] = useState<SinkInfo[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [config, setConfig] = useState<StreamConfig | null>(null)
  const [field, setField] = useState<Field>("camera")
  const [checkList, setCheckList] = useState<Check[] | null>(null)
  // A ref, not state: this guard must be true for the *same* keystroke that opens filter
  // mode, and sibling useKeyboard handlers all fire before any re-render can land.
  const capturing = useRef(false)
  const { width } = useTerminalDimensions()
  const wide = width >= 100

  const getCameras = props.probes?.cameras ?? ((serial: string | null) => probeCameras("scrcpy", serial))
  const getEnv = props.probes?.env ?? probeEnv
  // The handlers below are created fresh each render, so a ref keeps the effect's deps empty
  // without them going stale.
  const probesRef = useRef({ getCameras, getEnv })
  probesRef.current = { getCameras, getEnv }

  const preflight = useCallback(async () => {
    setBusy(true)
    // Rebuilt from scratch every run, so a healed environment leaves no stale diagnosis.
    let list: Check[] = []
    try {
      const env = await probesRef.current.getEnv()
      list = checks(env)
      setCheckList(list)
      setDevices(env.devices)
      setSinks(env.sinks)
      if (list.some((c) => c.level === "block" && !c.ok)) return
      const cfg = await loadConfig()
      // Prefer the saved device, else the first one actually usable.
      const pick =
        env.devices.find((d) => d.serial === cfg.serial) ??
        env.devices.find((d) => d.state === "device") ??
        env.devices[0]
      const serial = pick?.serial ?? null
      const cams = await probesRef.current.getCameras(serial)
      if (cams.length === 0) {
        // Routed through Doctor so the `scrcpy-version` warning rides along: "no cameras"
        // plus "you are on scrcpy 2.1" is the actual diagnosis, and `r` comes for free.
        setCheckList([
          ...list,
          blocker("cameras", `no cameras on ${pick?.serial ?? "this phone"} — scrcpy reported none`, [
            "unlock the phone — Android hides the cameras behind the keyguard",
            `scrcpy${serial ? ` -s ${serial}` : ""} --list-cameras`,
          ]),
        ])
        return
      }
      setCameras(cams)
      setConfig(reconcile({ ...cfg, serial }, cams, env.sinks))
    } catch (e) {
      setCheckList([...list, blocker("preflight", `preflight failed: ${errMsg(e)}`, [])])
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void preflight()
  }, [preflight])

  const selectDevice = async (serial: string) => {
    if (!config) return
    setBusy(true)
    setNotice(null)
    try {
      const cams = await probesRef.current.getCameras(serial)
      if (cams.length === 0) {
        setNotice(`no cameras on ${serial}`)
        return
      }
      setCameras(cams)
      setConfig(reconcile({ ...config, serial }, cams, sinks))
    } catch (e) {
      setNotice(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  /** Re-probe after a transport change: the check list has to move with the device list. */
  const refreshEnv = async () => {
    const env = await probesRef.current.getEnv()
    setCheckList(checks(env))
    setDevices(env.devices)
    return env.devices
  }

  const toggleTransport = async () => {
    const current = devices.find((d) => d.serial === config?.serial)
    if (!current) return setNotice("no device selected")
    setBusy(true)
    try {
      if (current.wireless) {
        setNotice("switching back to USB — the cable needs to be plugged in…")
        await goUsb(current.serial)
        const devs = await refreshEnv()
        const usb = devs.find((d) => !d.wireless && d.state === "device")
        // adbd is off the network now, so with no cable there is nothing left to talk to.
        if (!usb) return setNotice("phone is off wifi — plug the USB cable back in")
        await selectDevice(usb.serial)
        setNotice(`usb: ${usb.serial}`)
      } else {
        setNotice("switching to wifi — this restarts adbd on the phone…")
        const serial = await goWireless(current.serial)
        await refreshEnv()
        await selectDevice(serial)
        setNotice(`wifi: ${serial} — USB cable can be unplugged now`)
      }
    } catch (e) {
      setNotice(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  useKeyboard((key) => {
    if (capturing.current) return // a filter query is being typed — don't steal the keystrokes
    if (key.name === "tab") {
      const step = key.shift ? -1 : 1
      setField((f) => FIELDS[(FIELDS.indexOf(f) + step + FIELDS.length) % FIELDS.length])
    }
    if (key.name === "1") setField("camera")
    if (key.name === "2") setField("size")
    if (key.name === "3") setField("fps")
    if (key.name === "w" && !busy) void toggleTransport()
    if (key.name === "return" && config && !busy) props.onStart(config)
  })

  const cam = cameras?.find((c) => c.id === config?.cameraId)
  const sizes = useMemo(() => (cam ? annotateSizes(camSizes(cam)) : []), [cam])

  if (checkList?.some((c) => c.level === "block" && !c.ok)) {
    return <Doctor checks={checkList} busy={busy} onRecheck={() => void preflight()} />
  }
  if (!cameras || !config || !cam) return <text>Probing phone cameras…</text>

  const camOptions: SelectOption[] = cameras.map((c) => ({
    name: `${c.id}  ${c.facing.padEnd(5)} ${c.maxSize}`,
    description: c.zoomRange ? `zoom ${c.zoomRange[0]}–${c.zoomRange[1]}` : "",
    value: c.id,
  }))
  const sizeOptions: SelectOption[] = sizes.map((s) => ({ name: s.label, description: "", value: s.value }))

  const stops = fpsStops(cam, config.size)
  const zooms = zoomStops(cam.zoomRange)
  const bitrates = bitrateStops(config.bitrate)
  const sinkPaths = sinks.length > 0 ? sinks.map((s) => s.path) : [config.sink]
  const sinkLabel = sinks.find((s) => s.path === config.sink)?.label
  const deviceList = devices.length > 0 ? devices : [{ serial: config.serial ?? "?", model: "", wireless: false, state: "device" }]
  const currentDevice = deviceList.find((d) => d.serial === config.serial)
  const outputFocused = OUTPUT_FIELDS.includes(field)

  return (
    <box
      style={{ border: true, padding: 1, flexDirection: "column", gap: 1, height: "100%" }}
      title="android-cam-tui — setup"
    >
      <box style={{ flexDirection: "row", gap: 2 }}>
        <Stepper
          label="device"
          compact
          focused={field === "device"}
          options={deviceList.map(deviceLabel)}
          index={Math.max(0, deviceList.findIndex((d) => d.serial === config.serial))}
          onChange={(i) => void selectDevice(deviceList[i].serial)}
        />
        <text fg="#888">{currentDevice?.wireless ? "w: back to usb" : "w: go wifi"}</text>
      </box>
      {notice && <text fg={busy ? "yellow" : "cyan"}>{notice}</text>}
      {checkList
        ?.filter((c) => c.level === "warn" && !c.ok)
        .map((c) => (
          <text key={c.id} fg="yellow">
            {c.detail}
          </text>
        ))}
      {/* Three stacked sections starve each other for rows on a short terminal, so when
          there is no width for columns only the focused section is shown. Tab cycles them. */}
      <box style={{ flexDirection: wide ? "row" : "column", gap: 1, flexGrow: 1 }}>
        {(wide || field === "camera" || field === "device") && (
          <FilteredSelect
            title="1 camera"
            focused={field === "camera"}
            options={camOptions}
            value={config.cameraId}
            onCaptureChange={(c) => (capturing.current = c)}
            onChange={(v) => {
              const next = cameras.find((c) => c.id === v)!
              setConfig(reconcile({ ...config, cameraId: next.id, zoom: null }, cameras, sinks))
            }}
          />
        )}
        {(wide || field === "size") && (
          <FilteredSelect
            title="2 resolution"
            focused={field === "size"}
            options={sizeOptions}
            value={config.size}
            onCaptureChange={(c) => (capturing.current = c)}
            // A high-speed-only size cannot keep a normal fps (or the reverse), so re-snap.
            onChange={(v) => setConfig(reconcile({ ...config, size: v }, cameras, sinks))}
          />
        )}
        {(wide || outputFocused) && (
          <box
            title="3 output"
            style={{
              border: true,
              borderColor: outputFocused ? "cyan" : undefined,
              padding: 1,
              gap: 1,
              flexDirection: "column",
              width: wide ? 34 : "100%",
            }}
          >
            <Stepper
              label="fps"
              focused={field === "fps"}
              options={stops.map(fpsLabel)}
              index={Math.max(0, stops.findIndex((s) => s.fps === config.fps && s.highSpeed === config.highSpeed))}
              onChange={(i) => setConfig({ ...config, fps: stops[i].fps, highSpeed: stops[i].highSpeed })}
            />
            <Stepper
              label="zoom"
              bar
              focused={field === "zoom"}
              options={zooms.map(zoomLabel)}
              index={Math.max(0, zooms.indexOf(config.zoom))}
              onChange={(i) => setConfig({ ...config, zoom: zooms[i] })}
            />
            <Stepper
              label="bitrate"
              focused={field === "bitrate"}
              options={bitrates}
              index={Math.max(0, bitrates.indexOf(config.bitrate))}
              onChange={(i) => setConfig({ ...config, bitrate: bitrates[i] })}
            />
            <Stepper
              label="rotate"
              compact
              focused={field === "orientation"}
              options={ORIENTATIONS.map((o) => ORIENT_LABELS[o])}
              index={Math.max(0, ORIENTATIONS.indexOf(config.orientation))}
              onChange={(i) => setConfig({ ...config, orientation: ORIENTATIONS[i] })}
            />
            <Stepper
              label="buffer"
              focused={field === "buffer"}
              options={BUFFERS.map((b) => (b === 0 ? "off" : String(b)))}
              index={Math.max(0, BUFFERS.indexOf(config.v4l2Buffer))}
              onChange={(i) => setConfig({ ...config, v4l2Buffer: BUFFERS[i] })}
            />
            <Stepper
              label="sink"
              compact
              focused={field === "sink"}
              options={sinkPaths}
              index={Math.max(0, sinkPaths.indexOf(config.sink))}
              onChange={(i) => setConfig({ ...config, sink: sinkPaths[i] })}
            />
            {sinkLabel && <text fg="#888">         {sinkLabel}</text>}
          </box>
        )}
      </box>
      <text fg="#888">scrcpy {buildArgs(config).join(" ")}</text>
      <text fg="cyan">↹ next · ⇧↹ prev · 1-3 jump · / filter · ↑↓ pick · ←→ adjust · w usb/wifi · ⏎ start</text>
    </box>
  )
}
