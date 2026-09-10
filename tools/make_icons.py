"""生成插件图标（纯标准库，无需 Pillow）。
图标：靛蓝圆角方块 + 白色波形条。
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")

BG_TOP = (0x63, 0x66, 0xF1)      # #6366f1
BG_BOTTOM = (0x8B, 0x5C, 0xF6)   # #8b5cf6
FG = (0xFF, 0xFF, 0xFF)

# 波形条：（中心位置比例, 半宽比例, 半高比例）
BARS = [
    (0.26, 0.045, 0.13),
    (0.40, 0.045, 0.30),
    (0.54, 0.045, 0.42),
    (0.68, 0.045, 0.26),
    (0.82, 0.045, 0.11),
]


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_alpha(x, y, size, radius):
    """返回 0..255 的圆角遮罩 alpha"""
    r = radius
    cx = min(max(x + 0.5, r), size - r)
    cy = min(max(y + 0.5, r), size - r)
    dx = x + 0.5 - cx
    dy = y + 0.5 - cy
    d = (dx * dx + dy * dy) ** 0.5
    if d <= r:
        return 255
    # 外部像素直接裁掉
    if x + 0.5 < r or y + 0.5 < r or x + 0.5 > size - r or y + 0.5 > size - r:
        if x + 0.5 < 0 or y + 0.5 < 0 or x + 0.5 > size or y + 0.5 > size:
            return 0
    return int(max(0, min(255, 255 * (1 - (d - r) / 1.5))))


def render(size):
    radius = size * 0.22
    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # filter type 0
        for x in range(size):
            base = lerp(BG_TOP, BG_BOTTOM, (x + y) / (2 * size - 2))
            color = base
            # 波形条
            fx = (x + 0.5) / size
            fy = (y + 0.5) / size
            for bx, bw, bh in BARS:
                if abs(fx - bx) <= bw and abs(fy - 0.5) <= bh:
                    color = FG
                    break
            a = rounded_alpha(x, y, size, radius)
            row += bytes((color[0], color[1], color[2], a))
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size):
    raw = render(size)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, len(png), "bytes")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in (16, 48, 128):
        write_png(os.path.join(OUT_DIR, f"icon{s}.png"), s)
