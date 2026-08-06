export type Distro = "arch" | "debian" | "fedora" | "suse" | "unknown"

/**
 * Derivatives that do not name one of the five families in `ID` or `ID_LIKE`.
 * Mint reports `ID_LIKE=ubuntu`; Tumbleweed reports `ID_LIKE="opensuse suse"`.
 * Everything else is reached through ID_LIKE alone and needs no entry here.
 */
const ALIASES: Record<string, Distro> = {
  arch: "arch",
  debian: "debian",
  ubuntu: "debian",
  fedora: "fedora",
  suse: "suse",
  opensuse: "suse",
}

export function detectDistro(osRelease: string): Distro {
  const field = (key: string) =>
    osRelease.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1].replace(/"/g, "").trim() ?? ""
  for (const id of [field("ID"), ...field("ID_LIKE").split(/\s+/)]) {
    if (ALIASES[id]) return ALIASES[id]
  }
  return "unknown"
}

/** `scrcpy --version` prints "scrcpy 4.1 <url>" on its first line. */
export function parseScrcpyVersion(text: string): [number, number] | null {
  const m = text.match(/\bscrcpy\s+(\d+)\.(\d+)/i)
  return m ? [Number(m[1]), Number(m[2])] : null
}
