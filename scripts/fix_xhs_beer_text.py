from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter


SRC_DIR = Path("/Users/weiming/Downloads/小红书完成版/夜生活")
FONT_HEITI = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_SONGTI = "/System/Library/Fonts/Supplemental/Songti.ttc"


def font(path, size):
    return ImageFont.truetype(path, size)


def text_bbox(draw, xy, text, fnt, **kwargs):
    return draw.textbbox(xy, text, font=fnt, **kwargs)


def draw_shadow_text(draw, xy, text, fnt, fill, stroke=0, spacing=0, anchor=None):
    x, y = xy
    # A soft dark lift that helps the type survive Xiaohongshu double-column feeds.
    for dx, dy, a in [(0, 5, 150), (0, 2, 120), (2, 3, 90)]:
        draw.multiline_text(
            (x + dx, y + dy),
            text,
            font=fnt,
            fill=(0, 0, 0, a),
            spacing=spacing,
            stroke_width=stroke,
            stroke_fill=(0, 0, 0, a),
            anchor=anchor,
        )
    draw.multiline_text(
        xy,
        text,
        font=fnt,
        fill=fill,
        spacing=spacing,
        stroke_width=stroke,
        stroke_fill=(0, 0, 0, 150),
        anchor=anchor,
    )


def add_top_readability_panel(im, height=520, alpha=205, right_fade=True):
    """Darken and slightly blur the old text region so larger type is clean."""
    w, h = im.size
    base = im.convert("RGBA")
    crop = base.crop((0, 0, w, height)).filter(ImageFilter.GaussianBlur(10))
    panel = Image.new("RGBA", (w, height), (4, 13, 20, 0))
    pix = panel.load()
    for y in range(height):
        vertical = 1 - (y / height) ** 1.8
        for x in range(w):
            horizontal = 1.0
            if right_fade:
                horizontal = max(0.28, 1 - (x / w) ** 1.7 * 0.55)
            a = int(alpha * vertical * horizontal)
            pix[x, y] = (3, 12, 18, a)
    crop = Image.alpha_composite(crop, panel)
    base.paste(crop, (0, 0))
    return base


def rounded_rect(draw, xy, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def fix_a():
    src = SRC_DIR / "啤酒1A.png"
    out = SRC_DIR / "啤酒1A-大字版.png"
    im = Image.open(src)
    im = add_top_readability_panel(im, height=545, alpha=214, right_fade=True)
    draw = ImageDraw.Draw(im)

    title_font = font(FONT_HEITI, 94)
    sub_font = font(FONT_HEITI, 44)
    small_font = font(FONT_HEITI, 31)

    x = 72
    y = 86
    white = (250, 244, 228, 255)
    yellow = (255, 204, 67, 255)
    teal = (49, 219, 205, 255)

    draw_shadow_text(draw, (x, y), "亮马河边", title_font, white, stroke=2)
    draw_shadow_text(draw, (x, y + 108), "坐进一桌", title_font, white, stroke=2)
    draw_shadow_text(draw, (x, y + 216), "啤酒局", title_font, yellow, stroke=2)

    draw.rounded_rectangle((x, y + 334, x + 96, y + 345), radius=6, fill=teal)
    draw_shadow_text(draw, (x, y + 382), "一杯下去，话题就打开了", sub_font, white, stroke=1)
    draw_shadow_text(draw, (x, y + 438), "附近热闹，打开地图就能看见", small_font, (222, 238, 236, 245), stroke=1)

    im.convert("RGB").save(out, quality=96)
    return out


def fix_b():
    src = SRC_DIR / "啤酒1B.png"
    out = SRC_DIR / "啤酒1B-大字版.png"
    im = Image.open(src)
    im = add_top_readability_panel(im, height=530, alpha=218, right_fade=False)
    draw = ImageDraw.Draw(im)

    title_font = font(FONT_HEITI, 78)
    zup_font = font(FONT_HEITI, 90)
    sub_font = font(FONT_HEITI, 42)
    badge_font = font(FONT_HEITI, 39)
    badge_bold = font(FONT_HEITI, 45)

    x = 58
    y = 78
    white = (250, 244, 228, 255)
    yellow = (255, 204, 67, 255)
    teal = (54, 226, 210, 255)

    draw_shadow_text(draw, (x, y), "这桌亮马河", title_font, white, stroke=2)
    draw_shadow_text(draw, (x, y + 94), "啤酒局", title_font, teal, stroke=2)
    draw_shadow_text(draw, (x, y + 188), "是在", title_font, white, stroke=2)
    draw_shadow_text(draw, (x + 182, y + 172), "Zup", zup_font, yellow, stroke=2)
    draw_shadow_text(draw, (x + 405, y + 188), "上看到的", title_font, white, stroke=2)

    draw.rounded_rectangle((x, y + 306, x + 98, y + 317), radius=6, fill=teal)
    draw_shadow_text(draw, (x, y + 352), "打开地图，附近热闹一眼发现", sub_font, white, stroke=1)

    # Replace the old tiny bottom label with a larger feed-readable badge.
    bx, by, bw, bh = 58, 1300, 655, 84
    rounded_rect(draw, (bx, by, bx + bw, by + bh), 42, (3, 14, 18, 222), outline=(54, 226, 210, 255), width=3)
    draw.text((bx + 42, by + 19), "Zup", font=badge_bold, fill=yellow)
    draw.text((bx + 165, by + 18), "|  附近实时活动地图", font=badge_font, fill=white)
    draw.ellipse((bx + bw - 70, by + 23, bx + bw - 32, by + 61), fill=teal)
    draw.ellipse((bx + bw - 58, by + 33, bx + bw - 44, by + 47), fill=(3, 14, 18, 255))

    im.convert("RGB").save(out, quality=96)
    return out


if __name__ == "__main__":
    for p in [fix_a(), fix_b()]:
        print(p)
