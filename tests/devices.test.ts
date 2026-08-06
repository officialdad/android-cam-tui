import { describe, expect, test } from "bun:test"
import { parseDevices } from "../src/scrcpy/devices"

const realUsb = `List of devices attached
RFCW10PK5MF            device usb:5-3 product:dm1qxxx model:SM_S911B device:dm1q transport_id:13

`

describe("parseDevices", () => {
  test("parses the real single-USB-device listing", () => {
    expect(parseDevices(realUsb)).toEqual([
      { serial: "RFCW10PK5MF", model: "SM_S911B", wireless: false, state: "device" },
    ])
  })

  test("flags ip:port serials as wireless alongside USB ones", () => {
    const text = `List of devices attached
RFCW10PK5MF            device usb:5-3 product:dm1qxxx model:SM_S911B device:dm1q transport_id:13
192.168.1.42:5555      device product:dm1qxxx model:SM_S911B device:dm1q transport_id:14
`
    expect(parseDevices(text)).toEqual([
      { serial: "RFCW10PK5MF", model: "SM_S911B", wireless: false, state: "device" },
      { serial: "192.168.1.42:5555", model: "SM_S911B", wireless: true, state: "device" },
    ])
  })

  test("model is empty when adb reports none", () => {
    const text = `List of devices attached
RFCW10PK5MF            device usb:5-3 transport_id:13
`
    expect(parseDevices(text)[0].model).toBe("")
  })

  test("keeps unusable devices with their state", () => {
    const text = `List of devices attached
RFCW10PK5MF            unauthorized usb:5-3 transport_id:2
0123456789ABCDEF       offline transport_id:3
`
    expect(parseDevices(text).map((d) => [d.serial, d.state])).toEqual([
      ["RFCW10PK5MF", "unauthorized"],
      ["0123456789ABCDEF", "offline"],
    ])
  })

  test("ignores adb daemon startup noise", () => {
    const text = `* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
RFCW10PK5MF            device usb:5-3 model:SM_S911B transport_id:13
`
    expect(parseDevices(text).map((d) => d.serial)).toEqual(["RFCW10PK5MF"])
  })

  test("empty and header-only input yield no devices", () => {
    expect(parseDevices("")).toEqual([])
    expect(parseDevices("List of devices attached\n\n")).toEqual([])
  })
})
