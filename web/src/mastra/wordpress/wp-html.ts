/**
 * `api/src/services/wp_html.py`, ported to TypeScript. Block level only.
 *
 * The Python function is a mistune 3 renderer, and almost every interesting
 * behaviour it has belongs to mistune's tokenizer rather than to the renderer's
 * format strings: `Para.\n--` turns the paragraph above it into an `<h2>`,
 * `    code` at the very start of the document is a paragraph because the
 * function calls `.strip()` first, an unclosed fence still closes at the end of
 * the document, and a backtick in a fence's info string stops the fence from
 * being a fence at all. So the tokenizer is ported too, rule for rule, rather
 * than a JavaScript markdown library being pointed at the same input and hoped
 * over. `wp-html-block-parity.json` is the oracle: every case in it is the real
 * `markdown_to_wp_html`'s output for that input.
 *
 * Ported here (ledger 5.3c-iii-b-1-b-i): the frontmatter strip, the newline
 * normalisation, the block scan loop, and the leaf blocks `blank_line`,
 * `fenced_code`, `indent_code`, `atx_heading`, `setex_heading` and
 * `thematic_break`, plus the paragraph fallback and the two inline break
 * tokens a multi-line paragraph produces.
 *
 * Ported here too (ledger 5.3c-iii-b-1-b-ii-1): `block_quote`, which is the
 * first rule with a body of its own. `extract_block_quote` peels the `>`
 * markers off into a fresh source string and reparses it in a child state, so
 * a quote nests, and it picks between two scan strategies depending on whether
 * the first line would start a code block. Its lazy-continuation branch can
 * hand a following block (a fence, a thematic break) to the outer parser and
 * then *prepend* the quote before it, which is why `prepend_token` exists.
 *
 * Not ported yet: `list` (5.3c-iii-b-1-b-ii-2), `ref_link` and
 * `raw_html`/`block_html` (5.3c-iii-b-1-b-ii-3), and the inline rules `escape`,
 * `codespan`, `emphasis`, `link`, `auto_link`, `auto_email` and `inline_html`
 * (5.3c-iii-b-1-b-iii). Their *patterns* are registered here in mistune's rule
 * order, because rule order is what decides whether `- - -` is a thematic
 * break or a list, and their handlers throw `UnportedMarkdownError`. A
 * half-ported converter that silently rendered a list as a paragraph would be
 * worse than one that stops.
 *
 * Regex translation notes:
 *
 * * Python compiles the block rules with `re.M`, where `^` matches at the
 *   start of the string or after a `\n` and `$` before a `\n` or at the end.
 *   JavaScript's `m` flag also breaks lines on `\r`, `\u2028` and `\u2029`, so
 *   the anchors are spelled as the lookarounds `SOL` and `EOL` instead and no
 *   `m` flag is used. `\r` is normalised away before parsing either way, but
 *   `\u2028` in an LLM-written article is reachable and would have diverged.
 * * `re.search(src, pos)` is a global-flagged `exec` with `lastIndex = pos`,
 *   and `re.match(src, pos)` is a sticky-flagged one. Both keep looking at the
 *   whole string for the anchors, which is what Python does.
 * * A few of the block-quote patterns are compiled *without* `re.M`, where
 *   Python's `$` matches at the end of the string or just before a single
 *   trailing newline. That is `EOS` below, not JavaScript's bare `$`.
 * * Python's `\s` matches `\x1c`-`\x1f` and `\x85` where JavaScript's does not,
 *   and JavaScript's matches `\ufeff` where Python's does not. Neither set
 *   appears in article markdown, and the difference is confined to the
 *   whitespace runs `indent_code` and the inline break rules skip over.
 */

/** A mistune token. `text` is inline source, `raw` is not parsed further. */
type Token = {
  type: string;
  raw?: string;
  text?: string;
  children?: Token[];
  attrs?: { level?: number; info?: string };
  style?: string;
  marker?: string;
};

/** Thrown when the input uses a construct whose handler is not ported yet. */
export class UnportedMarkdownError extends Error {
  readonly rule: string;

  constructor(rule: string, ledgerItem: string) {
    super(
      `markdownToWpHtml: the "${rule}" rule is not ported yet (ledger item ${ledgerItem})`,
    );
    this.name = "UnportedMarkdownError";
    this.rule = rule;
  }
}

/** Python `^` under `re.M`. */
const SOL = "(?<![^\\n])";
/** Python `$` under `re.M`. */
const EOL = "(?![^\\n])";
/** Python `$` with no `re.M`: the end of the string, or before one trailing newline. */
const EOS = "(?=\\n?$)";

/** `string.punctuation`, as a character class. */
const PUNCTUATION = "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~]";
const LINK_LABEL = "(?:[^\\\\\\[\\]]|\\\\.){0,500}";
const HTML_TAGNAME = "[A-Za-z][A-Za-z0-9-]*";
const HTML_ATTRIBUTES =
  "(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*" +
  "(?:\\s*=\\s*(?:[^ !\"'=<>`]+|'[^']*?'|\"[^\"]*?\"))?)*";
const AUTO_EMAIL =
  "<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9]" +
  "(?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?" +
  "(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*>";
/** `helpers.BLOCK_TAGS`. */
const BLOCK_TAGS = [
  "address", "article", "aside", "base", "basefont", "blockquote", "body",
  "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
  "hr", "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem",
  "meta", "nav", "noframes", "ol", "optgroup", "option", "p", "param",
  "section", "source", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "title", "tr", "track", "ul",
];
/** `helpers.PRE_TAGS`. */
const PRE_TAGS = ["pre", "script", "style", "textarea"];
const BLOCK_TAGS_PATTERN = `(${[...BLOCK_TAGS, ...PRE_TAGS].join("|")})`;

const INLINE_HTML =
  "<" +
  HTML_TAGNAME +
  HTML_ATTRIBUTES +
  "\\s*/?>|" +
  "</" +
  HTML_TAGNAME +
  "\\s*>|" +
  "<!--(?!>|->)(?:(?!--)[\\s\\S])+?(?<!-)-->|" +
  "<\\?[\\s\\S]+?\\?>|" +
  "<![A-Z][\\s\\S]+?>|" +
  "<!\\[CDATA[\\s\\S]+?\\]\\]>";

/** `BlockParser.SPECIFICATION`. */
const BLOCK_SPECIFICATION: Record<string, string> = {
  blank_line: `(?:${SOL}[ \\t\\v\\f]*\\n)+`,
  atx_heading: `${SOL} {0,3}(?<atx_1>#{1,6})(?!#+)(?<atx_2>[ \\t]*|[ \\t]+.*?)${EOL}`,
  setex_heading: `${SOL} {0,3}(?<setext_1>=|-){1,}[ \\t]*${EOL}`,
  fenced_code: `${SOL}(?<fenced_1> {0,3})(?<fenced_2>\`{3,}|~{3,})[ \\t]*(?<fenced_3>.*?)${EOL}`,
  indent_code:
    `${SOL}(?: {4}| *\\t)[^\\n]+(?:\\n+|${EOL})` +
    `(?:(?:(?: {4}| *\\t)[^\\n]+(?:\\n+|${EOL}))|\\s)*`,
  thematic_break: `${SOL} {0,3}(?:(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})${EOL}`,
  ref_link: `${SOL} {0,3}\\[(?<reflink_1>${LINK_LABEL})\\]:`,
  block_quote: `${SOL} {0,3}>(?<quote_1>.*?)${EOL}`,
  list: `${SOL}(?<list_1> {0,3})(?<list_2>[*+-]|\\d{1,9}[.)])(?<list_3>[ \\t]*|[ \\t].+)${EOL}`,
  raw_html: `${SOL} {0,3}(?:</?${HTML_TAGNAME}|<!--|<\\?|<![A-Z]|<!\\[CDATA\\[)`,
  // Registered but not in `DEFAULT_RULES`: `extract_block_quote` scans for it
  // by name when it decides whether a lazy continuation line has ended a quote.
  block_html:
    `${SOL} {0,3}(?:(?:</?${BLOCK_TAGS_PATTERN}(?:[ \\t]+|\\n|${EOL}))` +
    `|<!--|<\\?|<![A-Z]|<!\\[CDATA\\[)`,
};

/** `BlockParser.DEFAULT_RULES`. The order decides the alternation order. */
const BLOCK_RULES = [
  "fenced_code",
  "indent_code",
  "atx_heading",
  "setex_heading",
  "thematic_break",
  "block_quote",
  "list",
  "ref_link",
  "raw_html",
  "blank_line",
] as const;

/** `InlineParser.SPECIFICATION`, for the rules `hard_wrap=False` registers. */
const INLINE_SPECIFICATION: Record<string, string> = {
  escape: `(?:\\\\${PUNCTUATION})+`,
  codespan: "`{1,}",
  emphasis: "\\*{1,3}(?=[^\\s*])|\\b_{1,3}(?=[^\\s_])",
  link: "!?\\[",
  auto_link: "<[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\\x00-\\x20]*>",
  auto_email: AUTO_EMAIL,
  inline_html: INLINE_HTML,
  linebreak: "(?:\\\\| {2,})\\n\\s*",
  softbreak: " *\\n\\s*",
};

/** `InlineParser.DEFAULT_RULES` plus the `softbreak` appended when `hard_wrap` is off. */
const INLINE_RULES = [
  "escape",
  "codespan",
  "emphasis",
  "link",
  "auto_link",
  "auto_email",
  "inline_html",
  "linebreak",
  "softbreak",
] as const;

/** `Parser.compile_sc`: one alternation of named groups, in rule order. */
function compileSc(
  specification: Record<string, string>,
  rules: readonly string[],
  flags: string,
): RegExp {
  const source = rules
    .map((name) => `(?<${name}>${specification[name]})`)
    .join("|");
  return new RegExp(source, flags);
}

/** `m.lastgroup`: the rule whose alternative matched. */
function matchedRule(m: RegExpExecArray, rules: readonly string[]): string {
  for (const name of rules) {
    if (m.groups?.[name] !== undefined) return name;
  }
  /* istanbul ignore next: one alternative always participates in a match */
  throw new Error("markdownToWpHtml: no rule group matched");
}

/** `re.search(src, pos)`. */
function search(re: RegExp, src: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(src);
}

/** Python `str.strip(chars)`: a character set, not a substring. */
function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start += 1;
  while (end > start && chars.includes(s[end - 1])) end -= 1;
  return s.slice(start, end);
}

/** `string.whitespace`. */
const PY_WHITESPACE = " \t\n\r\v\f";

const EXPAND_TAB_RE = new RegExp(`${SOL}( {0,3})\\t`, "g");

/** `util.expand_leading_tab`. */
function expandLeadingTab(text: string, width = 4): string {
  return text.replace(EXPAND_TAB_RE, (_m, spaces: string) =>
    spaces.padEnd(width, " "),
  );
}

/** `util.expand_tab`. */
function expandTab(text: string, space = "    "): string {
  return text.replace(EXPAND_TAB_RE, (_m, spaces: string) => spaces + space);
}

const INDENT_CODE_TRIM = new RegExp(`${SOL} {1,4}`, "g");
const ATX_HEADING_TRIM = /(\s+|^)#+\s*$/;

/** `BlockState`. */
class BlockState {
  src = "";
  tokens: Token[] = [];
  cursor = 0;
  cursorMax = 0;
  readonly parent?: BlockState;

  constructor(parent?: BlockState) {
    this.parent = parent;
  }

  childState(src: string): BlockState {
    const child = new BlockState(this);
    child.process(src);
    return child;
  }

  /** How many quotes (or, later, lists) this state is nested inside. */
  depth(): number {
    let d = 0;
    let parent = this.parent;
    while (parent) {
      d += 1;
      parent = parent.parent;
    }
    return d;
  }

  process(src: string): void {
    this.src = src;
    this.cursorMax = src.length;
  }

  findLineEnd(): number {
    const next = this.src.indexOf("\n", this.cursor);
    return next === -1 ? this.src.length : next + 1;
  }

  getText(endPos: number): string {
    return this.src.slice(this.cursor, endPos);
  }

  lastToken(): Token | undefined {
    return this.tokens[this.tokens.length - 1];
  }

  /** `prepend_token`: insert before the last token, not at the front. */
  prependToken(token: Token): void {
    this.tokens.splice(this.tokens.length - 1, 0, token);
  }

  addParagraph(text: string): void {
    const last = this.lastToken();
    if (last && last.type === "paragraph") {
      last.text = (last.text ?? "") + text;
    } else {
      this.tokens.push({ type: "paragraph", text });
    }
  }

  appendParagraph(): number | undefined {
    const last = this.lastToken();
    if (last && last.type === "paragraph") {
      const pos = this.findLineEnd();
      last.text = (last.text ?? "") + this.getText(pos);
      return pos;
    }
    return undefined;
  }
}

/** `Parser.compile_sc`'s cache, keyed the way Python keys it plus the flags. */
const SC_CACHE = new Map<string, RegExp>();

function blockSc(rules: readonly string[], flags: string): RegExp {
  const key = `${flags}\u0000${rules.join("|")}`;
  let sc = SC_CACHE.get(key);
  if (!sc) {
    sc = compileSc(BLOCK_SPECIFICATION, rules, flags);
    SC_CACHE.set(key, sc);
  }
  return sc;
}

/** `compile_sc(["thematic_break", "list"])`, which `setex_heading` falls back to. */
const SETEX_FALLBACK_RULES = ["thematic_break", "list"] as const;
/** `compile_sc(["blank_line", "indent_code", "fenced_code"])` in `extract_block_quote`. */
const QUOTE_MARKER_RULES = ["blank_line", "indent_code", "fenced_code"] as const;
/** The block rules that end a block quote's lazy continuation. */
const QUOTE_BREAK_RULES = [
  "blank_line",
  "thematic_break",
  "fenced_code",
  "list",
  "block_html",
] as const;

/**
 * `BlockParser.parse_method`. Returns the new cursor, or `undefined` when the
 * rule declines the match and the caller should fall back to a paragraph line.
 * Mirrors Python's truthiness check, under which a returned 0 also declines.
 */
function parseBlockMethod(
  rule: string,
  m: RegExpExecArray,
  state: BlockState,
): number | undefined {
  switch (rule) {
    case "blank_line":
      state.tokens.push({ type: "blank_line" });
      return m.index + m[0].length;
    case "thematic_break":
      state.tokens.push({ type: "thematic_break" });
      return m.index + m[0].length + 1;
    case "atx_heading":
      return parseAtxHeading(m, state);
    case "setex_heading":
      return parseSetexHeading(m, state);
    case "fenced_code":
      return parseFencedCode(m, state);
    case "indent_code":
      return parseIndentCode(m, state);
    case "block_quote":
      return parseBlockQuote(m, state);
    case "list":
      throw new UnportedMarkdownError(rule, "5.3c-iii-b-1-b-ii-2");
    case "ref_link":
    case "raw_html":
    case "block_html":
      throw new UnportedMarkdownError(rule, "5.3c-iii-b-1-b-ii-3");
    /* istanbul ignore next: BLOCK_RULES is exhaustive above */
    default:
      throw new Error(`markdownToWpHtml: unknown block rule "${rule}"`);
  }
}

/** `BlockParser.parse_atx_heading`. */
function parseAtxHeading(m: RegExpExecArray, state: BlockState): number {
  const level = (m.groups?.atx_1 ?? "").length;
  let text = stripChars(m.groups?.atx_2 ?? "", PY_WHITESPACE);
  if (text) text = text.replace(ATX_HEADING_TRIM, "");
  state.tokens.push({
    type: "heading",
    text,
    attrs: { level },
    style: "atx",
  });
  return m.index + m[0].length + 1;
}

/** `BlockParser.parse_setex_heading`. */
function parseSetexHeading(
  m: RegExpExecArray,
  state: BlockState,
): number | undefined {
  const last = state.lastToken();
  if (last && last.type === "paragraph") {
    last.type = "heading";
    last.style = "setext";
    last.attrs = { level: m.groups?.setext_1 === "=" ? 1 : 2 };
    return m.index + m[0].length + 1;
  }

  const fallbackSc = blockSc(SETEX_FALLBACK_RULES, "y");
  fallbackSc.lastIndex = state.cursor;
  const m2 = fallbackSc.exec(state.src);
  if (m2) {
    return parseBlockMethod(matchedRule(m2, SETEX_FALLBACK_RULES), m2, state);
  }
  return undefined;
}

/** `BlockParser.parse_fenced_code`. */
function parseFencedCode(
  m: RegExpExecArray,
  state: BlockState,
): number | undefined {
  const spaces = m.groups?.fenced_1 ?? "";
  const marker = m.groups?.fenced_2 ?? "";
  let info = m.groups?.fenced_3 ?? "";

  const c = marker[0];
  if (info && c === "`" && info.includes(c)) {
    // CommonMark Example 145: a backtick fence's info string may not hold one.
    return undefined;
  }

  const end = new RegExp(
    `${SOL} {0,3}\\${c}{${marker.length},}[ \\t]*(?:\\n|${EOL})`,
    "g",
  );
  const cursorStart = m.index + m[0].length + 1;

  let code: string;
  let endPos: number;
  const m2 = search(end, state.src, cursorStart);
  if (m2) {
    code = state.src.slice(cursorStart, m2.index);
    endPos = m2.index + m2[0].length;
  } else {
    code = state.src.slice(cursorStart);
    endPos = state.cursorMax;
  }

  if (spaces && code) {
    code = code.replace(new RegExp(`${SOL} {0,${spaces.length}}`, "g"), "");
  }

  const token: Token = {
    type: "block_code",
    raw: code,
    style: "fenced",
    marker,
  };
  if (info) {
    info = unescapeChar(info);
    token.attrs = { info: info.trim() };
  }

  state.tokens.push(token);
  return endPos;
}

const ESCAPE_CHAR_RE = new RegExp(`\\\\(${PUNCTUATION})`, "g");

/** `helpers.unescape_char`. */
function unescapeChar(text: string): string {
  return text.replace(ESCAPE_CHAR_RE, "$1");
}

/** `BlockParser.parse_indent_code`. */
function parseIndentCode(
  m: RegExpExecArray,
  state: BlockState,
): number | undefined {
  const absorbed = state.appendParagraph();
  if (absorbed) return absorbed;

  let code = m[0];
  code = expandLeadingTab(code);
  code = code.replace(INDENT_CODE_TRIM, "");
  code = stripChars(code, "\n");
  state.tokens.push({ type: "block_code", raw: code, style: "indent" });
  return m.index + m[0].length;
}

/** `block_parser._BLOCK_QUOTE_TRIM`: one leading space off every line. */
const BLOCK_QUOTE_TRIM = new RegExp(`${SOL} ?`, "g");
/** `block_parser._BLOCK_QUOTE_LEADING`: the `>` marker and the spaces before it. */
const BLOCK_QUOTE_LEADING = new RegExp(`${SOL} *>`, "g");
/** `block_parser._LINE_BLANK_END`, compiled without `re.M`. */
const LINE_BLANK_END = new RegExp(`\\n[ \\t]*\\n${EOS}`);
/** `block_parser._STRICT_BLOCK_QUOTE`, compiled without `re.M`. */
const STRICT_BLOCK_QUOTE = new RegExp(
  `(?: {0,3}>[^\\n]*(?:\\n|${EOS}))+`,
  "y",
);
/** `BlockParser.max_nested_level`. */
const MAX_NESTED_LEVEL = 6;

/**
 * `BlockParser.extract_block_quote`. Returns the quote's body with its `>`
 * markers stripped, plus the end position of a block the lazy branch parsed on
 * the outer state (which the caller must then step over).
 */
function extractBlockQuote(
  m: RegExpExecArray,
  state: BlockState,
): [string, number | undefined] {
  // Clean up first, so the code-block test below sees what the child will.
  let text = (m.groups?.quote_1 ?? "") + "\n";
  text = expandLeadingTab(text, 3);
  text = text.replace(BLOCK_QUOTE_TRIM, "");

  const markerSc = blockSc(QUOTE_MARKER_RULES, "y");
  markerSc.lastIndex = 0;
  const requireMarker = markerSc.exec(text) !== null;

  state.cursor = m.index + m[0].length + 1;

  let endPos: number | undefined;
  if (requireMarker) {
    // A quote whose first line starts a code block only continues on lines
    // that carry the marker; nothing may be lazy.
    STRICT_BLOCK_QUOTE.lastIndex = state.cursor;
    const m2 = STRICT_BLOCK_QUOTE.exec(state.src);
    if (m2) {
      text += trimQuoteMarkers(m2[0]);
      state.cursor = m2.index + m2[0].length;
    }
  } else {
    let prevBlankLine = false;
    const breakSc = blockSc(QUOTE_BREAK_RULES, "y");
    while (state.cursor < state.cursorMax) {
      STRICT_BLOCK_QUOTE.lastIndex = state.cursor;
      const m3 = STRICT_BLOCK_QUOTE.exec(state.src);
      if (m3) {
        const quote = trimQuoteMarkers(m3[0]);
        text += quote;
        state.cursor = m3.index + m3[0].length;
        prevBlankLine =
          quote.trim() === "" ? true : LINE_BLANK_END.test(quote);
        continue;
      }

      if (prevBlankLine) {
        // CommonMark Example 249: a blank line is needed between a block quote
        // and a following paragraph, so laziness stops here.
        break;
      }

      breakSc.lastIndex = state.cursor;
      const m4 = breakSc.exec(state.src);
      if (m4) {
        endPos = parseBlockMethod(
          matchedRule(m4, QUOTE_BREAK_RULES),
          m4,
          state,
        );
        if (endPos) break;
      }

      // Lazy continuation line.
      const pos = state.findLineEnd();
      text += expandLeadingTab(state.getText(pos), 3);
      state.cursor = pos;
    }
  }

  // CommonMark Example 6: the second tab counts as four spaces.
  return [expandTab(text), endPos];
}

function trimQuoteMarkers(quote: string): string {
  let out = quote.replace(BLOCK_QUOTE_LEADING, "");
  out = expandLeadingTab(out, 3);
  return out.replace(BLOCK_QUOTE_TRIM, "");
}

/** `BlockParser.parse_block_quote`. */
function parseBlockQuote(m: RegExpExecArray, state: BlockState): number {
  const [text, endPos] = extractBlockQuote(m, state);
  const child = state.childState(text);
  const rules =
    state.depth() >= MAX_NESTED_LEVEL - 1
      ? BLOCK_RULES.filter((rule) => rule !== "block_quote")
      : BLOCK_RULES;

  parseBlocks(child, rules);
  const token: Token = { type: "block_quote", children: child.tokens };
  if (endPos) {
    state.prependToken(token);
    return endPos;
  }
  state.tokens.push(token);
  return state.cursor;
}

/** `BlockParser.parse`. */
function parseBlocks(
  state: BlockState,
  rules: readonly string[] = BLOCK_RULES,
): void {
  const sc = blockSc(rules, "g");
  while (state.cursor < state.cursorMax) {
    const m = search(sc, state.src, state.cursor);
    if (!m) break;

    if (m.index > state.cursor) {
      state.addParagraph(state.getText(m.index));
      state.cursor = m.index;
    }

    const endPos = parseBlockMethod(matchedRule(m, rules), m, state);
    if (endPos) {
      state.cursor = endPos;
    } else {
      const lineEnd = state.findLineEnd();
      state.addParagraph(state.getText(lineEnd));
      state.cursor = lineEnd;
    }
  }

  if (state.cursor < state.cursorMax) {
    state.addParagraph(state.src.slice(state.cursor));
    state.cursor = state.cursorMax;
  }
}

const INLINE_SC = compileSc(INLINE_SPECIFICATION, INLINE_RULES, "g");

/** `InlineParser.parse`. */
function parseInline(src: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < src.length) {
    const m = search(INLINE_SC, src, pos);
    if (!m) break;

    if (m.index > pos) tokens.push({ type: "text", raw: src.slice(pos, m.index) });

    const rule = matchedRule(m, INLINE_RULES);
    if (rule !== "linebreak" && rule !== "softbreak") {
      throw new UnportedMarkdownError(rule, "5.3c-iii-b-1-b-iii");
    }
    tokens.push({ type: rule });
    pos = m.index + m[0].length;
  }

  if (pos === 0) {
    tokens.push({ type: "text", raw: src });
  } else if (pos < src.length) {
    tokens.push({ type: "text", raw: src.slice(pos) });
  }
  return tokens;
}

/** `Markdown._iter_render`: inline source is parsed on the way to the renderer. */
function resolveChildren(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.children !== undefined) {
      resolveChildren(token.children);
    } else if (token.text !== undefined) {
      const text = token.text;
      delete token.text;
      token.children = parseInline(stripChars(text, " \r\n\t\f"));
    }
  }
}

/** `_GutenbergRenderer`. */
function renderTokens(tokens: Token[]): string {
  return tokens.map(renderToken).join("");
}

function renderChildren(token: Token): string {
  return renderTokens(token.children ?? []);
}

function renderToken(token: Token): string {
  switch (token.type) {
    case "text":
      return token.raw ?? "";
    case "softbreak":
      return "\n";
    case "linebreak":
      return "<br />\n";
    case "blank_line":
      return "";
    case "paragraph":
      return `<!-- wp:paragraph -->\n<p>${renderChildren(token)}</p>\n<!-- /wp:paragraph -->\n\n`;
    case "heading": {
      const level = token.attrs?.level ?? 2;
      const levelAttr = level !== 2 ? ` {"level":${level}}` : "";
      return (
        `<!-- wp:heading${levelAttr} -->\n` +
        `<h${level}>${renderChildren(token)}</h${level}>\n` +
        `<!-- /wp:heading -->\n\n`
      );
    }
    case "block_code": {
      const lang = token.attrs?.info ?? "";
      const langAttr = lang ? ` {"language":"${lang}"}` : "";
      return (
        `<!-- wp:code${langAttr} -->\n` +
        `<pre class="wp-block-code"><code>${token.raw ?? ""}</code></pre>\n` +
        `<!-- /wp:code -->\n\n`
      );
    }
    case "block_quote":
      return (
        "<!-- wp:quote -->\n" +
        `<blockquote class="wp-block-quote">${renderChildren(token)}</blockquote>\n` +
        "<!-- /wp:quote -->\n\n"
      );
    case "thematic_break":
      return (
        "<!-- wp:separator -->\n" +
        '<hr class="wp-block-separator"/>\n' +
        "<!-- /wp:separator -->\n\n"
      );
    /* istanbul ignore next: every token this parser emits is handled above */
    default:
      throw new Error(`markdownToWpHtml: no renderer for "${token.type}"`);
  }
}

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n/;

/** `markdown_to_wp_html`. */
export function markdownToWpHtml(markdownContent: string): string {
  const content = markdownContent.replace(FRONTMATTER_RE, "");

  // `Markdown.parse`: normalise line separators and guarantee a trailing one.
  let src = content.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!src.endsWith("\n")) src += "\n";

  const state = new BlockState();
  state.process(src);
  parseBlocks(state);
  resolveChildren(state.tokens);
  return renderTokens(state.tokens);
}
