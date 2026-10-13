/**
 * `api/src/services/sitemap.py` ported to TypeScript.
 *
 * A website profile's internal links come from its sitemap: discover the
 * sitemap URLs for a site, parse them, follow sitemap indexes, and hand back a
 * flat list of entries. The crawl job that persists those entries is a
 * separate ledger item; this module is only the fetching and parsing half, and
 * it does no logging so a test can run it without writing to the run output.
 *
 * Three names in the Python module are not ported because nothing calls them:
 * `fetch_page_title` and `crawl_sitemap`'s `fetch_titles` flag (the one caller,
 * `crawl_profile_sitemap`, passes `False`, and no test reaches them either) and
 * `MAX_URLS_PER_SITEMAP`, which is declared and never read.
 *
 * Four details do not survive a naive translation:
 *
 * * `lxml` raises on malformed XML, `fast-xml-parser` does not: it accepts
 *   `<not valid xml at all>>>` and hands back `[{ not: [] }]`. So the document
 *   goes through `XMLValidator` first and a rejection becomes the same
 *   `SitemapParseError` that `etree.XMLSyntaxError` produced. `XMLValidator`
 *   carries a deprecation notice in fast-xml-parser 5.11 pointing at the
 *   separate `fast-xml-validator` package; it still ships and still works, and
 *   switching is a one-line import change if v6 removes it, which is cheaper
 *   than carrying a second XML dependency now.
 * * `root.findall("sm:url", SITEMAP_NS)` matches only direct children that are
 *   in the sitemaps.org namespace, so a sitemap that declares no namespace
 *   parses to zero entries even though its root element is `<urlset>`. The
 *   parser has no namespace support (`removeNSPrefix` erases prefixes without
 *   looking at what they are bound to), so `preserveOrder` keeps the tree and
 *   the xmlns declarations in scope are resolved here.
 * * `etree.parse` honours the encoding declared in the XML prolog; this port
 *   decodes UTF-8 unconditionally. Every sitemap in the wild is UTF-8, and the
 *   sitemaps.org protocol requires it.
 * * `httpx`'s `timeout=30` is per connect/read/write/pool phase, where
 *   `AbortSignal.timeout` is a deadline over the whole request, the same
 *   divergence the `link_validator` port carries.
 */
import { gunzipSync } from "node:zlib"

import { XMLParser, XMLValidator } from "fast-xml-parser"

/** `SITEMAP_NS`. The one namespace URI whose `<url>` and `<sitemap>` count. */
const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9"

/** `SITEMAP_TIMEOUT`, in milliseconds. */
export const SITEMAP_TIMEOUT_MS = 30_000

/** `USER_AGENT`. */
export const USER_AGENT = "ContentPipelineBot/1.0"

/** `fetch_and_parse_sitemap`'s default `max_depth`. */
export const MAX_SITEMAP_DEPTH = 3

export interface SitemapEntry {
  url: string
  title: string | null
  lastmod: string | null
}

/** `parse_sitemap_xml`'s `(sub_sitemap_urls, entries)` tuple. */
export interface ParsedSitemap {
  subSitemaps: string[]
  entries: SitemapEntry[]
}

export class SitemapParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SitemapParseError"
  }
}

/**
 * `preserveOrder` shape: every element is an object with exactly one tag key
 * holding its children, plus an optional `:@` map of its attributes. Text is a
 * child under `#text`.
 */
const ATTRS = ":@"
const TEXT = "#text"
type FxpChild = Record<string, unknown>

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  // `lastmod` dates and `loc` URLs are strings; strnum would turn a numeric
  // one into a number and change what `.strip()` produced in Python.
  parseTagValue: false,
})

function tagOf(node: FxpChild): string | undefined {
  return Object.keys(node).find((key) => key !== ATTRS)
}

function localName(tag: string): string {
  const colon = tag.indexOf(":")
  return colon === -1 ? tag : tag.slice(colon + 1)
}

function prefixOf(tag: string): string {
  const colon = tag.indexOf(":")
  return colon === -1 ? "" : tag.slice(0, colon)
}

function childrenOf(node: FxpChild, tag: string): FxpChild[] {
  const children = node[tag]
  return Array.isArray(children) ? (children as FxpChild[]) : []
}

/** The xmlns declarations on one element, layered over the inherited scope. */
function scopeOf(node: FxpChild, inherited: Map<string, string>): Map<string, string> {
  const attrs = node[ATTRS] as Record<string, string> | undefined
  if (!attrs) {
    return inherited
  }
  let scope: Map<string, string> | undefined
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "@_xmlns") {
      scope ??= new Map(inherited)
      scope.set("", value)
    } else if (name.startsWith("@_xmlns:")) {
      scope ??= new Map(inherited)
      scope.set(name.slice("@_xmlns:".length), value)
    }
  }
  return scope ?? inherited
}

function inSitemapNs(tag: string, scope: Map<string, string>): boolean {
  return scope.get(prefixOf(tag)) === SITEMAP_NS
}

/** `root.findall("sm:<name>", SITEMAP_NS)`: direct children only. */
function findAll(node: FxpChild, tag: string, name: string, scope: Map<string, string>) {
  const matches: { node: FxpChild; scope: Map<string, string> }[] = []
  for (const child of childrenOf(node, tag)) {
    const childTag = tagOf(child)
    if (!childTag || localName(childTag) !== name) {
      continue
    }
    const childScope = scopeOf(child, scope)
    if (inSitemapNs(childTag, childScope)) {
      matches.push({ node: child, scope: childScope })
    }
  }
  return matches
}

/**
 * `findtext("sm:<name>", namespaces=SITEMAP_NS)`: the text of the first
 * matching child, or `null` when there is none. `lxml` returns the text before
 * the first grandchild; `<loc>` and `<lastmod>` never have one.
 */
function findText(
  node: FxpChild,
  tag: string,
  name: string,
  scope: Map<string, string>,
): string | null {
  const match = findAll(node, tag, name, scope)[0]
  if (!match) {
    return null
  }
  const matchTag = tagOf(match.node)
  if (!matchTag) {
    return null
  }
  for (const child of childrenOf(match.node, matchTag)) {
    if (TEXT in child) {
      return String(child[TEXT])
    }
  }
  return ""
}

/**
 * Parse sitemap XML, returning the nested sitemap URLs of a `<sitemapindex>`
 * and the entries of a `<urlset>`. Gzipped content is decompressed first.
 */
export function parseSitemapXml(content: Uint8Array): ParsedSitemap {
  let raw = content
  try {
    raw = gunzipSync(content)
  } catch {
    // Not gzipped, use raw content.
  }

  const text = Buffer.from(raw).toString("utf-8")
  const valid = XMLValidator.validate(text)
  if (valid !== true) {
    throw new SitemapParseError(`Malformed XML: ${valid.err.msg}`)
  }

  const document = parser.parse(text) as FxpChild[]
  const root = document.find((node) => {
    const tag = tagOf(node)
    return tag !== undefined && !tag.startsWith("?")
  })
  const rootTag = root ? tagOf(root) : undefined
  if (!root || !rootTag) {
    throw new SitemapParseError("Unknown root element: ")
  }

  const scope = scopeOf(root, new Map())
  const name = localName(rootTag)
  const subSitemaps: string[] = []
  const entries: SitemapEntry[] = []

  if (name === "sitemapindex") {
    for (const sitemap of findAll(root, rootTag, "sitemap", scope)) {
      const tag = tagOf(sitemap.node)
      const loc = tag ? findText(sitemap.node, tag, "loc", sitemap.scope) : null
      if (loc) {
        subSitemaps.push(loc.trim())
      }
    }
  } else if (name === "urlset") {
    for (const url of findAll(root, rootTag, "url", scope)) {
      const tag = tagOf(url.node)
      const loc = tag ? findText(url.node, tag, "loc", url.scope) : null
      if (!loc) {
        continue
      }
      const lastmod = tag ? findText(url.node, tag, "lastmod", url.scope) : null
      entries.push({
        url: loc.trim(),
        title: null,
        lastmod: lastmod ? lastmod.trim() : null,
      })
    }
  } else {
    throw new SitemapParseError(`Unknown root element: ${name}`)
  }

  return { subSitemaps, entries }
}

/** `parse_robots_txt`: the URLs on `Sitemap:` lines, in file order. */
export function parseRobotsTxt(content: string): string[] {
  const sitemaps: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.toLowerCase().startsWith("sitemap:")) {
      const url = line.slice(line.indexOf(":") + 1).trim()
      if (url) {
        sitemaps.push(url)
      }
    }
  }
  return sitemaps
}

function get(url: string): Promise<Response> {
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS),
  })
}

/**
 * `discover_sitemaps`: robots.txt `Sitemap:` directives, else `/sitemap.xml`,
 * else `/sitemap_index.xml`. A network failure on any of the three is the same
 * as that source having nothing to offer.
 */
export async function discoverSitemaps(websiteUrl: string): Promise<string[]> {
  const parsed = new URL(websiteUrl)
  const base = `${parsed.protocol}//${parsed.host}`

  try {
    const response = await get(`${base}/robots.txt`)
    if (response.status === 200) {
      const sitemaps = parseRobotsTxt(await response.text())
      if (sitemaps.length > 0) {
        return sitemaps
      }
    }
  } catch {
    // Fall through to the well-known paths.
  }

  for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
    try {
      const response = await get(`${base}${path}`)
      if (response.status === 200) {
        return [`${base}${path}`]
      }
    } catch {
      continue
    }
  }

  return []
}

/**
 * `fetch_and_parse_sitemap`: fetch one sitemap URL and flatten any indexes it
 * points at. A fetch or parse failure at any depth contributes nothing rather
 * than failing the crawl.
 */
export async function fetchAndParseSitemap(
  url: string,
  maxDepth: number = MAX_SITEMAP_DEPTH,
): Promise<SitemapEntry[]> {
  if (maxDepth <= 0) {
    return []
  }

  let body: Uint8Array
  try {
    const response = await get(url)
    // `raise_for_status()` raises on 4xx and 5xx only; redirects have already
    // been followed, so anything below 400 is a body worth parsing.
    if (response.status >= 400) {
      return []
    }
    body = new Uint8Array(await response.arrayBuffer())
  } catch {
    return []
  }

  let parsed: ParsedSitemap
  try {
    parsed = parseSitemapXml(body)
  } catch (error) {
    if (error instanceof SitemapParseError) {
      return []
    }
    throw error
  }

  const entries = parsed.entries
  for (const subUrl of parsed.subSitemaps) {
    entries.push(...(await fetchAndParseSitemap(subUrl, maxDepth - 1)))
  }

  return entries
}

/** `crawl_sitemap`: discover every sitemap for a site and parse them all. */
export async function crawlSitemap(websiteUrl: string): Promise<SitemapEntry[]> {
  const sitemapUrls = await discoverSitemaps(websiteUrl)
  if (sitemapUrls.length === 0) {
    return []
  }

  const allEntries: SitemapEntry[] = []
  for (const sitemapUrl of sitemapUrls) {
    allEntries.push(...(await fetchAndParseSitemap(sitemapUrl)))
  }
  return allEntries
}
