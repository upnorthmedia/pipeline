"""Convert markdown content to WordPress Gutenberg block HTML."""

from __future__ import annotations

import re

import mistune


def markdown_to_wp_html(markdown_content: str) -> str:
    # Strip YAML frontmatter
    content = re.sub(r"^---\s*\n.*?\n---\s*\n", "", markdown_content, flags=re.DOTALL)

    md = mistune.create_markdown(renderer=_GutenbergRenderer())
    return md(content.strip())


class _GutenbergRenderer(mistune.BaseRenderer):
    NAME = "gutenberg"

    def render_children(self, token: dict, state: object) -> str:
        children = token.get("children", [])
        return self.render_tokens(children, state)

    def text(self, token: dict, state: object) -> str:
        return token["raw"]

    def emphasis(self, token: dict, state: object) -> str:
        text = self.render_children(token, state)
        return f"<em>{text}</em>"

    def strong(self, token: dict, state: object) -> str:
        text = self.render_children(token, state)
        return f"<strong>{text}</strong>"

    def link(self, token: dict, state: object) -> str:
        text = self.render_children(token, state)
        url = token["attrs"]["url"]
        title = token["attrs"].get("title")
        if title:
            return f'<a href="{url}" title="{title}">{text}</a>'
        return f'<a href="{url}">{text}</a>'

    def codespan(self, token: dict, state: object) -> str:
        return f"<code>{token['raw']}</code>"

    def softbreak(self, token: dict, state: object) -> str:
        return "\n"

    def linebreak(self, token: dict, state: object) -> str:
        return "<br />\n"

    def paragraph(self, token: dict, state: object) -> str:
        text = self.render_children(token, state)
        return f"<!-- wp:paragraph -->\n<p>{text}</p>\n<!-- /wp:paragraph -->\n\n"

    def heading(self, token: dict, state: object) -> str:
        text = self.render_children(token, state)
        level = token["attrs"]["level"]
        tag = f"h{level}"
        level_attr = f' {{"level":{level}}}' if level != 2 else ""
        return (
            f"<!-- wp:heading{level_attr} -->\n"
            f"<{tag}>{text}</{tag}>\n"
            f"<!-- /wp:heading -->\n\n"
        )

    def image(self, token: dict, state: object) -> str:
        src = token["attrs"]["url"]
        alt = self.render_children(token, state)
        return (
            f"<!-- wp:image -->\n"
            f'<figure class="wp-block-image"><img src="{src}" alt="{alt}"/></figure>\n'
            f"<!-- /wp:image -->\n\n"
        )

    def block_code(self, token: dict, state: object) -> str:
        code = token["raw"]
        lang = token.get("attrs", {}).get("info", "")
        lang_attr = f' {{"language":"{lang}"}}' if lang else ""
        return (
            f"<!-- wp:code{lang_attr} -->\n"
            f'<pre class="wp-block-code"><code>{code}</code></pre>\n'
            f"<!-- /wp:code -->\n\n"
        )

    def list(self, token: dict, state: object) -> str:
        body = self.render_children(token, state)
        ordered = token["attrs"].get("ordered", False)
        if ordered:
            return (
                f'<!-- wp:list {{"ordered":true}} -->\n'
                f"<ol>{body}</ol>\n"
                f"<!-- /wp:list -->\n\n"
            )
        return f"<!-- wp:list -->\n<ul>{body}</ul>\n<!-- /wp:list -->\n\n"

    def list_item(self, token: dict, state: object) -> str:
        text = self.render_children(token, state)
        return f"<li>{text}</li>\n"

    def block_quote(self, token: dict, state: object) -> str:
        text = self.render_children(token, state)
        return (
            f"<!-- wp:quote -->\n"
            f'<blockquote class="wp-block-quote">{text}</blockquote>\n'
            f"<!-- /wp:quote -->\n\n"
        )

    def thematic_break(self, token: dict, state: object) -> str:
        return (
            "<!-- wp:separator -->\n"
            '<hr class="wp-block-separator"/>\n'
            "<!-- /wp:separator -->\n\n"
        )

    def block_text(self, token: dict, state: object) -> str:
        return self.render_children(token, state)

    def blank_line(self, token: dict, state: object) -> str:
        return ""

    def block_html(self, token: dict, state: object) -> str:
        return f"<!-- wp:html -->\n{token['raw']}\n<!-- /wp:html -->\n\n"

    def finalize(self, data: object, state: object) -> str:
        return "".join(data)
