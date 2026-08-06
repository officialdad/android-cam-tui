import { useEffect, useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { SelectOption } from "@opentui/core"
import { buildArgs, loadConfig, type StreamConfig } from "../config"
import { probeCameras, probeSinks, type CameraInfo, type SinkInfo } from "../scrcpy/probe"

const FIELDS = ["camera", "size", "fps", "zoom", "bitrate", "sink"] as const
type Field = (typeof FIELDS)[number]

export function Setup(props: { onStart: (c: StreamConfig) => void }) {
  const [cameras, setCameras] = useState<CameraInfo[] | null>(null)
  const [sinks, setSinks] = useState<SinkInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<StreamConfig | null>(null)
  const [field, setField] = useState<Field>("camera")

  useEffect(() => {
    Promise.all([probeCameras(), probeSinks(), loadConfig()])
      .then(([cams, sk, cfg]) => {
        if (cams.length === 0) {
          setError("No cameras found — is the phone plugged in with USB debugging on?")
          return
        }
        setCameras(cams)
        setSinks(sk)
        const validCam = cams.find((c) => c.id === cfg.cameraId) ?? cams[0]
        const sink = sk.find((s) => s.path === cfg.sink)?.path ?? sk[0]?.path ?? cfg.sink
        const size = validCam.sizes.includes(cfg.size) ? cfg.size : validCam.sizes[0]
        const fps = validCam.fps.includes(cfg.fps) ? cfg.fps : validCam.fps[validCam.fps.length - 1]
        const zoom =
          cfg.zoom !== null && validCam.zoomRange && cfg.zoom >= validCam.zoomRange[0] && cfg.zoom <= validCam.zoomRange[1]
            ? cfg.zoom
            : null
        setConfig({ ...cfg, cameraId: validCam.id, sink, size, fps, zoom })
      })
      .catch((e) => setError(`Probe failed: ${e.message} — is scrcpy installed?`))
  }, [])

  useKeyboard((key) => {
    if (key.name === "tab") {
      setField((f) => FIELDS[(FIELDS.indexOf(f) + 1) % FIELDS.length])
    }
    if (key.name === "return" && config) props.onStart(config)
  })

  if (error) {
    return (
      <box style={{ border: true, padding: 1, flexDirection: "column" }}>
        <text fg="red">{error}</text>
        <text fg="#888">Fix and restart. USB debugging: Settings → Developer options.</text>
      </box>
    )
  }
  if (!cameras || !config) return <text>Probing phone cameras…</text>

  const cam = cameras.find((c) => c.id === config.cameraId)!
  const camOptions: SelectOption[] = cameras.map((c) => ({
    name: `${c.id}: ${c.facing} ${c.maxSize}`,
    description: c.zoomRange ? `zoom ${c.zoomRange[0]}–${c.zoomRange[1]}` : "",
    value: c.id,
  }))
  const sizeOptions: SelectOption[] = cam.sizes.map((s) => ({ name: s, description: "", value: s }))
  const fpsOptions: SelectOption[] = cam.fps.map((f) => ({ name: String(f), description: "", value: String(f) }))
  const sinkOptions: SelectOption[] =
    sinks.length > 0
      ? sinks.map((s) => ({ name: s.path, description: s.label, value: s.path }))
      : [{ name: "none found", description: "load v4l2loopback first", value: config.sink }]

  return (
    <box style={{ border: true, padding: 1, flexDirection: "column", gap: 1 }} title="android-cam-tui — setup">
      {sinks.length === 0 && (
        <text fg="yellow">
          No v4l2loopback sink. Run: sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"
        </text>
      )}
      <box title={`camera${field === "camera" ? " *" : ""}`} style={{ border: true, height: 6 }}>
        <select style={{ height: 4 }}
          focused={field === "camera"}
          options={camOptions}
          selectedIndex={Math.max(0, cameras.findIndex((c) => c.id === config.cameraId))}
          onChange={(_, o) => {
            if (!o) return
            const next = cameras.find((c) => c.id === o.value)!
            setConfig({
              ...config,
              cameraId: next.id,
              size: next.sizes.includes(config.size) ? config.size : next.sizes[0],
              fps: next.fps.includes(config.fps) ? config.fps : next.fps[next.fps.length - 1],
              zoom: null,
            })
          }}
        />
      </box>
      <box title={`size${field === "size" ? " *" : ""}`} style={{ border: true, height: 6 }}>
        <select style={{ height: 4 }}
          focused={field === "size"}
          options={sizeOptions}
          selectedIndex={Math.max(0, cam.sizes.indexOf(config.size))}
          onChange={(_, o) => o && setConfig({ ...config, size: String(o.value) })}
        />
      </box>
      <box title={`fps${field === "fps" ? " *" : ""}`} style={{ border: true, height: 5 }}>
        <select style={{ height: 3 }}
          focused={field === "fps"}
          options={fpsOptions}
          selectedIndex={Math.max(0, cam.fps.indexOf(config.fps))}
          onChange={(_, o) => o && setConfig({ ...config, fps: Number(o.value) })}
        />
      </box>
      <box title={`zoom (blank = default)${field === "zoom" ? " *" : ""}`} style={{ border: true, height: 3 }}>
        <input
          focused={field === "zoom"}
          placeholder={cam.zoomRange ? `${cam.zoomRange[0]}–${cam.zoomRange[1]}, e.g. 0.6` : "n/a"}
          onInput={(v: string) => {
            const n = Number(v)
            setConfig({ ...config, zoom: v.trim() === "" || !Number.isFinite(n) ? null : n })
          }}
        />
      </box>
      <box title={`bitrate${field === "bitrate" ? " *" : ""}`} style={{ border: true, height: 3 }}>
        <input
          focused={field === "bitrate"}
          placeholder={config.bitrate}
          onInput={(v: string) => setConfig({ ...config, bitrate: v.trim() || "16M" })}
        />
      </box>
      <box title={`sink${field === "sink" ? " *" : ""}`} style={{ border: true, height: 4 }}>
        <select style={{ height: 2 }}
          focused={field === "sink"}
          options={sinkOptions}
          selectedIndex={Math.max(0, sinks.findIndex((s) => s.path === config.sink))}
          onChange={(_, o) => o && setConfig({ ...config, sink: String(o.value) })}
        />
      </box>
      <text fg="#888">scrcpy {buildArgs(config).join(" ")}</text>
      <text fg="cyan">Tab: next field · Enter: start stream</text>
    </box>
  )
}
