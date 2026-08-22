"""Export a parity corpus for `optimize_image`.

`optimize_image` is the only part of the images stage whose oracle cannot come
from the golden fixtures: every Gemini call recorded there returned a 429, so no
real generated image was ever optimized. This script builds deterministic PNG
inputs instead, runs Pillow's implementation over them, and writes both the
inputs and Pillow's WebP output so the TypeScript port is compared against real
encoder output rather than against a description of it.

The generated inputs are posterized to 3 bits per channel. That is purely to
keep the committed corpus small (an un-posterized bicubic gradient costs about
1 MB per case as PNG); it does not weaken the oracle, since banding adds edges
for the resampling kernel to disagree about rather than removing them.

Run from `api/`:  uv run python scripts/export_optimize_parity.py
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.pipeline.stages.images import optimize_image  # noqa: E402

OUT_DIR = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "mastra"
    / "images"
    / "data"
    / "optimize-parity"
)
POSTERIZE_BITS = 3


def smooth(width: int, height: int, seed: int) -> Image.Image:
    """Low-frequency RGB content: a small random base blown up bicubically."""
    rng = random.Random(seed)
    base = Image.new("RGB", (12, 8))
    base.putdata(
        [
            (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for _ in range(12 * 8)
        ]
    )
    scaled = base.resize((width, height), Image.BICUBIC)
    return ImageOps.posterize(scaled, POSTERIZE_BITS)


def detailed(width: int, height: int, seed: int) -> Image.Image:
    """High-frequency content: smooth base plus hard edges the encoder must keep."""
    img = smooth(width, height, seed)
    draw = ImageDraw.Draw(img)
    rng = random.Random(seed + 1)
    step = max(8, width // 40)
    for x in range(0, width, step):
        draw.line([(x, 0), (x + height // 3, height)], fill=(255, 255, 255), width=1)
    for _ in range(60):
        x0 = rng.randrange(width)
        y0 = rng.randrange(height)
        r = rng.randrange(4, max(5, width // 30))
        draw.ellipse(
            [x0, y0, x0 + r, y0 + r],
            outline=(0, 0, 0),
            fill=(rng.randrange(256), rng.randrange(256), rng.randrange(256)),
        )
    return img


def with_alpha(width: int, height: int, seed: int) -> Image.Image:
    img = detailed(width, height, seed).convert("RGBA")
    img.putalpha(Image.linear_gradient("L").resize((width, height), Image.BILINEAR))
    return img


CASES = [
    {
        "input": "smooth-2400x1350",
        "image": lambda: smooth(2400, 1350, 1),
        "max_width": 1200,
        "why": "the ordinary non-featured path: 16:9 input wider than max_width",
    },
    {
        "input": "smooth-2400x1350",
        "image": lambda: smooth(2400, 1350, 1),
        "max_width": 1920,
        "why": "the featured path passes max_width=1920 for the same input",
    },
    {
        "input": "odd-1600x901",
        "image": lambda: smooth(1600, 901, 2),
        "max_width": 1200,
        "why": "int(height * ratio) truncates 675.75 to 675; rounding would give 676",
    },
    {
        "input": "odd-1001x1000",
        "image": lambda: smooth(1001, 1000, 3),
        "max_width": 1000,
        "why": "one pixel over max_width resizes, and the height truncates to 999",
    },
    {
        "input": "exact-1200x800",
        "image": lambda: smooth(1200, 800, 4),
        "max_width": 1200,
        "why": "width == max_width is not > max_width, so no resize happens",
    },
    {
        "input": "small-800x600",
        "image": lambda: smooth(800, 600, 5),
        "max_width": 1200,
        "why": "narrower than max_width is never upscaled",
    },
    {
        "input": "tiny-3x2",
        "image": lambda: smooth(3, 2, 6),
        "max_width": 1200,
        "why": "degenerate size: the encoder still has to produce a valid WebP",
    },
    {
        "input": "wide-3000x400",
        "image": lambda: smooth(3000, 400, 7),
        "max_width": 1200,
        "why": "a 2.5x reduction on a banner shape; the height truncates to 160",
    },
    {
        "input": "tall-1500x2400",
        "image": lambda: smooth(1500, 2400, 8),
        "max_width": 1200,
        "why": "portrait input, so the resized height stays larger than the width",
    },
    {
        "input": "detailed-1600x900",
        "image": lambda: detailed(1600, 900, 9),
        "max_width": 1200,
        "why": "high-frequency edges, where resampling kernels disagree most",
    },
    {
        "input": "detailed-1200x675",
        "image": lambda: detailed(1200, 675, 10),
        "max_width": 1200,
        "why": "high-frequency content encoded at quality 82 with no resize in between",
    },
    {
        "input": "alpha-1600x900",
        "image": lambda: with_alpha(1600, 900, 11),
        "max_width": 1200,
        "why": "RGBA input: Pillow resizes straight alpha, libvips premultiplies",
    },
    {
        "input": "grayscale-1600x900",
        "image": lambda: detailed(1600, 900, 12).convert("L"),
        "max_width": 1200,
        "why": "mode L is not a valid WebP mode, so Pillow converts it to RGB first",
    },
    {
        "input": "palette-1600x900",
        "image": lambda: detailed(1600, 900, 13).convert(
            "P", palette=Image.ADAPTIVE, colors=64
        ),
        "max_width": 1200,
        "why": "mode P is not a valid WebP mode either, and resizing a palette differs",
    },
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index = []
    written: dict[str, Image.Image] = {}
    for case in CASES:
        png_path = OUT_DIR / f"{case['input']}.png"
        if case["input"] not in written:
            img = case["image"]()
            img.save(png_path, format="PNG", optimize=True)
            written[case["input"]] = img
        img = written[case["input"]]
        png_bytes = png_path.read_bytes()

        name = f"{case['input']}-w{case['max_width']}"
        out_bytes, ext = optimize_image(png_bytes, max_width=case["max_width"])
        webp_path = OUT_DIR / f"{name}.expected.webp"
        webp_path.write_bytes(out_bytes)

        decoded = Image.open(webp_path)
        index.append(
            {
                "name": name,
                "why": case["why"],
                "max_width": case["max_width"],
                "input": png_path.name,
                "input_mode": img.mode,
                "input_width": img.width,
                "input_height": img.height,
                "input_bytes": len(png_bytes),
                "expected": webp_path.name,
                "expected_ext": ext,
                "expected_width": decoded.width,
                "expected_height": decoded.height,
                "expected_bytes": len(out_bytes),
            }
        )
        print(
            f"{name}: {img.mode} {img.width}x{img.height} "
            f"({len(png_bytes)}B png) -> {decoded.width}x{decoded.height} "
            f"({len(out_bytes)}B webp)"
        )

    (OUT_DIR / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"\n{len(index)} cases -> {OUT_DIR}")


if __name__ == "__main__":
    main()
