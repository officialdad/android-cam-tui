import { describe, expect, test } from "bun:test"
import { detectDistro, parseScrcpyVersion } from "../src/doctor"

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text()

describe("detectDistro", () => {
  test("reads ID first", async () => {
    expect(detectDistro(await fixture("os-release-fedora.txt"))).toBe("fedora")
  })

  test("falls back to ID_LIKE when ID is a derivative", async () => {
    expect(detectDistro(await fixture("os-release-cachyos.txt"))).toBe("arch")
    expect(detectDistro(await fixture("os-release-ubuntu.txt"))).toBe("debian")
  })

  test("maps a derivative of a derivative through the alias table", async () => {
    // Mint's ID_LIKE is `ubuntu`, which is itself not one of the five families.
    expect(detectDistro(await fixture("os-release-mint.txt"))).toBe("debian")
  })

  test("strips quotes and scans every ID_LIKE token", async () => {
    expect(detectDistro(await fixture("os-release-tumbleweed.txt"))).toBe("suse")
  })

  test("returns unknown when neither key matches", async () => {
    expect(detectDistro(await fixture("os-release-bare.txt"))).toBe("unknown")
    expect(detectDistro("")).toBe("unknown")
  })
})

describe("parseScrcpyVersion", () => {
  test("reads the real --version banner", () => {
    expect(parseScrcpyVersion("scrcpy 4.1 <https://github.com/Genymobile/scrcpy>")).toEqual([4, 1])
  })

  test("reads a two-digit minor", () => {
    expect(parseScrcpyVersion("scrcpy 2.10")).toEqual([2, 10])
  })

  test("returns null on anything else", () => {
    expect(parseScrcpyVersion("")).toBeNull()
    expect(parseScrcpyVersion("command not found")).toBeNull()
  })
})
