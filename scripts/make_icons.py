"""生成 PWA 图标：圆角深青底 + 白色 ¥。

用法：python scripts/make_icons.py
输出到 public/：icon-512.png、icon-192.png、apple-touch-icon.png、icon.svg
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public"
OUT.mkdir(exist_ok=True)

BRAND = (15, 118, 110, 255)      # #0f766e
BRAND_DARK = (11, 94, 88, 255)   # 轻微渐变的下缘
WHITE = (255, 255, 255, 255)
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\arialbd.ttf",
]

SUPERSAMPLE = 4


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def make_icon(size: int, rounded: bool = True) -> Image.Image:
    big = size * SUPERSAMPLE
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # 竖向渐变底
    gradient = Image.new("RGB", (1, big))
    for y in range(big):
        t = y / max(1, big - 1)
        color = tuple(round(BRAND[i] * (1 - t) + BRAND_DARK[i] * t) for i in range(3))
        gradient.putpixel((0, y), color)
    gradient = gradient.resize((big, big))
    canvas.paste(gradient, (0, 0))

    # 内圈微亮，让图标不那么闷
    sheen = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse(
        (-big * 0.35, -big * 0.55, big * 0.95, big * 0.45),
        fill=(255, 255, 255, 16),
    )
    canvas = Image.alpha_composite(canvas, sheen)

    # ¥ 字形，占画面约 52%，四周留足 maskable 安全区
    font = load_font(round(big * 0.54))
    draw = ImageDraw.Draw(canvas)
    box = draw.textbbox((0, 0), "¥", font=font)
    text_w = box[2] - box[0]
    text_h = box[3] - box[1]
    draw.text(
        ((big - text_w) / 2 - box[0], (big - text_h) / 2 - box[1] + big * 0.015),
        "¥",
        font=font,
        fill=WHITE,
    )

    if rounded:
        canvas.putalpha(rounded_mask(big, radius=round(big * 0.22)))
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    outputs = [
        (512, "icon-512.png", True),
        (192, "icon-192.png", True),
        # maskable 与 iOS 图标都会被系统再切一次，必须满幅不留透明角
        (512, "icon-maskable-512.png", False),
        (180, "apple-touch-icon.png", False),
    ]
    for size, name, rounded in outputs:
        icon = make_icon(size, rounded=rounded)
        icon.save(OUT / name, optimize=True)
        print(f"wrote {OUT / name}")

    (OUT / "icon.svg").write_text(
        """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="额度">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f766e"/>
      <stop offset="1" stop-color="#0b5e58"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <text x="256" y="256" text-anchor="middle" dominant-baseline="central"
        font-family="PingFang SC, Microsoft YaHei, Arial, sans-serif"
        font-weight="700" font-size="276" fill="#fff">¥</text>
</svg>
""",
        encoding="utf-8",
    )
    print(f"wrote {OUT / 'icon.svg'}")


if __name__ == "__main__":
    main()
