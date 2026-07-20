"""Generate refined app / installer icon (dark squircle + optically centered Binance logo)."""
from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "build"
OUT.mkdir(parents=True, exist_ok=True)

BG = (24, 26, 32, 255)  # #181A20
YELLOW = (240, 185, 11, 255)  # #F0B90B
EDGE = (48, 52, 62, 255)  # #30343E

# Logo polygons from public/index.html SVG (viewBox ~0..126)
POLYS = [
    [
        (38.171, 53.203),
        (63.171, 28.203),
        (88.171, 53.203),
        (100.071, 41.303),
        (63.171, 4.403),
        (26.271, 41.303),
    ],
    [(4.403, 63.171), (16.303, 51.271), (28.203, 63.171), (16.303, 75.071)],
    [
        (38.171, 73.139),
        (63.171, 98.139),
        (88.171, 73.139),
        (100.071, 85.039),
        (63.171, 121.939),
        (26.271, 85.039),
    ],
    [(98.139, 63.171), (86.239, 75.071), (74.339, 63.171), (86.239, 51.271)],
    [(71.301, 63.171), (63.171, 71.301), (55.041, 63.171), (63.171, 55.041)],
]


def logo_bbox() -> tuple[float, float, float, float]:
    xs = [x for poly in POLYS for x, _ in poly]
    ys = [y for poly in POLYS for _, y in poly]
    return min(xs), min(ys), max(xs), max(ys)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def render(size: int = 1024) -> Image.Image:
    radius = int(size * 0.22)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=BG)

    inset = max(1, size // 256)
    draw.rounded_rectangle(
        (inset, inset, size - 1 - inset, size - 1 - inset),
        radius=max(1, radius - inset),
        outline=EDGE,
        width=max(1, size // 256),
    )

    # 按 Logo 真实包围盒缩放并居中（原先按 126 viewBox 会偏左）
    min_x, min_y, max_x, max_y = logo_bbox()
    logo_w = max_x - min_x
    logo_h = max_y - min_y
    target = size * 0.58
    scale = target / max(logo_w, logo_h)
    ox = (size - logo_w * scale) / 2 - min_x * scale
    oy = (size - logo_h * scale) / 2 - min_y * scale
    for poly in POLYS:
        pts = [(ox + x * scale, oy + y * scale) for x, y in poly]
        draw.polygon(pts, fill=YELLOW)

    mask = rounded_mask(size, radius)
    img.paste(layer, (0, 0), mask)
    return img


def write_ico(path: Path, images: list[Image.Image]) -> None:
    """Write Vista+ ICO with PNG frames and correct directory sizes/offsets.

    Pillow's multi-size ICO writer has produced corrupt files here (all entries
    size=32, invalid payloads), which makes NSIS fall back to the default icon.
    """
    frames: list[tuple[int, int, bytes]] = []
    for im in images:
        rgba = im.convert("RGBA")
        buf = io.BytesIO()
        rgba.save(buf, format="PNG", optimize=True)
        data = buf.getvalue()
        w, h = rgba.size
        # ICO directory stores 0 for 256
        frames.append((0 if w >= 256 else w, 0 if h >= 256 else h, data))

    count = len(frames)
    offset = 6 + 16 * count
    parts: list[bytes] = [struct.pack("<HHH", 0, 1, count)]
    blobs: list[bytes] = []
    for w, h, data in frames:
        parts.append(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset))
        blobs.append(data)
        offset += len(data)

    path.write_bytes(b"".join(parts) + b"".join(blobs))


def verify_ico(path: Path) -> None:
    raw = path.read_bytes()
    _reserved, ico_type, count = struct.unpack_from("<HHH", raw, 0)
    if ico_type != 1 or count < 1:
        raise RuntimeError(f"invalid ICO header: type={ico_type} count={count}")
    off = 6
    for i in range(count):
        w, h, _cc, _res, _planes, _bpp, size, offset = struct.unpack_from("<BBBBHHII", raw, off)
        off += 16
        chunk = raw[offset : offset + size]
        if not chunk.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError(f"ICO entry {i} is not PNG (w={w or 256})")
        if size < 50:
            raise RuntimeError(f"ICO entry {i} too small: {size}")
    print(f"verified {path} entries={count}")


def main() -> None:
    master = render(1024)
    png_path = OUT / "icon.png"
    master.save(png_path, format="PNG")
    print(f"wrote {png_path} {master.size}")

    master.resize((256, 256), Image.Resampling.LANCZOS).save(OUT / "icon-256.png", format="PNG")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    icons: list[Image.Image] = []
    for s in sizes:
        # Supersample small sizes for sharper edges
        src = render(max(s * 4, 256)).resize((s, s), Image.Resampling.LANCZOS)
        icons.append(src)

    ico_path = OUT / "icon.ico"
    write_ico(ico_path, icons)
    verify_ico(ico_path)
    print(f"wrote {ico_path} sizes={sizes} bytes={ico_path.stat().st_size}")

    # Packaged app loads icon from electron/ (included in asar files)
    electron_dir = OUT.parent / "electron"
    for name in ("icon.ico", "icon.png"):
        src = OUT / name
        if src.exists():
            dest = electron_dir / name
            dest.write_bytes(src.read_bytes())
            print(f"copied {dest}")

    min_x, min_y, max_x, max_y = logo_bbox()
    logo_w = max_x - min_x
    logo_h = max_y - min_y
    target = 1024 * 0.58
    scale = target / max(logo_w, logo_h)
    ox = (1024 - logo_w * scale) / 2 - min_x * scale
    oy = (1024 - logo_h * scale) / 2 - min_y * scale
    svg = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="币安广场批量发帖">
  <rect width="1024" height="1024" rx="225" ry="225" fill="#181A20"/>
  <rect x="4" y="4" width="1016" height="1016" rx="221" ry="221" fill="none" stroke="#30343E" stroke-width="4"/>
  <g transform="translate({ox:.6f} {oy:.6f}) scale({scale:.10f})">
    <path fill="#F0B90B" d="M38.171 53.203L63.171 28.203L88.171 53.203L100.071 41.303L63.171 4.403L26.271 41.303L38.171 53.203Z"/>
    <path fill="#F0B90B" d="M4.403 63.171L16.303 51.271L28.203 63.171L16.303 75.071L4.403 63.171Z"/>
    <path fill="#F0B90B" d="M38.171 73.139L63.171 98.139L88.171 73.139L100.071 85.039L63.171 121.939L26.271 85.039L38.171 73.139Z"/>
    <path fill="#F0B90B" d="M98.139 63.171L86.239 75.071L74.339 63.171L86.239 51.271L98.139 63.171Z"/>
    <path fill="#F0B90B" d="M71.301 63.171L63.171 71.301L55.041 63.171L63.171 55.041L71.301 63.171Z"/>
  </g>
</svg>
"""
    (OUT / "icon.svg").write_text(svg, encoding="utf-8")
    print(f"wrote {OUT / 'icon.svg'}")


if __name__ == "__main__":
    main()
