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
 * Ported here too (ledger 5.3c-iii-b-1-b-ii-2): `list`, which mistune keeps in
 * a module of its own. Almost none of it is visible in the renderer: a fresh
 * break scanner is compiled per item out of six other block patterns with
 * their `{0,3}` indent budgets narrowed to the item's own leading width, the
 * continuation width comes from the first item's text, and tightness is
 * decided from the tokens the child parse produced. A tight list renders its
 * item bodies as `block_text`, which emits no wrapper at all.
 *
 * Ported here too (ledger 5.3c-iii-b-1-b-ii-3-a): `raw_html` and `block_html`,
 * which are CommonMark's seven kinds of HTML block behind one handler. Which
 * one fires is decided by the few characters after the `<`. Rules 1 to 5 scan
 * for a literal end marker and swallow to the end of the line that marker sits
 * on, so they cross blank lines; rules 6 and 7 stop at the next blank line
 * instead. Rule 7 is the only one that cannot interrupt a paragraph and the
 * only one that can decline, leaving its line to the paragraph fallback.
 *
 * Ported here too (ledger 5.3c-iii-b-1-b-ii-3-b-2): `ref_link`, the one block
 * rule that emits no token. Everything it produces goes into
 * `state.env.refLinks`, which the Gutenberg renderer never reads, so the only
 * thing the rendered HTML shows is whether the definition line was consumed.
 * The rule is fussy about position: it cannot interrupt a paragraph, its href
 * scan has a bracketed form that forbids backslashes outright, and both the
 * title and (failing that) the href must be followed by `[ \t]*\n` or the whole
 * definition is abandoned and the line falls back to a paragraph.
 *
 * Ported here too (ledger 5.3c-iii-b-1-b-iii-a): the inline layer's own state
 * and scan loop, plus the two rules that need nothing from it. `escape` strips
 * the backslashes off a run of escaped punctuation and emits plain text, so a
 * `\\*` never reaches the emphasis rule. `codespan` compiles a closing pattern
 * per opening run, which is why a run of three backticks does not close a run of
 * two, and it folds newlines into spaces and drops one space from each end only
 * when the code is not blank. A backtick inside a backtick fence's info string
 * declines the fence, and the paragraph it falls back to lands here.
 *
 * Ported here too (ledger 5.3c-iii-b-1-b-iii-b): `auto_link`, `auto_email` and
 * `inline_html`, the three rules that turn on `in_link`. Inside an anchor an
 * autolink is not a link, it is the text it was written as, which is what stops
 * a hand written `<a>` from nesting a second one. `inline_html` is also the one
 * inline token `_GutenbergRenderer` has no method for, so any document holding
 * a tag inside a paragraph raises out of the renderer rather than converting;
 * `MissingRendererError` is where mistune raises `AttributeError`.
 *
 * Not ported yet: `emphasis` (5.3c-iii-b-1-b-iii-c), and `link` and `image`
 * (5.3c-iii-b-1-b-iii-d). Their *patterns* are registered here in mistune's rule
 * order, because rule order is what decides which of two rules matching at the
 * same offset wins, and their handlers throw `UnportedMarkdownError`. A
 * half-ported converter that silently dropped a link would be worse than one
 * that stops.
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

import { escapeUrl } from "./escape-url";

/** A mistune token. `text` is inline source, `raw` is not parsed further. */
export type Token = {
  type: string;
  raw?: string;
  text?: string;
  children?: Token[];
  attrs?: {
    level?: number;
    info?: string;
    depth?: number;
    ordered?: boolean;
    start?: number;
    url?: string;
    title?: string | null;
  };
  style?: string;
  marker?: string;
  /** `list` only: false once a blank line or a second paragraph is seen. */
  tight?: boolean;
  /** `list` only: the marker character the list opened with. */
  bullet?: string;
  /** `list` only, transient: where the block that broke the list out ended. */
  endPos?: number;
  /** `list` only, transient: where in `state.tokens` the list must be inserted. */
  tokIndex?: number;
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

/**
 * Thrown where mistune's `BaseRenderer._get_method` raises
 * `AttributeError: No renderer "'<type>'"`.
 *
 * `_GutenbergRenderer` deliberately implements only the token types the
 * pipeline's own markdown produces, so an `inline_html` token, which is what a
 * hand written tag inside a paragraph becomes, aborts the whole conversion in
 * Python. The port raises in the same place rather than inventing an output for
 * it.
 */
export class MissingRendererError extends Error {
  readonly tokenType: string;

  constructor(tokenType: string) {
    super(`markdownToWpHtml: no renderer for "${tokenType}"`);
    this.name = "MissingRendererError";
    this.tokenType = tokenType;
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

/**
 * Python's `\s` for `str` patterns, spelled out. It is `str.isspace()`'s set,
 * which holds `\x1c`-`\x1f` and `\x85` where JavaScript's `\s` does not, and
 * lacks `\ufeff`, which JavaScript's has.
 */
const PY_SPACE =
  "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a" +
  "\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, "g");
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

/**
 * Python `str.strip()` with no argument. Not `String.prototype.trim`, which
 * also strips `\ufeff`: that is not whitespace to Python, so a document or a
 * fence info string ending in a byte order mark keeps it.
 */
function pyStrip(text: string): string {
  return text.replace(PY_STRIP_RE, "");
}

/** `str.split()` with no separator: split on runs of whitespace, drop the ends. */
function pySplitWhitespace(s: string): string[] {
  return s.split(PY_SPACE_RUN).filter((part) => part !== "");
}

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

/**
 * A reference-link definition, as `parse_ref_link` stores it. `label` is the
 * raw label from the source, not the folded key it is filed under.
 */
export type RefLink = {
  url: string;
  label: string;
  title?: string;
};

/**
 * `state.env`, shared between the block state and every inline state parsed out
 * of it. A `Map` rather than an object because Python looks the key up in a
 * `dict`, where `in` cannot reach a prototype.
 */
type InlineEnv = { refLinks: Map<string, RefLink> };

/** `BlockState`. */
class BlockState {
  src = "";
  tokens: Token[] = [];
  cursor = 0;
  cursorMax = 0;
  readonly parent?: BlockState;
  /**
   * Shared with the parent state, so a definition inside a block quote or a
   * list item is visible to the whole document.
   */
  readonly env: InlineEnv;

  constructor(parent?: BlockState) {
    this.parent = parent;
    this.env = parent ? parent.env : { refLinks: new Map() };
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
      return parseList(m, state);
    case "raw_html":
    // `parse_block_html` is a one-line delegation to `parse_raw_html`.
    case "block_html":
      return parseRawHtml(m, state);
    case "ref_link":
      return parseRefLink(m, state);
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
    token.attrs = { info: pyStrip(info) };
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

/** `list_parser._LINE_HAS_TEXT`, used with `.match` so it is anchored at 0. */
const LINE_HAS_TEXT = /(\s*)\S/y;
/** `BlockParser.BLANK_LINE`, used with `.match` so it is anchored at 0. */
const BLANK_LINE_ANCHORED = new RegExp(`(?:${SOL}[ \\t\\v\\f]*\\n)+`, "y");
/** `util.strip_end`, compiled without `re.M`. */
const STRIP_END_RE = new RegExp(`\\n\\s+${EOS}`);

/** `util.strip_end`. */
function stripEnd(src: string): string {
  return src.replace(STRIP_END_RE, "\n");
}

/**
 * `list_parser._parse_list_item`'s break list, in its order. `fenced_directive`
 * is skipped because it is a plugin and is not in this parser's specification.
 */
const LIST_ITEM_BREAKS = [
  "thematic_break",
  "fenced_code",
  "atx_heading",
  "block_quote",
  "block_html",
  "list",
] as const;

/** `list_parser._get_list_bullet`. */
function getListBullet(c: string): string {
  if (c === ".") return "\\d{0,9}\\.";
  if (c === ")") return "\\d{0,9}\\)";
  if (c === "*") return "\\*";
  if (c === "+") return "\\+";
  return "-";
}

/** `list_parser._compile_list_item_pattern`. */
function compileListItemPattern(bullet: string, leadingWidth: number): string {
  const width = leadingWidth > 3 ? 3 : leadingWidth;
  return (
    `${SOL}(?<listitem_1> {0,${width}})` +
    `(?<listitem_2>${bullet})` +
    `(?<listitem_3>[ \\t]*|[ \\t][^\\n]+)${EOL}`
  );
}

/**
 * The per-item break scanner. Every alternative is prefixed with `(?<=\n)`, so
 * a break can only be recognised at the start of a line that is not the first
 * in the document, and when the item's leading width is under three the first
 * `3` in each pattern (always the `{0,3}` indent budget) is rewritten down to
 * it, which is how a one-character marker keeps a two-space indent from
 * reading as a sibling block.
 */
function compileListItemSc(
  bullet: string,
  leadingWidth: number,
): [RegExp, string[]] {
  let pairs: Array<[string, string]> = LIST_ITEM_BREAKS.map((name) => [
    name,
    BLOCK_SPECIFICATION[name],
  ]);
  if (leadingWidth < 3) {
    const repl = String(leadingWidth);
    pairs = pairs.map(([name, pattern]) => [name, pattern.replace("3", repl)]);
  }
  pairs.splice(1, 0, [
    "list_item",
    compileListItemPattern(bullet, leadingWidth),
  ]);
  const source = pairs
    .map(([name, pattern]) => `(?<${name}>(?<=\\n)${pattern})`)
    .join("|");
  return [new RegExp(source, "y"), pairs.map(([name]) => name)];
}

/** `list_parser._compile_continue_width`. */
function compileContinueWidth(
  text: string,
  leadingWidth: number,
): [string, number] {
  let body = expandLeadingTab(text, 3);
  body = expandTab(body);

  LINE_HAS_TEXT.lastIndex = 0;
  const m2 = LINE_HAS_TEXT.exec(body);
  let spaceWidth: number;
  if (m2) {
    // Five spaces means indented code, which keeps four of them.
    spaceWidth = body.startsWith("     ") ? 1 : m2[1].length;
    body = body.slice(spaceWidth) + "\n";
  } else {
    spaceWidth = 1;
    body = "";
  }
  return [body, leadingWidth + spaceWidth];
}

/** `list_parser._clean_list_item_text`. */
function cleanListItemText(src: string, continueWidth: number): string {
  const trimSpace = " ".repeat(continueWidth);
  return src
    .split("\n")
    .map((line) => {
      if (!line.startsWith(trimSpace)) return line;
      // CommonMark Example 5: the tab left behind counts as four spaces.
      return expandTab(line.replace(trimSpace, ""));
    })
    .join("\n");
}

/** `list_parser._is_loose_list`. */
function isLooseList(tokens: Token[]): boolean {
  let paragraphCount = 0;
  for (const token of tokens) {
    if (token.type === "blank_line") return true;
    if (token.type === "paragraph") {
      paragraphCount += 1;
      if (paragraphCount > 1) return true;
    }
  }
  return false;
}

/**
 * `list_parser._transform_tight_list`. A tight list renders its item bodies as
 * `block_text`, which the Gutenberg renderer emits with no wrapper at all, so
 * this is the whole visible difference between a tight and a loose list.
 */
function transformTightList(token: Token): void {
  if (!token.tight) return;
  for (const listItem of token.children ?? []) {
    for (const child of listItem.children ?? []) {
      if (child.type === "paragraph") {
        child.type = "block_text";
      } else if (child.type === "list") {
        transformTightList(child);
      }
    }
  }
}

/** `list_parser._parse_list_item`. Returns the next item's groups, if any. */
function parseListItem(
  bullet: string,
  groups: [string, string, string],
  token: Token,
  state: BlockState,
  rules: readonly string[],
): [string, string, string] | undefined {
  const [spaces, marker, rawText] = groups;

  const leadingWidth = spaces.length + marker.length;
  const [head, continueWidth] = compileContinueWidth(rawText, leadingWidth);
  let text = head;
  const [sc, names] = compileListItemSc(bullet, leadingWidth);

  let src = "";
  let nextGroup: [string, string, string] | undefined;
  let prevBlankLine = false;
  let pos = state.cursor;
  const continueSpace = " ".repeat(continueWidth);

  while (pos < state.cursorMax) {
    pos = state.findLineEnd();
    let line = state.getText(pos);

    BLANK_LINE_ANCHORED.lastIndex = 0;
    if (BLANK_LINE_ANCHORED.test(line)) {
      src += "\n";
      prevBlankLine = true;
      state.cursor = pos;
      continue;
    }

    line = expandLeadingTab(line);
    if (line.startsWith(continueSpace)) {
      if (prevBlankLine && !text && !src.trim()) {
        // CommonMark Example 280: an item may begin with at most one blank line.
        break;
      }
      src += line;
      prevBlankLine = false;
      state.cursor = pos;
      continue;
    }

    sc.lastIndex = state.cursor;
    const m = sc.exec(state.src);
    if (m) {
      const tokType = matchedRule(m, names);
      if (tokType === "list_item") {
        if (prevBlankLine) token.tight = false;
        nextGroup = [
          m.groups?.listitem_1 ?? "",
          m.groups?.listitem_2 ?? "",
          m.groups?.listitem_3 ?? "",
        ];
        state.cursor = m.index + m[0].length + 1;
        break;
      }

      if (tokType === "list") break;

      const tokIndex = state.tokens.length;
      const endPos = parseBlockMethod(tokType, m, state);
      if (endPos) {
        token.tokIndex = tokIndex;
        token.endPos = endPos;
        break;
      }
    }

    if (prevBlankLine && !line.startsWith(continueSpace)) {
      break;
    }

    src += line;
    state.cursor = pos;
  }

  text += cleanListItemText(src, continueWidth);
  const child = state.childState(stripEnd(text));
  parseBlocks(child, rules);

  if (token.tight && isLooseList(child.tokens)) {
    token.tight = false;
  }

  token.children?.push({ type: "list_item", children: child.tokens });
  return nextGroup;
}

/** `list_parser.parse_list`. */
function parseList(m: RegExpExecArray, state: BlockState): number | undefined {
  const text = m.groups?.list_3 ?? "";
  if (!text.trim()) {
    // CommonMark Example 285: an empty item cannot interrupt a paragraph.
    const absorbed = state.appendParagraph();
    if (absorbed) return absorbed;
  }

  const marker = m.groups?.list_2 ?? "";
  const ordered = marker.length > 1;
  const depth = state.depth();
  const token: Token = {
    type: "list",
    children: [],
    tight: true,
    bullet: marker[marker.length - 1],
    attrs: { depth, ordered },
  };

  if (ordered) {
    const start = Number.parseInt(marker.slice(0, -1), 10);
    if (start !== 1) {
      // CommonMark Example 304: only a list starting at 1 interrupts a paragraph.
      const absorbed = state.appendParagraph();
      if (absorbed) return absorbed;
      token.attrs!.start = start;
    }
  }

  state.cursor = m.index + m[0].length + 1;

  const rules =
    depth >= MAX_NESTED_LEVEL - 1
      ? BLOCK_RULES.filter((rule) => rule !== "list")
      : BLOCK_RULES;

  const bullet = getListBullet(marker[marker.length - 1]);
  let groups: [string, string, string] | undefined = [
    m.groups?.list_1 ?? "",
    marker,
    text,
  ];
  while (groups) {
    groups = parseListItem(bullet, groups, token, state, rules);
  }

  const endPos = token.endPos;
  const tokIndex = token.tokIndex;
  delete token.endPos;
  delete token.tokIndex;

  transformTightList(token);
  if (endPos) {
    state.tokens.splice(tokIndex!, 0, token);
    return endPos;
  }

  state.tokens.push(token);
  return state.cursor;
}

/** `BlockParser.BLANK_LINE`, as a searchable pattern. */
const BLANK_LINE_SEARCH = new RegExp(BLOCK_SPECIFICATION.blank_line, "g");

/**
 * `_OPEN_TAG_END` and `_CLOSE_TAG_END`. Both are compiled without `re.M`, so
 * their `$` is `EOS`, and both are used through `re.match(src, pos, endpos)`,
 * where `endpos` truncates the subject and so moves where `$` can match.
 */
const OPEN_TAG_END = new RegExp(
  `${HTML_ATTRIBUTES}[ \\t]*>[ \\t]*(?:\\n|${EOS})`,
  "y",
);
const CLOSE_TAG_END = new RegExp(`[ \\t]*>[ \\t]*(?:\\n|${EOS})`, "y");

/** `re.match(src, pos, endpos)`: `endpos` is the end of the subject, not a limit. */
function boundedMatch(
  re: RegExp,
  src: string,
  pos: number,
  endPos: number,
): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(src.slice(0, endPos));
}

/**
 * `_parse_html_to_end`: rules 1 to 5. The block reaches to the end of the line
 * the end marker lands on, which is why a comment or a `<script>` can contain a
 * blank line without ending. An absent marker runs to the end of the document.
 */
function parseHtmlToEnd(
  state: BlockState,
  endMarker: string,
  startPos: number,
): number {
  const markerPos = state.src.indexOf(endMarker, startPos);
  let text: string;
  let endPos: number;
  if (markerPos === -1) {
    text = state.src.slice(state.cursor);
    endPos = state.cursorMax;
  } else {
    text = state.getText(markerPos);
    state.cursor = markerPos;
    endPos = state.findLineEnd();
    text += state.getText(endPos);
  }
  state.tokens.push({ type: "block_html", raw: text });
  return endPos;
}

/** `_parse_html_to_newline`: rules 6 and 7, which stop at the next blank line. */
function parseHtmlToNewline(state: BlockState): number {
  const m = search(BLANK_LINE_SEARCH, state.src, state.cursor);
  let text: string;
  let endPos: number;
  if (m) {
    endPos = m.index;
    text = state.getText(endPos);
  } else {
    text = state.src.slice(state.cursor);
    endPos = state.cursorMax;
  }
  state.tokens.push({ type: "block_html", raw: text });
  return endPos;
}

/**
 * `BlockParser.parse_raw_html`, which `parse_block_html` also delegates to.
 *
 * `marker` is the whole match stripped of whitespace, so it is the `<` plus the
 * tag name (or the declaration opener) and nothing else. Note that mistune
 * decides rule 1 and rule 6 off the *tag name only*, before it has established
 * that the tag is even closed; only rule 7 checks for a `>`.
 */
function parseRawHtml(
  m: RegExpExecArray,
  state: BlockState,
): number | undefined {
  const marker = stripChars(m[0], PY_WHITESPACE);
  const matchEnd = m.index + m[0].length;

  // rule 2
  if (marker === "<!--") return parseHtmlToEnd(state, "-->", matchEnd);
  // rule 3
  if (marker === "<?") return parseHtmlToEnd(state, "?>", matchEnd);
  // rule 5
  if (marker === "<![CDATA[") return parseHtmlToEnd(state, "]]>", matchEnd);
  // rule 4
  if (marker.startsWith("<!")) return parseHtmlToEnd(state, ">", matchEnd);

  let closeTag: string | undefined;
  let openTag: string | undefined;
  if (marker.startsWith("</")) {
    closeTag = marker.slice(2).toLowerCase();
    // rule 6
    if (BLOCK_TAGS.includes(closeTag)) return parseHtmlToNewline(state);
  } else {
    openTag = marker.slice(1).toLowerCase();
    // rule 1
    if (PRE_TAGS.includes(openTag)) {
      return parseHtmlToEnd(state, `</${openTag}>`, matchEnd);
    }
    // rule 6
    if (BLOCK_TAGS.includes(openTag)) return parseHtmlToNewline(state);
  }

  // Blocks of type 7 may not interrupt a paragraph.
  const appended = state.appendParagraph();
  if (appended) return appended;

  // rule 7
  const lineEnd = state.findLineEnd();
  if (
    (openTag && boundedMatch(OPEN_TAG_END, state.src, matchEnd, lineEnd)) ||
    (closeTag && boundedMatch(CLOSE_TAG_END, state.src, matchEnd, lineEnd))
  ) {
    return parseHtmlToNewline(state);
  }

  return undefined;
}

/** `re.match(src, pos)`: anchored at `pos`, but still looking at the whole string. */
function anchoredMatch(
  re: RegExp,
  src: string,
  pos: number,
): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(src);
}

/** `helpers.LINK_BRACKET_START`. */
const LINK_BRACKET_START = /[ \t]*\n?[ \t]*</y;
/** `helpers.LINK_BRACKET_RE`. A backslash inside the brackets kills the match. */
const LINK_BRACKET_RE = /<([^<>\n\\\x00]*)>/y;
/** `helpers.LINK_HREF_BLOCK_RE`, compiled without `re.M`, so its `$` is `EOS`. */
const LINK_HREF_BLOCK_RE = new RegExp(
  `[ \\t]*\\n?[ \\t]*([^${PY_SPACE}]+)(?:[${PY_SPACE}]|${EOS})`,
  "y",
);
/** `helpers.LINK_TITLE_RE`. */
const LINK_TITLE_RE = new RegExp(
  `[ \\t\\n]+(` +
    `"(?:\\\\${PUNCTUATION}|[^"\\x00])*"|` +
    `'(?:\\\\${PUNCTUATION}|[^'\\x00])*'` +
    `)`,
  "y",
);
/** `block_parser._BLANK_TO_LINE`. */
const BLANK_TO_LINE = /[ \t]*\n/y;

/**
 * `helpers.parse_link_href` in its `block=True` form. Python returns the pair
 * `(href, end_pos)` or `(None, None)`; this returns the pair as an object, or
 * `undefined`, because the two halves are never independently absent.
 *
 * The `block=False` branch (`LINK_HREF_INLINE_RE`) belongs to the inline `link`
 * rule and lands with ledger item 5.3c-iii-b-1-b-iii, so it is not ported here.
 *
 * The end position is off by one depending on how the bare form stopped: the
 * trailing `(?:\s|$)` consumes a whitespace character when there is one, and
 * mistune backs the cursor off it by comparing the last character of the match
 * with the last character of the href.
 */
function parseLinkHref(
  src: string,
  startPos: number,
): { href: string; endPos: number } | undefined {
  const bracket = anchoredMatch(LINK_BRACKET_START, src, startPos);
  if (bracket) {
    const openPos = startPos + bracket[0].length - 1;
    const closed = anchoredMatch(LINK_BRACKET_RE, src, openPos);
    if (closed) return { href: closed[1], endPos: openPos + closed[0].length };
    return undefined;
  }

  const m = anchoredMatch(LINK_HREF_BLOCK_RE, src, startPos);
  if (!m) return undefined;

  const endPos = startPos + m[0].length;
  const href = m[1];
  if (src[endPos - 1] === href[href.length - 1]) return { href, endPos };
  return { href, endPos: endPos - 1 };
}

/**
 * `helpers.parse_link_title`. `maxPos` truncates the subject rather than
 * limiting the match, which is what stops a title from being found across the
 * blank line that ends the definition's paragraph.
 */
function parseLinkTitle(
  src: string,
  startPos: number,
  maxPos: number,
): { title: string; endPos: number } | undefined {
  const m = boundedMatch(LINK_TITLE_RE, src, startPos, maxPos);
  if (!m) return undefined;
  return {
    title: unescapeChar(m[1].slice(1, -1)),
    endPos: startPos + m[0].length,
  };
}

/**
 * `util.unikey`. `" ".join(s.split())` collapses every run of whitespace, and
 * `.lower().upper()` is a two-step case fold, not a plain upper-casing: it is
 * what maps `ß` to `SS` and the Kelvin sign to a plain `K`.
 */
function unikey(s: string): string {
  return pySplitWhitespace(s).join(" ").toLowerCase().toUpperCase();
}

/**
 * `BlockParser.parse_ref_link`. Emits no token: the definition goes into
 * `state.env.refLinks` and the rendered output simply loses the line.
 *
 * The first definition for a key wins, including its title, so a later
 * definition of the same key is consumed and discarded rather than merged.
 */
function parseRefLink(
  m: RegExpExecArray,
  state: BlockState,
): number | undefined {
  const absorbed = state.appendParagraph();
  if (absorbed) return absorbed;

  const label = m.groups?.reflink_1 ?? "";
  const key = unikey(label);
  if (!key) return undefined;

  const hrefMatch = parseLinkHref(state.src, m.index + m[0].length);
  if (!hrefMatch) return undefined;
  let href: string | undefined = hrefMatch.href;
  let hrefPos: number | undefined = hrefMatch.endPos;

  const blank = search(BLANK_LINE_SEARCH, state.src, hrefPos);
  const maxPos = blank ? blank.index : state.cursorMax;

  const titleMatch = parseLinkTitle(state.src, hrefPos, maxPos);
  let title: string | undefined = titleMatch?.title;
  let titlePos: number | undefined = titleMatch?.endPos;
  if (titlePos) {
    const afterTitle = anchoredMatch(BLANK_TO_LINE, state.src, titlePos);
    if (afterTitle) {
      titlePos += afterTitle[0].length;
    } else {
      titlePos = undefined;
      title = undefined;
    }
  }

  if (titlePos === undefined) {
    const afterHref = anchoredMatch(BLANK_TO_LINE, state.src, hrefPos);
    if (afterHref) {
      hrefPos += afterHref[0].length;
    } else {
      hrefPos = undefined;
      href = undefined;
    }
  }

  const endPos = titlePos || hrefPos;
  if (!endPos) return undefined;

  const refLinks = state.env.refLinks;
  if (!refLinks.has(key)) {
    const data: RefLink = {
      url: escapeUrl(unescapeChar(href as string)),
      label,
    };
    if (title) data.title = title;
    refLinks.set(key, data);
  }
  return endPos;
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

/** Which ledger item each still-unported inline rule belongs to. */
const UNPORTED_INLINE_RULES: Record<string, string> = {
  emphasis: "5.3c-iii-b-1-b-iii-c",
  link: "5.3c-iii-b-1-b-iii-d",
};

/** `InlineState`. */
class InlineState {
  src = "";
  tokens: Token[] = [];
  inImage = false;
  inLink = false;
  inEmphasis = false;
  inStrong = false;
  /** Shared with the block state, so `ref_links` is visible to the `link` rule. */
  readonly env: InlineEnv;

  constructor(env: InlineEnv) {
    this.env = env;
  }

  appendToken(token: Token): void {
    this.tokens.push(token);
  }

  /** `copy`: the four nesting flags carry over, `src` and `tokens` do not. */
  copy(): InlineState {
    const state = new InlineState(this.env);
    state.inImage = this.inImage;
    state.inLink = this.inLink;
    state.inEmphasis = this.inEmphasis;
    state.inStrong = this.inStrong;
    return state;
  }
}

/** `InlineParser.process_text`. */
function processText(text: string, state: InlineState): void {
  state.appendToken({ type: "text", raw: text });
}

/** `InlineParser.parse_escape`: the backslashes come off, the token is text. */
function parseEscape(m: RegExpExecArray, state: InlineState): number {
  processText(unescapeChar(m[0]), state);
  return m.index + m[0].length;
}

/** Python `len(s.strip())`, which uses `str.isspace()`'s set, not JavaScript's. */
const PY_NON_SPACE = new RegExp(`[^${PY_SPACE}]`);

/** `InlineParser.parse_codespan`. */
function parseCodespan(m: RegExpExecArray, state: InlineState): number {
  const marker = m[0];
  const pos = m.index + marker.length;

  // `re.compile(r"(.*?[^`])" + marker + r"(?!`)", re.S).match(src, pos)`: the
  // closing run must be exactly as long as the opening one, and the character
  // before it must not be a backtick, which is what makes the run "exactly".
  const end = new RegExp(`([\\s\\S]*?[^\`])${marker}(?!\`)`, "y");
  end.lastIndex = pos;
  const m2 = end.exec(state.src);
  if (!m2) {
    processText(marker, state);
    return pos;
  }

  let code = m2[1].replace(/\n/g, " ");
  if (PY_NON_SPACE.test(code) && code.startsWith(" ") && code.endsWith(" ")) {
    code = code.slice(1, -1);
  }
  state.appendToken({ type: "codespan", raw: code });
  return end.lastIndex;
}

/** `InlineParser._add_auto_link`. */
function addAutoLink(url: string, text: string, state: InlineState): void {
  state.appendToken({
    type: "link",
    children: [{ type: "text", raw: text }],
    attrs: { url: escapeUrl(url) },
  });
}

/**
 * `InlineParser.parse_auto_link`.
 *
 * Inside an `<a>` the autolink is not a link, it is the text it was written as,
 * angle brackets and all. Outside one the brackets come off and the same string
 * is both the href and the label, with `escape_url` applied to the href only.
 */
function parseAutoLink(m: RegExpExecArray, state: InlineState): number {
  const text = m[0];
  const pos = m.index + text.length;
  if (state.inLink) {
    processText(text, state);
    return pos;
  }
  const inner = text.slice(1, -1);
  addAutoLink(inner, inner, state);
  return pos;
}

/** `InlineParser.parse_auto_email`: the same, with a `mailto:` href. */
function parseAutoEmail(m: RegExpExecArray, state: InlineState): number {
  const text = m[0];
  const pos = m.index + text.length;
  if (state.inLink) {
    processText(text, state);
    return pos;
  }
  const inner = text.slice(1, -1);
  addAutoLink(`mailto:${inner}`, inner, state);
  return pos;
}

/**
 * `InlineParser.parse_inline_html`.
 *
 * The tag is kept verbatim in an `inline_html` token, which
 * `_GutenbergRenderer` has no method for, so rendering one raises. The side
 * effect is the point: an opening `<a>` turns `in_link` on for the rest of the
 * inline run and a closing one turns it back off, which is how a hand written
 * anchor stops an autolink inside it from nesting a second `<a>`. Python tests
 * the four literal prefixes rather than parsing the tag, so `<a\n>` toggles
 * nothing even though it is a valid opening anchor.
 */
function parseInlineHtml(m: RegExpExecArray, state: InlineState): number {
  const html = m[0];
  state.appendToken({ type: "inline_html", raw: html });
  if (["<a ", "<a>", "<A ", "<A>"].some((p) => html.startsWith(p))) {
    state.inLink = true;
  } else if (["</a ", "</a>", "</A ", "</A>"].some((p) => html.startsWith(p))) {
    state.inLink = false;
  }
  return m.index + html.length;
}

/** `Parser.parse_method`: dispatch on the rule whose alternative matched. */
function parseInlineMethod(
  m: RegExpExecArray,
  state: InlineState,
): number | undefined {
  const rule = matchedRule(m, INLINE_RULES);
  switch (rule) {
    case "escape":
      return parseEscape(m, state);
    case "codespan":
      return parseCodespan(m, state);
    case "auto_link":
      return parseAutoLink(m, state);
    case "auto_email":
      return parseAutoEmail(m, state);
    case "inline_html":
      return parseInlineHtml(m, state);
    case "linebreak":
    case "softbreak":
      state.appendToken({ type: rule });
      return m.index + m[0].length;
    default:
      throw new UnportedMarkdownError(rule, UNPORTED_INLINE_RULES[rule]);
  }
}

/** `InlineParser.parse`. */
function parseInline(state: InlineState): Token[] {
  const src = state.src;
  let pos = 0;

  while (pos < src.length) {
    const m = search(INLINE_SC, src, pos);
    if (!m) break;

    const endPos = m.index;
    if (endPos > pos) processText(src.slice(pos, endPos), state);

    const newPos = parseInlineMethod(m, state);
    if (!newPos) {
      // A handler that declines gives up its opening character to the text
      // run and the scan restarts one past it. Only `link` declines, and that
      // is ledger item 5.3c-iii-b-1-b-iii-d, so nothing reaches this yet.
      pos = endPos + 1;
      processText(src.slice(endPos, pos), state);
    } else {
      pos = newPos;
    }
  }

  if (pos === 0) {
    processText(src, state);
  } else if (pos < src.length) {
    processText(src.slice(pos), state);
  }
  return state.tokens;
}

/** `Markdown._iter_render`: inline source is parsed on the way to the renderer. */
function resolveChildren(tokens: Token[], env: InlineEnv): void {
  for (const token of tokens) {
    if (token.children !== undefined) {
      resolveChildren(token.children, env);
    } else if (token.text !== undefined) {
      const text = token.text;
      delete token.text;
      const state = new InlineState(env);
      state.src = stripChars(text, " \r\n\t\f");
      token.children = parseInline(state);
    }
  }
}

/**
 * `_GutenbergRenderer.__call__`.
 *
 * Exported because a few of the renderer's branches are unreachable from any
 * markdown the parser can currently produce: `_add_auto_link` never sets a
 * title, so `link`'s title branch has no input until the `link` rule lands.
 * Pinning those against the real Python method needs a token, not a document.
 */
export function renderTokens(tokens: Token[]): string {
  return tokens.map(renderToken).join("");
}

function renderChildren(token: Token): string {
  return renderTokens(token.children ?? []);
}

function renderToken(token: Token): string {
  switch (token.type) {
    case "text":
      return token.raw ?? "";
    case "codespan":
      return `<code>${token.raw ?? ""}</code>`;
    case "link": {
      const text = renderChildren(token);
      const url = token.attrs?.url ?? "";
      const title = token.attrs?.title;
      if (title) return `<a href="${url}" title="${title}">${text}</a>`;
      return `<a href="${url}">${text}</a>`;
    }
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
    case "list": {
      const body = renderChildren(token);
      if (token.attrs?.ordered) {
        return (
          '<!-- wp:list {"ordered":true} -->\n' +
          `<ol>${body}</ol>\n` +
          "<!-- /wp:list -->\n\n"
        );
      }
      return `<!-- wp:list -->\n<ul>${body}</ul>\n<!-- /wp:list -->\n\n`;
    }
    case "list_item":
      return `<li>${renderChildren(token)}</li>\n`;
    case "block_text":
      return renderChildren(token);
    case "block_quote":
      return (
        "<!-- wp:quote -->\n" +
        `<blockquote class="wp-block-quote">${renderChildren(token)}</blockquote>\n` +
        "<!-- /wp:quote -->\n\n"
      );
    case "block_html":
      return `<!-- wp:html -->\n${token.raw ?? ""}\n<!-- /wp:html -->\n\n`;
    case "thematic_break":
      return (
        "<!-- wp:separator -->\n" +
        '<hr class="wp-block-separator"/>\n' +
        "<!-- /wp:separator -->\n\n"
      );
    // `inline_html` is listed for the reader: `_GutenbergRenderer` has no
    // method for it, so it takes the same path as any other unhandled type.
    case "inline_html":
    default:
      throw new MissingRendererError(token.type);
  }
}

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n/;

/** `markdown_to_wp_html`. */
export function markdownToWpHtml(markdownContent: string): string {
  const content = markdownContent.replace(FRONTMATTER_RE, "");

  // `Markdown.parse`: normalise line separators and guarantee a trailing one.
  let src = pyStrip(content).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!src.endsWith("\n")) src += "\n";

  const state = new BlockState();
  state.process(src);
  parseBlocks(state);
  resolveChildren(state.tokens, state.env);
  return renderTokens(state.tokens);
}

/**
 * `InlineParser.__call__`: the inline token stream for one source string.
 *
 * The renderer cannot show everything the inline layer does. `in_link` has no
 * output of its own, and the one rule that toggles it, `inline_html`, has no
 * renderer method at all, so a document that exercises the flag aborts before
 * anything is rendered. This is the surface the flag is verified against, and
 * `web/src/mastra/wordpress/data/wp-html-inline-autolink-tokens-parity.json`
 * holds mistune's own answers for it.
 */
export function parseInlineTokens(src: string): Token[] {
  const state = new InlineState({ refLinks: new Map() });
  state.src = src;
  return parseInline(state);
}

/**
 * The `state.env['ref_links']` map a document produces, as a plain object.
 *
 * `parse_ref_link` emits no token and `_GutenbergRenderer` never reads the env,
 * so this is the only way to observe the rule until the inline `link` rule
 * lands (ledger item 5.3c-iii-b-1-b-iii). It stops after the block parse, which
 * is where Python fills the env, so it works on documents whose inline layer is
 * still unported.
 */
export function parseRefLinks(
  markdownContent: string,
): Record<string, RefLink> {
  const content = markdownContent.replace(FRONTMATTER_RE, "");
  let src = pyStrip(content).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!src.endsWith("\n")) src += "\n";

  const state = new BlockState();
  state.process(src);
  parseBlocks(state);
  return Object.fromEntries(state.env.refLinks);
}
