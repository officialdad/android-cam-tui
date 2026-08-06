export interface SizeOption {
  value: string
  label: string
}

const TAGS: Record<string, string> = {
  "3840x2160": "4K",
  "2560x1440": "QHD",
  "1920x1080": "FHD",
  "1280x720": "HD",
  "854x480": "480p",
  "640x480": "480p",
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

export function annotateSizes(sizes: string[]): SizeOption[] {
  const parsed = sizes.map((value) => {
    const m = value.match(/^(\d+)x(\d+)$/)
    if (!m) return { value, px: 0, aspect: "" }
    const w = Number(m[1])
    const h = Number(m[2])
    const d = gcd(w, h) || 1
    return { value, px: w * h, aspect: `${w / d}:${h / d}` }
  })
  parsed.sort((a, b) => b.px - a.px)

  const valueWidth = Math.max(0, ...parsed.map((p) => p.value.length))
  const aspectWidth = Math.max(0, ...parsed.map((p) => p.aspect.length))

  return parsed.map(({ value, px, aspect }) => ({
    value,
    label:
      px === 0
        ? value
        : `${value.padEnd(valueWidth)}  ${aspect.padEnd(aspectWidth)}  ${TAGS[value] ?? ""}`.trimEnd(),
  }))
}
