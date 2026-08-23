/**
 * Python's `mimetypes.guess_type`, as the deployed interpreter runs it.
 *
 * `publish_to_wordpress` in `api/src/pipeline/publish.py` filters the post's
 * media directory with `mimetypes.guess_type(img_file.name)` and hands the
 * returned type to `WordPressClient.upload_media`, so the sweep needs this
 * function before it can decide anything.
 *
 * **The tables here are the Python 3.12 builtin tables and nothing else.**
 * `mimetypes.init()` also reads `mimetypes.knownfiles`, which on a macOS
 * developer machine finds `/etc/apache2/mime.types` and grows the strict map
 * from 152 entries to 1036, adding 45 image extensions and changing what
 * `.ico` means. The deployed image is `python:3.12-slim`, where no knownfile
 * exists, so the builtin table is the whole story there. The oracle in
 * `data/wp-mimetypes-parity.json` is generated inside that image and the export
 * script refuses to run anywhere else.
 *
 * A consequence worth stating out loud, because it is not a port defect: the
 * images stage writes `.webp` files, and `.webp` is not in the Python 3.12
 * builtin strict table (it arrived in 3.13). In production every generated image
 * is therefore classified as `(None, None)` and skipped by the WordPress media
 * sweep. This module reproduces that, and the defect is logged in `todo.md`.
 *
 * The input domain is a single POSIX path component, which is what
 * `Path.iterdir()` yields. A component cannot contain `/`, which makes three
 * pieces of `urlsplit` unreachable: the `//` netloc split, its IPv6 bracket
 * validation, and the `'/' in url` half of `_splitparams`. Those are not
 * ported, and `guessTypeFromFilename` throws rather than guessing if a caller
 * ever passes a slash.
 */

const TYPES_MAP_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".json", "application/json"],
  [".webmanifest", "application/manifest+json"],
  [".doc", "application/msword"],
  [".dot", "application/msword"],
  [".wiz", "application/msword"],
  [".nq", "application/n-quads"],
  [".nt", "application/n-triples"],
  [".bin", "application/octet-stream"],
  [".a", "application/octet-stream"],
  [".dll", "application/octet-stream"],
  [".exe", "application/octet-stream"],
  [".o", "application/octet-stream"],
  [".obj", "application/octet-stream"],
  [".so", "application/octet-stream"],
  [".oda", "application/oda"],
  [".pdf", "application/pdf"],
  [".p7c", "application/pkcs7-mime"],
  [".ps", "application/postscript"],
  [".ai", "application/postscript"],
  [".eps", "application/postscript"],
  [".trig", "application/trig"],
  [".m3u", "application/vnd.apple.mpegurl"],
  [".m3u8", "application/vnd.apple.mpegurl"],
  [".xls", "application/vnd.ms-excel"],
  [".xlb", "application/vnd.ms-excel"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pot", "application/vnd.ms-powerpoint"],
  [".ppa", "application/vnd.ms-powerpoint"],
  [".pps", "application/vnd.ms-powerpoint"],
  [".pwz", "application/vnd.ms-powerpoint"],
  [".wasm", "application/wasm"],
  [".bcpio", "application/x-bcpio"],
  [".cpio", "application/x-cpio"],
  [".csh", "application/x-csh"],
  [".dvi", "application/x-dvi"],
  [".gtar", "application/x-gtar"],
  [".hdf", "application/x-hdf"],
  [".h5", "application/x-hdf5"],
  [".latex", "application/x-latex"],
  [".mif", "application/x-mif"],
  [".cdf", "application/x-netcdf"],
  [".nc", "application/x-netcdf"],
  [".p12", "application/x-pkcs12"],
  [".pfx", "application/x-pkcs12"],
  [".ram", "application/x-pn-realaudio"],
  [".pyc", "application/x-python-code"],
  [".pyo", "application/x-python-code"],
  [".sh", "application/x-sh"],
  [".shar", "application/x-shar"],
  [".swf", "application/x-shockwave-flash"],
  [".sv4cpio", "application/x-sv4cpio"],
  [".sv4crc", "application/x-sv4crc"],
  [".tar", "application/x-tar"],
  [".tcl", "application/x-tcl"],
  [".tex", "application/x-tex"],
  [".texi", "application/x-texinfo"],
  [".texinfo", "application/x-texinfo"],
  [".roff", "application/x-troff"],
  [".t", "application/x-troff"],
  [".tr", "application/x-troff"],
  [".man", "application/x-troff-man"],
  [".me", "application/x-troff-me"],
  [".ms", "application/x-troff-ms"],
  [".ustar", "application/x-ustar"],
  [".src", "application/x-wais-source"],
  [".xsl", "application/xml"],
  [".rdf", "application/xml"],
  [".wsdl", "application/xml"],
  [".xpdl", "application/xml"],
  [".zip", "application/zip"],
  [".3gp", "audio/3gpp"],
  [".3gpp", "audio/3gpp"],
  [".3g2", "audio/3gpp2"],
  [".3gpp2", "audio/3gpp2"],
  [".aac", "audio/aac"],
  [".adts", "audio/aac"],
  [".loas", "audio/aac"],
  [".ass", "audio/aac"],
  [".au", "audio/basic"],
  [".snd", "audio/basic"],
  [".mp3", "audio/mpeg"],
  [".mp2", "audio/mpeg"],
  [".opus", "audio/opus"],
  [".aif", "audio/x-aiff"],
  [".aifc", "audio/x-aiff"],
  [".aiff", "audio/x-aiff"],
  [".ra", "audio/x-pn-realaudio"],
  [".wav", "audio/x-wav"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ief", "image/ief"],
  [".jpg", "image/jpeg"],
  [".jpe", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tiff", "image/tiff"],
  [".tif", "image/tiff"],
  [".ico", "image/vnd.microsoft.icon"],
  [".ras", "image/x-cmu-raster"],
  [".pnm", "image/x-portable-anymap"],
  [".pbm", "image/x-portable-bitmap"],
  [".pgm", "image/x-portable-graymap"],
  [".ppm", "image/x-portable-pixmap"],
  [".rgb", "image/x-rgb"],
  [".xbm", "image/x-xbitmap"],
  [".xpm", "image/x-xpixmap"],
  [".xwd", "image/x-xwindowdump"],
  [".eml", "message/rfc822"],
  [".mht", "message/rfc822"],
  [".mhtml", "message/rfc822"],
  [".nws", "message/rfc822"],
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".n3", "text/n3"],
  [".txt", "text/plain"],
  [".bat", "text/plain"],
  [".c", "text/plain"],
  [".h", "text/plain"],
  [".ksh", "text/plain"],
  [".pl", "text/plain"],
  [".srt", "text/plain"],
  [".rtx", "text/richtext"],
  [".tsv", "text/tab-separated-values"],
  [".vtt", "text/vtt"],
  [".py", "text/x-python"],
  [".rst", "text/x-rst"],
  [".etx", "text/x-setext"],
  [".sgm", "text/x-sgml"],
  [".sgml", "text/x-sgml"],
  [".vcf", "text/x-vcard"],
  [".xml", "text/xml"],
  [".mp4", "video/mp4"],
  [".mpeg", "video/mpeg"],
  [".m1v", "video/mpeg"],
  [".mpa", "video/mpeg"],
  [".mpe", "video/mpeg"],
  [".mpg", "video/mpeg"],
  [".mov", "video/quicktime"],
  [".qt", "video/quicktime"],
  [".webm", "video/webm"],
  [".avi", "video/x-msvideo"],
  [".movie", "video/x-sgi-movie"],
]

const COMMON_TYPES_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  [".rtf", "application/rtf"],
  [".midi", "audio/midi"],
  [".mid", "audio/midi"],
  [".jpg", "image/jpg"],
  [".pict", "image/pict"],
  [".pct", "image/pict"],
  [".pic", "image/pict"],
  [".webp", "image/webp"],
  [".xul", "text/xul"],
]

const ENCODINGS_MAP_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  [".gz", "gzip"],
  [".Z", "compress"],
  [".bz2", "bzip2"],
  [".xz", "xz"],
  [".br", "br"],
]

const SUFFIX_MAP_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  [".svgz", ".svg.gz"],
  [".tgz", ".tar.gz"],
  [".taz", ".tar.gz"],
  [".tz", ".tar.gz"],
  [".tbz2", ".tar.bz2"],
  [".txz", ".tar.xz"],
]

/** `mimetypes.types_map`: the strict extension-to-type table. */
export const TYPES_MAP: ReadonlyMap<string, string> = new Map(TYPES_MAP_ENTRIES)

/** `mimetypes.common_types`: the extra table `strict=false` falls back to. */
export const COMMON_TYPES: ReadonlyMap<string, string> = new Map(
  COMMON_TYPES_ENTRIES,
)

/** `mimetypes.encodings_map`: matched case sensitively, unlike the type tables. */
export const ENCODINGS_MAP: ReadonlyMap<string, string> = new Map(
  ENCODINGS_MAP_ENTRIES,
)

/** `mimetypes.suffix_map`: rewrites a compound suffix before anything else. */
export const SUFFIX_MAP: ReadonlyMap<string, string> = new Map(SUFFIX_MAP_ENTRIES)

/** `urllib.parse.scheme_chars`. */
const SCHEME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-."

/** `urllib.parse.uses_params`, the schemes whose path gives up a `;` suffix. */
const USES_PARAMS: ReadonlySet<string> = new Set(["", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp", "rtsps", "rtspu", "sip", "sips", "mms", "sftp", "tel"])

/** `urllib.parse._UNSAFE_URL_BYTES_TO_REMOVE`. */
const UNSAFE_URL_CHARS_TO_REMOVE = ["\t", "\r", "\n"]

/**
 * `str.lstrip(urllib.parse._WHATWG_C0_CONTROL_OR_SPACE)`, which is every code
 * point from U+0000 to U+0020 inclusive.
 */
function lstripC0ControlOrSpace(value: string): string {
  let index = 0
  while (index < value.length && value.charCodeAt(index) <= 0x20) {
    index += 1
  }
  return value.slice(index)
}

/**
 * `posixpath.splitext`. The extension is everything from the last dot, but
 * leading dots are skipped, so `.png` and `..png` have no extension at all.
 */
export function splitext(path: string): [string, string] {
  const sepIndex = path.lastIndexOf("/")
  const dotIndex = path.lastIndexOf(".")
  if (dotIndex > sepIndex) {
    let filenameIndex = sepIndex + 1
    while (filenameIndex < dotIndex) {
      if (path.slice(filenameIndex, filenameIndex + 1) !== ".") {
        return [path.slice(0, dotIndex), path.slice(dotIndex)]
      }
      filenameIndex += 1
    }
  }
  return [path, ""]
}

/**
 * The scheme and path `urllib.parse.urlparse` produces for a slash-free input.
 *
 * `scheme` is `""` when the input carries none, matching `ParseResult.scheme`.
 */
function urlparseSlashFree(url: string): { scheme: string; path: string } {
  // urlsplit parses a cleaned copy. The caller keeps the raw argument, and
  // guess_type re-reads that raw one whenever the scheme turns out to be
  // absent, so none of this cleaning survives into the schemeless branch.
  let rest = lstripC0ControlOrSpace(url)
  for (const unsafe of UNSAFE_URL_CHARS_TO_REMOVE) {
    rest = rest.split(unsafe).join("")
  }

  let scheme = ""
  const colon = rest.indexOf(":")
  if (colon > 0 && /^[A-Za-z]/.test(rest)) {
    let allSchemeChars = true
    for (const char of rest.slice(0, colon)) {
      if (!SCHEME_CHARS.includes(char)) {
        allSchemeChars = false
        break
      }
    }
    if (allSchemeChars) {
      scheme = rest.slice(0, colon).toLowerCase()
      rest = rest.slice(colon + 1)
    }
  }

  const hash = rest.indexOf("#")
  if (hash >= 0) {
    rest = rest.slice(0, hash)
  }
  const question = rest.indexOf("?")
  if (question >= 0) {
    rest = rest.slice(0, question)
  }

  // urlparse's params split. The '/' branch of _splitparams is unreachable.
  if (USES_PARAMS.has(scheme) && rest.includes(";")) {
    rest = rest.slice(0, rest.indexOf(";"))
  }

  return { scheme, path: rest }
}

/**
 * `mimetypes.guess_type(name, strict)` for a single POSIX path component.
 *
 * Returns `[type, encoding]`, both `null` when unknown, matching Python's tuple.
 */
export function guessTypeFromFilename(
  name: string,
  strict = true,
): [string | null, string | null] {
  if (name.includes("/")) {
    throw new TypeError(
      `guessTypeFromFilename expects a single path component, got ${JSON.stringify(name)}`,
    )
  }

  const parsed = urlparseSlashFree(name)
  let scheme: string | null
  let url: string
  if (parsed.scheme && parsed.scheme.length > 1) {
    scheme = parsed.scheme
    url = parsed.path
  } else {
    scheme = null
    // os.path.splitdrive is the identity on posix, and it is handed the raw
    // argument rather than anything urlsplit produced.
    url = name
  }

  if (scheme === "data") {
    const comma = url.indexOf(",")
    if (comma < 0) {
      return [null, null]
    }
    const semi = url.slice(0, comma).indexOf(";")
    let type = semi >= 0 ? url.slice(0, semi) : url.slice(0, comma)
    if (type.includes("=") || !type.includes("/")) {
      type = "text/plain"
    }
    // A data URL is never compressed, so the encoding is always null.
    return [type, null]
  }

  let split = splitext(url)
  let base = split[0]
  let ext = split[1]
  let extLower = ext.toLowerCase()
  while (SUFFIX_MAP.has(extLower)) {
    split = splitext(base + SUFFIX_MAP.get(extLower)!)
    base = split[0]
    ext = split[1]
    extLower = ext.toLowerCase()
  }

  let encoding: string | null = null
  // encodings_map is case sensitive, so ".GZ" is not an encoding suffix.
  if (ENCODINGS_MAP.has(ext)) {
    encoding = ENCODINGS_MAP.get(ext)!
    split = splitext(base)
    base = split[0]
    ext = split[1]
  }

  ext = ext.toLowerCase()
  if (TYPES_MAP.has(ext)) {
    return [TYPES_MAP.get(ext)!, encoding]
  }
  if (strict) {
    return [null, encoding]
  }
  if (COMMON_TYPES.has(ext)) {
    return [COMMON_TYPES.get(ext)!, encoding]
  }
  return [null, encoding]
}
