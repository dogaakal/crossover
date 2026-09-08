"""Regenerate the app icons from the CROSSOVER venn mark. Run from the repo root."""
from PIL import Image, ImageDraw

PAPER = (239, 232, 218)
INK   = (22, 18, 14)
A     = (158, 27, 50)     # --a, the deep red the masthead venn uses
B     = (18, 58, 107)     # --b, the navy

def multiply(c1, c2):
    return tuple(x * y // 255 for x, y in zip(c1, c2))

def render(size, scale=1.0, bg=PAPER, ss=4):
    """The CROSSOVER venn: two overlapping discs, the lens genuinely multiplied.
       scale < 1 keeps the mark inside a maskable icon's 80% safe zone."""
    S = size * ss
    img = Image.new("RGB", (S, S), bg)
    d = ImageDraw.Draw(img)

    R = S * scale / 2.9              # 2 radii + 0.9R of separation
    sep = R * 0.9
    cy = S / 2
    cxa, cxb = S / 2 - sep / 2, S / 2 + sep / 2

    def box(cx):
        return [cx - R, cy - R, cx + R, cy + R]

    mA = Image.new("L", (S, S), 0); ImageDraw.Draw(mA).ellipse(box(cxa), fill=255)
    mB = Image.new("L", (S, S), 0); ImageDraw.Draw(mB).ellipse(box(cxb), fill=255)
    from PIL import ImageChops
    lens = ImageChops.multiply(mA, mB)          # both masks -> the intersection

    img.paste(Image.new("RGB", (S, S), A), mask=mA)
    img.paste(Image.new("RGB", (S, S), B), mask=mB)
    img.paste(Image.new("RGB", (S, S), multiply(A, B)), mask=lens)

    w = max(2, int(R * 0.075))
    d.ellipse(box(cxa), outline=INK, width=w)
    d.ellipse(box(cxb), outline=INK, width=w)

    return img.resize((size, size), Image.LANCZOS)

out = [
    ("icons/icon-192.png",          192, 0.86),
    ("icons/icon-512.png",          512, 0.86),
    ("icons/icon-512-maskable.png", 512, 0.62),   # inside the 80% safe circle
    ("icons/apple-touch-icon.png",  180, 0.86),   # iOS rounds corners itself
]
for path, size, scale in out:
    render(size, scale).save(path, optimize=True)
    print(f"{path:34} {size}x{size}  scale={scale}")
