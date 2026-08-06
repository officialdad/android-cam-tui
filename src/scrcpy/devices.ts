export interface DeviceInfo {
  serial: string
  model: string
  wireless: boolean
  state: string
}

const WIRELESS_RE = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/

export function parseDevices(text: string): DeviceInfo[] {
  const devices: DeviceInfo[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    // blank lines, the header, and adb's "* daemon ..." startup noise
    if (!trimmed || trimmed.startsWith("*") || /^List of devices/.test(trimmed)) continue
    const m = trimmed.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/)
    if (!m) continue
    devices.push({
      serial: m[1],
      model: m[3]?.match(/(?:^|\s)model:(\S+)/)?.[1] ?? "",
      wireless: WIRELESS_RE.test(m[1]),
      state: m[2],
    })
  }
  return devices
}

async function adb(cmd: string[]): Promise<{ out: string; code: number }> {
  let proc: Bun.Subprocess
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  } catch {
    throw new Error(`${cmd[0]} not found — is adb installed and on PATH?`)
  }
  const [out, err] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  const code = await proc.exited
  return { out: out + err, code }
}

export async function listDevices(adbPath = "adb"): Promise<DeviceInfo[]> {
  try {
    const { out } = await adb([adbPath, "devices", "-l"])
    return parseDevices(out)
  } catch {
    return [] // caller renders its own "no adb" message
  }
}

export async function goWireless(serial: string, adbPath = "adb"): Promise<string> {
  const tcpip = await adb([adbPath, "-s", serial, "tcpip", "5555"])
  if (tcpip.code !== 0) throw new Error(tcpip.out.trim() || `adb tcpip 5555 failed for ${serial}`)
  await Bun.sleep(1000) // tcpip restarts adbd; connecting too early just fails

  const wlan = await adb([
    adbPath, "-s", serial, "shell", "ip", "-f", "inet", "addr", "show", "wlan0",
  ])
  let ip = wlan.out.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1]
  if (!ip) {
    const route = await adb([adbPath, "-s", serial, "shell", "ip", "route"])
    ip = route.out.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1]
  }
  if (!ip) throw new Error("no WLAN address — is the phone on WiFi?")

  const connect = await adb([adbPath, "connect", `${ip}:5555`])
  // adb reports connect failures on stdout with exit code 0, so trust the text
  if (!connect.out.includes("connected")) {
    throw new Error(connect.out.trim() || `adb connect ${ip}:5555 failed`)
  }
  return `${ip}:5555`
}

/**
 * Reverse of goWireless: put adbd back on USB and drop the TCP connection, so the phone
 * stops listening on 5555. Only recoverable with the cable — the `usb` command kills the
 * very link carrying it, so neither call is expected to report success and both are
 * best-effort. The caller re-lists devices to find out what actually survived.
 */
export async function goUsb(serial: string, adbPath = "adb"): Promise<void> {
  await adb([adbPath, "-s", serial, "usb"]).catch(() => undefined)
  await Bun.sleep(1000) // adbd is restarting; disconnecting too early leaves a stale entry
  await adb([adbPath, "disconnect", serial]).catch(() => undefined)
}
