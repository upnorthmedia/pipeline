import { describe, expect, it } from "vitest";

import { markdownToWpHtml } from "./wp-html";

/**
 * The inline `linebreak` and `softbreak` rules, which both end in Python's
 * `\s*` and so decide how much of the *next* line's leading whitespace is
 * swallowed before the break is emitted.
 *
 * There is no parity corpus for these two: they were ported before `PY_SPACE`
 * existed and the corpus generators under the deleted `api/` tree never covered
 * a line beginning with a character the two engines disagree about. The
 * expectations below are read off CPython's `str.isspace()` set, the same
 * source `PY_SPACE` itself was verified against, and checked here rather than
 * left to the emphasis corpus, which reads the class on a different rule.
 */
describe("linebreak and softbreak use Python's whitespace set", () => {
  const body = (html: string) =>
    html
      .replace("<!-- wp:paragraph -->\n<p>", "")
      .replace(/<\/p>\n[\s\S]*$/, "");

  // `\x1c` is whitespace to Python and not to JavaScript; `﻿` is the other
  // way round. Both appear in real article text: `﻿` is a BOM pasted from
  // an editor, `\x1c` a file-separator left by a converter.
  it("swallows a leading `\\x1c`, which Python's `\\s` holds", () => {
    expect(body(markdownToWpHtml("a\n\x1cb\n"))).toBe("a\nb");
    expect(body(markdownToWpHtml("a  \n\x1cb\n"))).toBe("a<br />\nb");
  });

  it("keeps a leading `\\ufeff`, which Python's `\\s` does not hold", () => {
    expect(body(markdownToWpHtml("a\n﻿b\n"))).toBe("a\n﻿b");
    expect(body(markdownToWpHtml("a  \n﻿b\n"))).toBe("a<br />\n﻿b");
  });

  it("still swallows the ordinary indent both engines agree on", () => {
    expect(body(markdownToWpHtml("a\n   b\n"))).toBe("a\nb");
    expect(body(markdownToWpHtml("a  \n   b\n"))).toBe("a<br />\nb");
  });
});
