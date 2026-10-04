"""gen-og-card.py - one-off generator for public/og-card.png (the share card).

The card carries the product name and a one-line description beside the bird,
which needs real text rendering. scripts/gen-icons.mjs is dependency-free Node
with no font rasteriser, so the card is built here instead and committed as a
static asset; gen-icons.mjs no longer writes it.

Run from the repo root after `npm run icons` (it reads the bird from
public/icon-master-1024.png):

    python scripts/gen-og-card.py

Needs Pillow and the Segoe UI fonts (Windows). Rerun only when the card changes.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
W, H = 1200, 630
TILE = (0xC2, 0x69, 0x3C)   # #C2693C terracotta, same as the icon tile
CREAM = (0xF7, 0xEF, 0xE1)  # #F7EFE1, the bird's body colour
WHITE = (0xFF, 0xFF, 0xFF)  # tagline: 3.9:1 on the tile, large text
FONTS = Path("C:/Windows/Fonts")

TITLE = "Wren"
TAGLINE = ["Sticky notes saved as Markdown", "files on your own computer"]


def main():
    card = Image.new("RGB", (W, H), TILE)

    # The standard icon is a TILE-coloured rounded square on transparency, so
    # pasting it onto a TILE field leaves only the bird visible.
    # Flatten onto the tile colour BEFORE resizing, or the resample blends the
    # transparent corners in as black and leaves a faint outline of the tile.
    icon = Image.open(ROOT / "public" / "icon-master-1024.png").convert("RGBA")
    flat = Image.new("RGBA", icon.size, TILE + (255,))
    flat.alpha_composite(icon)
    size = 580
    bird = flat.convert("RGB").resize((size, size), Image.LANCZOS)
    card.paste(bird, (10, (H - size) // 2))

    draw = ImageDraw.Draw(card)
    title_font = ImageFont.truetype(str(FONTS / "segoeuib.ttf"), 150)
    tag_font = ImageFont.truetype(str(FONTS / "seguisb.ttf"), 36)

    x = 580
    draw.text((x, 160), TITLE, font=title_font, fill=CREAM)
    y = 370
    for line in TAGLINE:
        draw.text((x + 6, y), line, font=tag_font, fill=WHITE)
        y += 50

    out = ROOT / "public" / "og-card.png"
    card.save(out, optimize=True)
    print(f"wrote {out.relative_to(ROOT)} ({W}x{H})")


if __name__ == "__main__":
    main()
