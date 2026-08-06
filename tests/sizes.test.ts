import { describe, expect, test } from "bun:test"
import { annotateSizes } from "../src/ui/sizes"

describe("annotateSizes", () => {
  test("sorts descending by pixel count", () => {
    const out = annotateSizes(["640x480", "3840x2160", "1280x720", "1920x1080"])
    expect(out.map((o) => o.value)).toEqual(["3840x2160", "1920x1080", "1280x720", "640x480"])
  })

  test("reduces aspect ratio via gcd", () => {
    const [cif] = annotateSizes(["352x288"])
    expect(cif.label).toBe("352x288  11:9")
    expect(annotateSizes(["1280x1024"])[0].label).toBe("1280x1024  5:4")
  })

  test("tags common names, nothing else", () => {
    const labels = annotateSizes(["3840x2160", "2560x1440", "1920x1080", "1280x720", "854x480", "640x480", "1600x1200"])
      .map((o) => o.label.trim().split(/\s+/).slice(2).join(""))
    expect(labels).toEqual(["4K", "QHD", "FHD", "", "HD", "480p", "480p"])
  })

  test("pads columns from the actual input set", () => {
    const out = annotateSizes(["4000x3000", "640x480", "1920x1080"])
    expect(out.map((o) => o.label)).toEqual([
      "4000x3000  4:3",
      "1920x1080  16:9  FHD",
      "640x480    4:3   480p",
    ])
    // aspect column starts at the same index in every row
    const cols = out.map((o) => o.label.search(/\d+:\d+/))
    expect(new Set(cols).size).toBe(1)
  })

  test("keeps malformed input, sorts it last", () => {
    const out = annotateSizes(["640x480", "unknown", "1920x1080"])
    expect(out.map((o) => o.value)).toEqual(["1920x1080", "640x480", "unknown"])
    expect(out[2].label).toBe("unknown")
  })
})
