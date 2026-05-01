from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path("/Users/weiming/Downloads/小红书完成版")
OUT = Path("design/marketing/xhs-contact-sheets")
OUT.mkdir(parents=True, exist_ok=True)

try:
    FONT = ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", 28)
    FONT_SMALL = ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", 20)
except Exception:
    FONT = ImageFont.load_default()
    FONT_SMALL = ImageFont.load_default()

exts = {".png", ".jpg", ".jpeg", ".webp"}

for folder in sorted([p for p in ROOT.iterdir() if p.is_dir()]):
    files = sorted([p for p in folder.iterdir() if p.suffix.lower() in exts])
    if not files:
        continue

    thumb_w, thumb_h = 220, 310
    gap = 18
    label_h = 44
    cols = 4
    rows = (len(files) + cols - 1) // cols
    canvas_w = gap + cols * (thumb_w + gap)
    canvas_h = 72 + rows * (thumb_h + label_h + gap) + gap
    canvas = Image.new("RGB", (canvas_w, canvas_h), (18, 22, 28))
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 20), f"{folder.name}  |  {len(files)} images", fill=(245, 245, 245), font=FONT)

    for i, path in enumerate(files):
        r, c = divmod(i, cols)
        x = gap + c * (thumb_w + gap)
        y = 72 + r * (thumb_h + label_h + gap)
        img = Image.open(path).convert("RGB")
        thumb = ImageOps.contain(img, (thumb_w, thumb_h), Image.Resampling.LANCZOS)
        frame = Image.new("RGB", (thumb_w, thumb_h), (8, 12, 18))
        fx = (thumb_w - thumb.width) // 2
        fy = (thumb_h - thumb.height) // 2
        frame.paste(thumb, (fx, fy))
        canvas.paste(frame, (x, y))
        draw.rectangle((x, y, x + thumb_w - 1, y + thumb_h - 1), outline=(60, 70, 82), width=1)
        label = path.name
        if len(label) > 18:
            label = label[:17] + "..."
        draw.text((x, y + thumb_h + 8), label, fill=(220, 226, 235), font=FONT_SMALL)

    out = OUT / f"{folder.name}.jpg"
    canvas.save(out, quality=82, optimize=True)
    print(out.resolve())
