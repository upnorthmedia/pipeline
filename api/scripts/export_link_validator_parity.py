"""Export the parity oracle the TypeScript `validate_links` port needs.

`api/src/services/link_validator.py` is the only service in the pipeline that
reaches the network, so its parity oracle cannot be a pure table of inputs and
outputs the way `analytics-parity.json` is. This script therefore does two
different things:

1. **Network cases.** It stands up a local HTTP server whose routes return the
   exact status codes `validate_links` cares about (404/410/451 strip, anything
   else keeps), plus redirects, a connection refusal and a route that never
   answers, then runs the real `validate_links` against it and records what
   came back. Every URL in the recorded content is templated back to `{BASE}`
   so the TypeScript test can stand up an equivalent server on its own port and
   compare. It also records the highest number of simultaneous in-flight
   requests the server saw, which pins `_SEMAPHORE_LIMIT`.

2. **Extraction cases.** `_MD_LINK_RE.findall` and the strip substitution are
   pure, so they are exported as plain input/output tables over both the
   synthetic edge cases and the real golden-fixture content. These are the
   cases that discriminate between Python's `re.escape` and JavaScript's
   regex escaping, and between `re.findall`'s tuple order and `matchAll`'s.

Usage:
    uv run python scripts/export_link_validator_parity.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import threading
import time
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.services.link_validator import (  # noqa: E402
    _MD_LINK_RE,
    validate_links,
)

OUT = (
    REPO_ROOT
    / "web"
    / "src"
    / "mastra"
    / "links"
    / "data"
    / "link-validator-parity.json"
)
GOLDEN = REPO_ROOT / "docs" / "mastra-port" / "golden"

# Routes the local server answers. `/hang` sleeps past `_REQUEST_TIMEOUT`;
# `/slow` sleeps just long enough that the semaphore limit is observable.
HANG_SECONDS = 12.0
SLOW_SECONDS = 0.3

# A port nothing listens on, so the request is refused rather than answered.
CLOSED_PORT = 9

_concurrency_lock = threading.Lock()
_in_flight = 0
_max_in_flight = 0


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:  # keep the export output clean
        return

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        path = urlparse(self.path).path
        if path == "/hang":
            # Deliberately not counted: the client gives up at `_REQUEST_TIMEOUT`
            # but this thread sleeps on past it, so counting it would still be
            # holding a slot open during whichever case runs next.
            time.sleep(HANG_SECONDS)
        elif path == "/slow":
            # The in-flight counter is released before the response is written,
            # so it never counts a request the client has already been answered
            # for. Counting across the write reports one too many, because the
            # next request can start while the handler thread for the previous
            # one has not returned yet.
            self._enter()
            try:
                time.sleep(SLOW_SECONDS)
            finally:
                self._exit()
        self._route(path)

    do_GET = do_HEAD  # noqa: N815 - mirrors BaseHTTPRequestHandler's attribute

    def _enter(self) -> None:
        global _in_flight, _max_in_flight
        with _concurrency_lock:
            _in_flight += 1
            _max_in_flight = max(_max_in_flight, _in_flight)

    def _exit(self) -> None:
        global _in_flight
        with _concurrency_lock:
            _in_flight -= 1

    def _route(self, path: str) -> None:
        if path in ("/hang", "/slow"):
            self._respond(200)
        elif path == "/moved":
            self._respond(301, location="/gone")
        elif path == "/found":
            self._respond(302, location="/ok")
        elif path == "/ok":
            self._respond(200)
        elif path == "/notfound":
            self._respond(404)
        elif path == "/gone":
            self._respond(410)
        elif path == "/unavailable":
            self._respond(451)
        elif path == "/error":
            self._respond(500)
        elif path == "/teapot":
            self._respond(418)
        else:
            self._respond(404)

    def _respond(self, status: int, location: str | None = None) -> None:
        self.send_response(status)
        if location is not None:
            self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()


def _network_cases(base: str) -> list[dict]:
    """Content cases run against the live local server, templated on `{BASE}`."""
    closed = f"http://127.0.0.1:{CLOSED_PORT}"
    templates: list[tuple[str, str]] = [
        ("no-links", "Plain text with no links at all."),
        ("relative-and-anchor", "See [page](/about) and [jump](#overview) here."),
        ("uppercase-scheme", "A [link]({BASE_UPPER}/notfound) with an upper scheme."),
        ("alive-200", "Check [Example]({BASE}/ok) here."),
        ("dead-404", "Click [Dead Link]({BASE}/notfound) now."),
        ("dead-410", "See [Gone]({BASE}/gone) for details."),
        ("dead-451", "Blocked [Legal]({BASE}/unavailable) notice."),
        ("kept-500", "A [Server Error]({BASE}/error) stays put."),
        ("kept-418", "A [Teapot]({BASE}/teapot) stays put."),
        ("redirect-to-dead", "Follow [Moved]({BASE}/moved) to a 410."),
        ("redirect-to-alive", "Follow [Found]({BASE}/found) to a 200."),
        ("connection-refused", f"Try [Down]({closed}/nope) later."),
        (
            "mixed",
            "Visit [Good]({BASE}/ok) and [Dead1]({BASE}/notfound) and "
            "[Dead2]({BASE}/gone) links.",
        ),
        (
            "duplicate-url",
            "First [one]({BASE}/notfound), then [two]({BASE}/notfound), "
            "then [three]({BASE}/ok).",
        ),
        (
            "duplicate-url-same-text",
            "Read [more]({BASE}/notfound) and [more]({BASE}/notfound) too.",
        ),
        (
            "two-dead-out-of-order",
            "[zeta]({BASE}/notfound) before [alpha]({BASE}/gone).",
        ),
        (
            "empty-link-text",
            "An [](({BASE}/ok)) and an []({BASE}/notfound) here.",
        ),
        (
            "regex-special-url",
            "A [Plus]({BASE}/notfound?a=1+2&b=c.d*e) link.",
        ),
        (
            "bare-url-alongside",
            "See [Dead]({BASE}/notfound) and the bare {BASE}/notfound too.",
        ),
        (
            "same-url-in-html",
            'Markdown [Dead]({BASE}/notfound) and <a href="{BASE}/notfound">html</a>.',
        ),
        ("timeout", "Visit [Slow]({BASE}/hang) site."),
        (
            "semaphore-probe",
            " ".join(f"[n{i}]({{BASE}}/slow?i={i})" for i in range(12)),
        ),
    ]
    return [
        {
            "name": name,
            "template": template,
            "content": template.replace("{BASE}", base).replace(
                "{BASE_UPPER}", base.upper()
            ),
        }
        for name, template in templates
    ]


EXTRACTION_TEXTS: list[tuple[str, str]] = [
    ("empty", ""),
    ("plain", "No links here."),
    ("simple", "A [text](https://example.com/a) link."),
    ("empty-text", "An []( https://example.com/b ) link."),
    ("no-url", "An [text]() link."),
    ("nested-brackets", "A [[nested]](https://example.com/c) link."),
    ("paren-in-url", "A [text](https://example.com/(d)) link."),
    ("bracket-in-text", "A [te]xt](https://example.com/e) link."),
    ("adjacent", "[a](https://example.com/1)[b](https://example.com/2)"),
    ("multiline", "A [text](https://example.com/f)\nand [more](/relative)\n"),
    ("image", "An ![alt](https://cdn.example.com/g.png) image."),
    ("newline-in-url", "A [text](https://example.com/\nh) link."),
    ("space-in-text", "A [ spaced text ](https://example.com/i) link."),
    ("unicode", "A [café ünicode](https://example.com/café) here."),
]

STRIP_CASES: list[tuple[str, str, list[str]]] = [
    (
        "single",
        "Click [Dead Link](https://dead.com/page) now.",
        ["https://dead.com/page"],
    ),
    (
        "repeated",
        "[a](https://d.com/x) then [b](https://d.com/x) then [c](https://d.com/y)",
        ["https://d.com/x"],
    ),
    (
        "regex-special",
        "A [Plus](https://d.com/a+b?c=1&e=f.g*h) link.",
        ["https://d.com/a+b?c=1&e=f.g*h"],
    ),
    (
        "prefix-not-matched",
        "[a](https://d.com/x) and [b](https://d.com/xy)",
        ["https://d.com/x"],
    ),
    (
        "empty-text",
        "An []( https://d.com/z ) and [](https://d.com/z) here.",
        ["https://d.com/z"],
    ),
    (
        "dollar-in-text",
        "A [$1 and $& and $`](https://d.com/q) link.",
        ["https://d.com/q"],
    ),
    (
        "backslash-in-text",
        "A [back\\1slash](https://d.com/r) link.",
        ["https://d.com/r"],
    ),
    (
        "two-urls",
        "[a](https://d.com/1) [b](https://d.com/2) [c](https://d.com/3)",
        ["https://d.com/1", "https://d.com/3"],
    ),
    (
        "not-dead",
        "[a](https://d.com/1) stays.",
        [],
    ),
]


def _strip(content: str, dead_urls: list[str]) -> str:
    """The substitution loop from `validate_links`, over an ordered list."""
    cleaned = content
    for url in dead_urls:
        cleaned = re.sub(
            r"\[([^\]]*)\]\(" + re.escape(url) + r"\)",
            r"\1",
            cleaned,
        )
    return cleaned


def _golden_extraction_cases() -> list[dict]:
    """`_MD_LINK_RE.findall` over the real captured stage content."""
    out: list[dict] = []
    for slug in sorted(p.name for p in GOLDEN.iterdir() if p.is_dir()):
        for stage, key in (
            ("research", "research"),
            ("write", "draft"),
            ("edit", "final_md"),
            ("ready", "ready"),
        ):
            path = GOLDEN / slug / f"{stage}.json"
            if not path.exists():
                continue
            payload = json.loads(path.read_text())
            content = payload.get("stage_output", {}).get(key)
            if not isinstance(content, str) or not content:
                continue
            # The text itself is not copied in: the test reads it back out of
            # the golden fixture, so the oracle is over content this repo did
            # not produce for the test's benefit.
            out.append(
                {
                    "name": f"golden:{slug}:{stage}",
                    "golden": {"slug": slug, "stage": stage, "key": key},
                    "matches": [
                        {"text": t, "url": u} for t, u in _MD_LINK_RE.findall(content)
                    ],
                }
            )
    return out


async def _run_network_cases(base: str) -> list[dict]:
    global _max_in_flight
    results: list[dict] = []
    for case in _network_cases(base):
        with _concurrency_lock:
            _max_in_flight = 0
        started = time.monotonic()
        result = await validate_links(case["content"])
        elapsed = time.monotonic() - started
        with _concurrency_lock:
            observed = _max_in_flight
        results.append(
            {
                "name": case["name"],
                "template": case["template"],
                "expected_template": result.content.replace(base, "{BASE}").replace(
                    base.upper(), "{BASE_UPPER}"
                ),
                "expected_removed": [
                    {
                        **asdict(removed),
                        "url": removed.url.replace(base, "{BASE}"),
                    }
                    for removed in result.removed
                ],
                "max_in_flight": observed,
                "elapsed_s": round(elapsed, 1),
            }
        )
        print(
            f"  {case['name']}: removed={len(result.removed)} "
            f"max_in_flight={observed} {elapsed:.1f}s"
        )
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    base = f"http://127.0.0.1:{port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"local server on {base}")
    try:
        network_cases = asyncio.run(_run_network_cases(base))
    finally:
        server.shutdown()
        server.server_close()

    extraction_cases = [
        {
            "name": name,
            "text": text,
            "matches": [{"text": t, "url": u} for t, u in _MD_LINK_RE.findall(text)],
        }
        for name, text in EXTRACTION_TEXTS
    ] + _golden_extraction_cases()

    strip_cases = [
        {
            "name": name,
            "content": content,
            "dead_urls": dead,
            "expected": _strip(content, dead),
        }
        for name, content, dead in STRIP_CASES
    ]

    payload = {
        "generated_by": "api/scripts/export_link_validator_parity.py",
        "source": "api/src/services/link_validator.py",
        "python_version": sys.version.split()[0],
        "hang_seconds": HANG_SECONDS,
        "slow_seconds": SLOW_SECONDS,
        "closed_port": CLOSED_PORT,
        "network_cases": network_cases,
        "extraction_cases": extraction_cases,
        "strip_cases": strip_cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(
        f"wrote {args.out.relative_to(REPO_ROOT)}: {len(network_cases)} network cases, "
        f"{len(extraction_cases)} extraction cases, {len(strip_cases)} strip cases"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
