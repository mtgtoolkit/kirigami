"""Generate the Kirigami desktop app icon.

Outputs (next to package.json):
  build/icon.png  512 x 512 RGBA (used by electron-builder and the docs)
  build/icon.ico  multi-size Windows icon: 16, 20, 24, 32, 40, 48, 64, 128, 256

Design: a rounded-square plate with the app's accent gradient (#7c6cff -> #2dd4bf), two fanned playing
cards, a dashed cut line on the front card (print & cut) and a gradient sparkle. Large sizes are drawn
at 4x and downsampled for smooth edges; 16-32 px use a simplified drawing so they stay crisp.

Run with the repository's virtual environment (Pillow and numpy are engine requirements):
  ..\\venv\\Scripts\\python.exe scripts/make-icon.py        (Windows, from electron-app/)
  ../venv/bin/python scripts/make-icon.py                  (macOS / Linux)
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
except ImportError as exc:  # pragma: no cover - environment problem
    sys.exit(f"make-icon: {exc}. Run it with the repository venv (pip install -r requirements.txt).")

APP_DIR = Path(__file__).resolve().parent.parent
BUILD_DIR = APP_DIR / "build"

ACCENT_A = (0x7C, 0x6C, 0xFF)  # violet (top-left)
ACCENT_B = (0x2D, 0xD4, 0xBF)  # teal (bottom-right)
INK = (0x4B, 0x3F, 0xD8)       # deeper violet for the cut line
CARD_RATIO = 63 / 88           # standard card width / height

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def tier_for(size: int) -> str:
    """Level of detail: 'small' (no cut line), 'medium' (bold cut line), 'large' (full detail)."""
    if size <= 32:
        return "small"
    if size <= 64:
        return "medium"
    return "large"


def diagonal_gradient(size: int, a=ACCENT_A, b=ACCENT_B, alpha: int = 255) -> Image.Image:
    """Square RGBA image with a top-left -> bottom-right linear gradient."""
    coords = np.linspace(0.0, 1.0, size, dtype=np.float32)
    t = (coords[None, :] + coords[:, None]) / 2.0
    t = t * t * (3 - 2 * t)  # smoothstep: softer ends
    rgb = np.empty((size, size, 4), dtype=np.uint8)
    for i in range(3):
        rgb[..., i] = np.clip(a[i] + (b[i] - a[i]) * t, 0, 255).astype(np.uint8)
    rgb[..., 3] = alpha
    return Image.fromarray(rgb, "RGBA")


def rounded_mask(size: tuple[int, int], radius: float) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def rounded_rect_path(x0: float, y0: float, x1: float, y1: float, r: float, step: float) -> list[tuple[float, float]]:
    """Dense clockwise polyline along a rounded rectangle (for dashing)."""
    pts: list[tuple[float, float]] = []

    def line(ax, ay, bx, by):
        n = max(1, int(math.hypot(bx - ax, by - ay) / step))
        for i in range(n):
            pts.append((ax + (bx - ax) * i / n, ay + (by - ay) * i / n))

    def arc(cx, cy, start_deg):
        n = max(4, int((math.pi * r / 2) / step))
        for i in range(n):
            a = math.radians(start_deg + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))

    line(x0 + r, y0, x1 - r, y0)
    arc(x1 - r, y0 + r, -90)
    line(x1, y0 + r, x1, y1 - r)
    arc(x1 - r, y1 - r, 0)
    line(x1 - r, y1, x0 + r, y1)
    arc(x0 + r, y1 - r, 90)
    line(x0, y1 - r, x0, y0 + r)
    arc(x0 + r, y0 + r, 180)
    pts.append(pts[0])
    return pts


def draw_dashed(draw: ImageDraw.ImageDraw, pts, dash: float, gap: float, width: int, fill) -> None:
    """Draw a dashed polyline with round caps; dash and gap lengths are adjusted to close evenly."""
    seglens = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1)]
    total = sum(seglens)
    period = dash + gap
    count = max(1, round(total / period))
    scale = total / (count * period)
    dash, gap = dash * scale, gap * scale

    def point_at(dist):
        acc = 0.0
        for i, length in enumerate(seglens):
            if acc + length >= dist:
                f = (dist - acc) / length if length else 0.0
                return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f)
            acc += length
        return pts[-1]

    radius = width / 2
    for k in range(count):
        start = k * (dash + gap) + gap / 2
        samples = [point_at(start + dash * j / 12) for j in range(13)]
        draw.line(samples, fill=fill, width=width, joint="curve")
        for (x, y) in (samples[0], samples[-1]):
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def sparkle_polygon(cx: float, cy: float, r: float, power: float = 2.6, points: int = 240) -> list[tuple[float, float]]:
    """Four-pointed star with concave sides (a superellipse with exponent > 1)."""
    out = []
    for i in range(points):
        t = 2 * math.pi * i / points
        c, s = math.cos(t), math.sin(t)
        out.append((cx + r * math.copysign(abs(c) ** power, c), cy + r * math.copysign(abs(s) ** power, s)))
    return out


def card_layer(w: int, h: int, radius: float, fill, *, cut_line: dict | None = None, sparkle: dict | None = None) -> Image.Image:
    """An unrotated card with optional dashed cut line and gradient sparkle, padded for rotation."""
    pad = int(max(w, h) * 0.12)
    layer = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle((pad, pad, pad + w, pad + h), radius=radius, fill=fill)
    if cut_line:
        inset = cut_line["inset"]
        pts = rounded_rect_path(pad + inset, pad + inset, pad + w - inset, pad + h - inset,
                                max(1.0, radius - inset * 0.6), step=1.5)
        draw_dashed(draw, pts, cut_line["dash"], cut_line["gap"], cut_line["width"], cut_line["color"])
    if sparkle:
        r = sparkle["radius"]
        cx, cy = pad + w / 2, pad + h / 2
        mask = Image.new("L", layer.size, 0)
        ImageDraw.Draw(mask).polygon(sparkle_polygon(cx, cy, r, sparkle.get("power", 2.6)), fill=255)
        small = sparkle.get("small_radius")
        if small:
            sx, sy = cx + r * 0.78, cy - r * 0.78
            ImageDraw.Draw(mask).polygon(sparkle_polygon(sx, sy, small, sparkle.get("power", 2.6)), fill=255)
        # Gradient spanning the sparkle(s) only, so the full violet -> teal range shows.
        x0, y0, x1, y1 = mask.getbbox()
        side = max(x1 - x0, y1 - y0)
        grad = diagonal_gradient(side).crop((0, 0, x1 - x0, y1 - y0))
        layer.paste(grad, (x0, y0), mask.crop((x0, y0, x1, y1)))
    return layer


def paste_rotated(base: Image.Image, layer: Image.Image, angle: float, center: tuple[float, float],
                  shadow: dict | None = None) -> None:
    rotated = layer.rotate(angle, resample=Image.BICUBIC, expand=True)
    x = int(round(center[0] - rotated.width / 2))
    y = int(round(center[1] - rotated.height / 2))
    if shadow:
        alpha = rotated.getchannel("A").point(lambda v: int(v * shadow["opacity"]))
        shade = Image.new("RGBA", rotated.size, shadow["color"] + (0,))
        shade.putalpha(alpha)
        shade = shade.filter(ImageFilter.GaussianBlur(shadow["blur"]))
        base.alpha_composite(shade, (x + shadow["dx"], y + shadow["dy"]))
    base.alpha_composite(rotated, (x, y))


def draw_icon(size: int, tier: str) -> Image.Image:
    """Render the icon at `size` px (call with a supersampled size and downsample afterwards)."""
    s = size / 1024.0
    small = tier == "small"
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Plate: rounded square with the accent gradient and a soft top highlight.
    margin = (36 if small else 56) * s
    plate_size = int(round(size - 2 * margin))
    plate = diagonal_gradient(plate_size)
    highlight = Image.new("L", (plate_size, plate_size), 0)
    ImageDraw.Draw(highlight).ellipse((-0.3 * plate_size, -0.95 * plate_size, 1.3 * plate_size, 0.42 * plate_size), fill=34)
    highlight = highlight.filter(ImageFilter.GaussianBlur(plate_size * 0.04))
    plate = Image.alpha_composite(plate, Image.merge("RGBA", [Image.new("L", plate.size, 255)] * 3 + [highlight]))
    plate.putalpha(rounded_mask(plate.size, radius=plate_size * (0.20 if small else 0.225)))
    img.alpha_composite(plate, (int(round(margin)), int(round(margin))))

    # Cards (standard 63 x 88 proportions).
    card_h = (640 if small else 580 if tier == "medium" else 560) * s
    card_w = card_h * CARD_RATIO
    radius = card_w * 0.085

    back = card_layer(int(card_w), int(card_h), radius, (255, 255, 255, 125))
    paste_rotated(img, back, angle=15, center=((420 if small else 430) * s, 520 * s))

    front_kwargs = {}
    if small:
        front_kwargs["sparkle"] = {"radius": card_w * 0.30, "power": 2.2}
    elif tier == "medium":
        front_kwargs["cut_line"] = {"inset": card_w * 0.10, "dash": card_w * 0.17, "gap": card_w * 0.10,
                                    "width": max(1, int(card_w * 0.05)), "color": INK + (235,)}
        front_kwargs["sparkle"] = {"radius": card_w * 0.25, "power": 2.4}
    else:
        front_kwargs["cut_line"] = {"inset": card_w * 0.085, "dash": card_w * 0.10, "gap": card_w * 0.062,
                                    "width": max(1, int(card_w * 0.028)), "color": INK + (235,)}
        front_kwargs["sparkle"] = {"radius": card_w * 0.25, "power": 2.6, "small_radius": card_w * 0.075}
    front = card_layer(int(card_w), int(card_h), radius, (255, 255, 255, 255), **front_kwargs)
    shadow = {"color": (22, 16, 60), "opacity": 0.38, "blur": max(1, 22 * s), "dx": int(round(10 * s)), "dy": int(round(22 * s))}
    paste_rotated(img, front, angle=-8, center=((575 if small else 565) * s, 505 * s), shadow=shadow)
    return img


def render(size: int, supersample: int = 4) -> Image.Image:
    big = draw_icon(size * supersample, tier_for(size))
    return big.resize((size, size), Image.LANCZOS)


def main() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    png = render(512)
    png.save(BUILD_DIR / "icon.png", optimize=True)

    frames = {size: render(size) for size in ICO_SIZES}
    largest = frames[max(ICO_SIZES)]
    others = [frames[size] for size in ICO_SIZES if size != max(ICO_SIZES)]
    largest.save(BUILD_DIR / "icon.ico", format="ICO", sizes=[(n, n) for n in ICO_SIZES], append_images=others)

    with Image.open(BUILD_DIR / "icon.ico") as ico:
        got = sorted(ico.info.get("sizes", set()))
    missing = [n for n in ICO_SIZES if (n, n) not in got]
    if missing:
        sys.exit(f"make-icon: icon.ico is missing sizes {missing}")
    print(f"make-icon: wrote {BUILD_DIR / 'icon.png'} (512x512) and {BUILD_DIR / 'icon.ico'} ({', '.join(str(n) for n in ICO_SIZES)} px)")


if __name__ == "__main__":
    main()
