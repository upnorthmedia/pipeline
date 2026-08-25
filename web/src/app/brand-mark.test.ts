/**
 * The brand mark ships as files, and every one of them is loaded as an image:
 * the sidebar renders `/icon.svg` through `next/image`, the app-router icon
 * convention emits `<link rel="icon">` for `src/app/icon*`, and the PWA
 * manifest names two PNGs. None of those is a document context, so an SVG that
 * only paints inside an HTML page is a blank square everywhere it is used.
 *
 * That is not hypothetical: `public/icon.svg` used to be a 49KB devtools
 * capture whose whole content was a `<foreignObject>` full of HTML. It looked
 * like a vector, `next/image` served it, and the sidebar painted nothing but
 * the alt text.
 *
 * So the check is not "the file exists" or "the file is an SVG". It is: put it
 * through a renderer that has no HTML engine, the same position a browser is in
 * when it loads an image, and count the pixels that come out. `sharp` is
 * already a dependency (Next uses it for image optimisation) and its SVG input
 * goes through librsvg, which, like an `<img>` load, does not run
 * `foreignObject` HTML.
 */
import fs from "node:fs"
import path from "node:path"

import sharp from "sharp"
import { describe, expect, it } from "vitest"

import { config as proxyConfig } from "@/proxy"

const WEB = path.resolve(__dirname, "../..")

/**
 * The two copies of the vector mark. They are separate files because Next.js
 * resolves them from different roots: `public/` is served verbatim and is what
 * the sidebar's `<Image src>` points at, while an app-router icon has to live
 * under `src/app/`. `is one mark` below pins them byte-identical so the two
 * paths cannot drift apart.
 */
const VECTOR_MARKS = ["public/icon.svg", "src/app/icon0.svg"] as const

/** Every raster the mark also ships as, with the size each consumer expects. */
const RASTER_MARKS = [
  { file: "public/web-app-manifest-192x192.png", size: 192 },
  { file: "public/web-app-manifest-512x512.png", size: 512 },
  { file: "src/app/icon1.png", size: 96 },
  { file: "src/app/apple-icon.png", size: 180 },
] as const

/**
 * The maskable set. A platform that installs the PWA does not draw the icon it
 * was given: it crops it to its own shape (circle, squircle, rounded square)
 * and only guarantees that the centre 80% survives. `purpose: "any"` art
 * carries its own margin and its own rounded corners, so a platform masking it
 * either badges it onto a white tile or clips the corners off the page. The
 * maskable copy is the same mark drawn on a background that reaches every edge,
 * with the ink inside the safe circle.
 *
 * The vector they are generated from is `web/brand/icon-maskable.svg` rather
 * than a third file in `public/`: `public/` is served verbatim at the site
 * root, and nothing fetches the maskable vector, only the two PNGs the manifest
 * names.
 */
const MASKABLE_MARKS = [
  { file: "public/web-app-manifest-maskable-192x192.png", size: 192 },
  { file: "public/web-app-manifest-maskable-512x512.png", size: 512 },
] as const

/** The share of the tile a maskable platform promises not to crop. */
const SAFE_ZONE = 0.8

/**
 * Every text file under a directory that is shipped code, read as one string
 * each. Tests are skipped on purpose: a file named only by the test that
 * checks it is not referenced by anything a browser can reach.
 */
function collectSource(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectSource(full)
    if (!entry.isFile()) return []
    if (/\.test\.[jt]sx?$/.test(entry.name)) return []
    if (!/\.(ts|tsx|js|jsx|mjs|json|css|md)$/.test(entry.name)) return []
    return [fs.readFileSync(full, "utf8")]
  })
}

/** A comparison size small enough that renderer antialiasing averages out. */
const COMPARE = 32

/** Renders a mark to `COMPARE` square RGBA pixels, composited over nothing. */
async function rasterise(file: string): Promise<Buffer> {
  return sharp(path.join(WEB, file), { density: 384 })
    .resize(COMPARE, COMPARE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer()
}

/** The share of pixels a renderer actually painted. 0 means a blank square. */
function paintedFraction(pixels: Buffer): number {
  let painted = 0
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 8) painted++
  return painted / (pixels.length / 4)
}

/** Reads a raster at its own size as RGBA, with no resampling in the way. */
async function readRaster(file: string): Promise<Buffer> {
  return sharp(path.join(WEB, file)).ensureAlpha().raw().toBuffer()
}

/**
 * Counts pixels of ink, inside and outside the maskable safe circle. Ink is
 * anything opaque and dark: the mark's only two colours are `#0a0a0a` and a
 * white-to-`#e4e4e8` page, so the two are 200 apart on every channel and any
 * threshold between them reads the same.
 */
function inkBySafeZone(pixels: Buffer, size: number): { inside: number; outside: number } {
  const centre = size / 2
  const safeRadius = (SAFE_ZONE / 2) * size
  let inside = 0
  let outside = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
      if (pixels[i + 3] <= 8 || luminance >= 160) continue
      const dx = x + 0.5 - centre
      const dy = y + 0.5 - centre
      if (Math.hypot(dx, dy) <= safeRadius) inside++
      else outside++
    }
  }
  return { inside, outside }
}

/** Mean per-channel difference of two marks composited on the same white. */
function meanDifference(a: Buffer, b: Buffer): number {
  let total = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const alphaA = a[i + 3] / 255
      const alphaB = b[i + 3] / 255
      const overWhiteA = a[i + channel] * alphaA + 255 * (1 - alphaA)
      const overWhiteB = b[i + channel] * alphaB + 255 * (1 - alphaB)
      total += Math.abs(overWhiteA - overWhiteB)
    }
  }
  return total / (255 * 3 * (a.length / 4))
}

describe("the brand mark", () => {
  it.each(VECTOR_MARKS)("%s paints when it is loaded as an image", async (file) => {
    const painted = paintedFraction(await rasterise(file))
    // The mark is a filled page covering most of its frame, so anything near
    // zero means the renderer found nothing it could draw.
    expect(painted).toBeGreaterThan(0.5)
  })

  it.each(VECTOR_MARKS)("%s draws its own shapes rather than wrapping content", (file) => {
    const source = fs.readFileSync(path.join(WEB, file), "utf8")
    // Two ways a file can be an SVG without being a vector mark: HTML smuggled
    // through `foreignObject`, which no image context renders, and a base64
    // raster in an `<image href>`, which renders but does not scale.
    expect(source).not.toMatch(/<foreignObject/i)
    expect(source).not.toMatch(/data:image\//i)
    expect(source).toMatch(/<(path|rect|circle|polygon|ellipse)\b/)
  })

  it("is one mark, not two files that happen to look alike", () => {
    const [first, second] = VECTOR_MARKS.map((file) => fs.readFileSync(path.join(WEB, file)))
    expect(second.equals(first)).toBe(true)
  })

  it.each(RASTER_MARKS)("$file is $size square, the size its consumer asks for", async ({ file, size }) => {
    const { width, height } = await sharp(path.join(WEB, file)).metadata()
    expect({ width, height }).toEqual({ width: size, height: size })
  })

  it.each(RASTER_MARKS)("$file is the same mark as the vector", async ({ file }) => {
    const [vector, raster] = await Promise.all([rasterise(VECTOR_MARKS[0]), rasterise(file)])
    // Measured: every raster scores 0.010 to 0.011 against the vector they are
    // generated from, and a blank square against the same vector scores 0.117.
    // 0.04 is four times the agreement and a third of the disagreement.
    expect(meanDifference(vector, raster)).toBeLessThan(0.04)
  })

  it("is served to a browser that has no session", () => {
    // The sign-in page renders the sidebar and asks for the favicon, and a PWA
    // installer fetches the manifest icons with no cookies at all. Every one of
    // those requests goes through `src/proxy.ts`, which redirects anything
    // its matcher covers to `/auth/sign-in`, and a 307 to an HTML page is a
    // broken image. Next compiles the matcher to a regex over the pathname; the
    // form used here is simple enough to rebuild verbatim.
    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`)
    const served = [
      "/icon.svg",
      "/icon0.svg",
      "/icon1.png",
      "/apple-icon.png",
      "/favicon.ico",
      "/manifest.json",
      "/web-app-manifest-192x192.png",
      "/web-app-manifest-512x512.png",
      "/web-app-manifest-maskable-192x192.png",
      "/web-app-manifest-maskable-512x512.png",
    ]
    expect(served.filter((asset) => matcher.test(asset))).toEqual([])
    // Anti-vacuity: the matcher still covers the pages it is there to protect.
    expect(["/", "/posts/new", "/settings"].filter((page) => matcher.test(page))).toHaveLength(3)
  })

  it("is the only thing `public/` serves", () => {
    // Ledger item P2.105. `public/` is served verbatim at the site root, so
    // anything left in it is a public route and ships in the image. The
    // create-next-app starter drops five demo SVGs there, and this app never
    // referenced any of them.
    const source = collectSource(path.join(WEB, "src"))
    const unreferenced = fs
      .readdirSync(path.join(WEB, "public"))
      .filter((asset) => !source.some((file) => file.includes(asset)))
    expect(unreferenced).toEqual([])
    // Anti-vacuity: the crawl read files, and they name the mark.
    expect(source.some((file) => file.includes("icon.svg"))).toBe(true)
  })

  it("is reachable at every path the app names", () => {
    const sidebar = fs.readFileSync(path.join(WEB, "src/components/sidebar.tsx"), "utf8")
    const manifest = JSON.parse(fs.readFileSync(path.join(WEB, "src/app/manifest.json"), "utf8"))

    const sidebarSrc = sidebar.match(/<Image\s+src="([^"]+)"/)?.[1]
    expect(sidebarSrc).toBeDefined()

    const referenced = [sidebarSrc!, ...manifest.icons.map((icon: { src: string }) => icon.src)]
    for (const src of referenced) {
      expect(src.startsWith("/")).toBe(true)
      expect(fs.existsSync(path.join(WEB, "public", src.slice(1)))).toBe(true)
    }
  })
})

describe("the maskable brand mark", () => {
  it("is declared at every size the manifest declares an unmasked icon at", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(WEB, "src/app/manifest.json"), "utf8"))
    const sizesFor = (purpose: string) =>
      manifest.icons
        .filter((icon: { purpose: string }) => icon.purpose === purpose)
        .map((icon: { sizes: string }) => icon.sizes)
        .sort()

    // An installer picks by size first and purpose second, so a maskable set
    // that is missing a size falls back to the unmasked art at that size,
    // which is the badged tile this item is about.
    expect(sizesFor("maskable")).toEqual(["192x192", "512x512"])
    expect(sizesFor("maskable")).toEqual(sizesFor("any"))

    const declared = manifest.icons
      .filter((icon: { purpose: string }) => icon.purpose === "maskable")
      .map((icon: { src: string }) => `public${icon.src}`)
      .sort()
    expect(declared).toEqual(MASKABLE_MARKS.map(({ file }) => file).sort())
  })

  it.each(MASKABLE_MARKS)("$file is $size square, the size its consumer asks for", async ({ file, size }) => {
    const { width, height } = await sharp(path.join(WEB, file)).metadata()
    expect({ width, height }).toEqual({ width: size, height: size })
  })

  it.each(MASKABLE_MARKS)("$file reaches every edge, so a mask has nothing to badge", async ({ file }) => {
    // This is the whole difference between the two purposes. A maskable icon
    // with a transparent margin is drawn by the platform as the mark shrunk
    // onto a white or grey tile of the platform's choosing.
    expect(paintedFraction(await readRaster(file))).toBe(1)
  })

  it("is the one thing the unmasked set is not", async () => {
    // Anti-vacuity for the assertion above: the `any` rasters are the same
    // mark with its own margin, and they are not full bleed. If they were,
    // both sets would be the same file and this item would be a rename.
    for (const { file } of RASTER_MARKS) {
      expect(paintedFraction(await readRaster(file))).toBeLessThan(1)
    }
  })

  it.each(MASKABLE_MARKS)("$file keeps its ink inside the safe zone", async ({ file, size }) => {
    const { inside, outside } = inkBySafeZone(await readRaster(file), size)
    // Everything outside the centre 80% is the platform's to crop, so any ink
    // out there is ink that some devices will cut through.
    expect(outside).toBe(0)
    // Anti-vacuity: the counter found the mark rather than an empty tile.
    expect(inside / (size * size)).toBeGreaterThan(0.05)
  })

  it.each(MASKABLE_MARKS)("$file is the same mark, not a second drawing", async ({ file, size }) => {
    // The maskable vector draws the ink at the same coordinates on a
    // background that fills the viewBox instead of one inset by 5 of 64, so
    // the same window of both, the page the unmasked mark draws, has to hold
    // the same picture. Both are read at the raster's own size so the window
    // is the same pixels rather than the same fraction of two scales.
    // Measured: 0.0038 at both sizes, against 0.164 for a white tile.
    const inset = Math.round((5 / 64) * size)
    const page = { left: inset, top: inset, width: size - 2 * inset, height: size - 2 * inset }
    const unmasked = await sharp(path.join(WEB, VECTOR_MARKS[0]), { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    const [a, b] = await Promise.all(
      [sharp(unmasked), sharp(path.join(WEB, file))].map((image) =>
        image.extract(page).resize(COMPARE, COMPARE).ensureAlpha().raw().toBuffer(),
      ),
    )
    expect(meanDifference(a, b)).toBeLessThan(0.04)
  })
})
