/**
 * `bun build --compile` embeds a file imported with this attribute into the binary and
 * resolves the import to a path `Bun.file` can read. TypeScript has no idea, hence this.
 */
declare module "*.apk" {
  const path: string
  export default path
}
