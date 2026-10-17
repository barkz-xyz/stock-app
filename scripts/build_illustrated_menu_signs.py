from __future__ import annotations

from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "Imagenes"
OUTPUT = ROOT / "output" / "cartel-entrada-menu"

NAVY = "#1C2630"
NAVY_2 = "#243746"
GOLD = "#D48D01"
GOLD_LIGHT = "#F2B84B"
CREAM = "#F7F0E4"
CREAM_2 = "#EDE2D1"
INK = "#26343D"
WHITE = "#FFFCF6"

DISPLAY_FONT = ASSETS / "AbrilFatface-Regular.ttf"
BODY_FONT = ASSETS / "Quicksand-VariableFont_wght.ttf"

# Exact 142:64 aspect ratio, at roughly 152 dpi for the requested physical size.
HORIZONTAL_SIZE = (8520, 3840)
VERTICAL_SIZE = (3840, 8520)
PREVIEW_HORIZONTAL = (2840, 1280)
PREVIEW_VERTICAL = (1280, 2840)


EMPANADAS = [
    ("Queso masa de hoja", 2000),
    ("Jamón/queso masa de hoja", 2200),
    ("Champiñón/queso", 2500),
    ("Pino (carne picada)", 2500),
    ("Pollo/queso", 2500),
]

PIZZAS = [
    ("Trozo", 1500),
    ("Mediana", 10000),
]

PANES = [
    ("Amasado", 2250),
    ("Hallulla", 2250),
    ("Dobladita", 2450),
    ("Milagrito", 2450),
]

ALIADOS = [
    ("Amasado jamón/queso", 1200),
    ("Dobladita salame/queso", 1300),
]


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), max(1, size))


def price(value: int) -> str:
    return "$" + f"{value:,}".replace(",", ".")


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def cover_image(path: Path, size: tuple[int, int], focus: tuple[float, float] = (0.5, 0.5)) -> Image.Image:
    source = Image.open(path).convert("RGB")
    sw, sh = source.size
    tw, th = size
    scale = max(tw / sw, th / sh)
    resized = source.resize((round(sw * scale), round(sh * scale)), Image.Resampling.LANCZOS)
    extra_x = resized.width - tw
    extra_y = resized.height - th
    left = round(max(0, extra_x) * max(0.0, min(1.0, focus[0])))
    top = round(max(0, extra_y) * max(0.0, min(1.0, focus[1])))
    return resized.crop((left, top, left + tw, top + th))


def stylize_food(path: Path, size: tuple[int, int], focus: tuple[float, float]) -> Image.Image:
    """Turn a local bakery photo into a warm editorial food illustration."""
    base = cover_image(path, size, focus)
    base = ImageEnhance.Contrast(base).enhance(1.08)
    base = ImageEnhance.Color(base).enhance(1.18)
    base = base.filter(ImageFilter.MedianFilter(5))

    reduced = base.resize((max(1, size[0] // 4), max(1, size[1] // 4)), Image.Resampling.LANCZOS)
    reduced = ImageOps.posterize(reduced, 5)
    painted = reduced.resize(size, Image.Resampling.LANCZOS).filter(ImageFilter.SMOOTH_MORE)

    gray = ImageOps.grayscale(base).filter(ImageFilter.GaussianBlur(1.4))
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edges = ImageOps.autocontrast(edges, cutoff=4)
    edges = edges.point(lambda p: 255 if p < 31 else max(45, 255 - int(p * 0.72)))
    ink_layer = Image.new("RGB", size, INK)
    illustrated = Image.composite(ink_layer, painted, ImageOps.invert(edges))
    return Image.blend(painted, illustrated, 0.34)


def paste_panel(
    canvas: Image.Image,
    art: Image.Image,
    box: tuple[int, int, int, int],
    radius: int,
    border: int,
    shadow: int,
) -> None:
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    mask = rounded_mask((w, h), radius)
    if shadow:
        shadow_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        shadow_shape = Image.new("RGBA", (w, h), (0, 0, 0, 150))
        shadow_layer.paste(shadow_shape, (x0 + shadow, y0 + shadow), mask)
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(shadow * 1.4))
        canvas.alpha_composite(shadow_layer)
    canvas.paste(art.convert("RGBA"), (x0, y0), mask)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(box, radius=radius, outline=GOLD, width=border)


def contain_image(path: Path, box: tuple[int, int, int, int]) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    x0, y0, x1, y1 = box
    scale = min((x1 - x0) / image.width, (y1 - y0) / image.height)
    return image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)


def paste_logo(canvas: Image.Image, box: tuple[int, int, int, int]) -> None:
    logo = contain_image(ASSETS / "transparente logo.png", box)
    x0, y0, x1, y1 = box
    x = x0 + (x1 - x0 - logo.width) // 2
    y = y0 + (y1 - y0 - logo.height) // 2
    canvas.alpha_composite(logo, (x, y))


def centered_text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, typeface: ImageFont.FreeTypeFont, fill: str) -> None:
    x, y = xy
    box = draw.textbbox((0, 0), text, font=typeface)
    draw.text((x - (box[2] - box[0]) / 2, y), text, font=typeface, fill=fill)


def fit_font(text: str, path: Path, max_size: int, max_width: int, min_size: int = 18) -> ImageFont.FreeTypeFont:
    size = max_size
    while size > min_size:
        fnt = font(path, size)
        if fnt.getlength(text) <= max_width:
            return fnt
        size -= 2
    return font(path, min_size)


def decorative_rule(draw: ImageDraw.ImageDraw, x0: int, x1: int, y: int, scale: float = 1.0) -> None:
    width = max(4, round(11 * scale))
    draw.line((x0, y, x1, y), fill=GOLD, width=width)
    diamond = round(17 * scale)
    cx = (x0 + x1) // 2
    draw.polygon(((cx, y - diamond), (cx + diamond, y), (cx, y + diamond), (cx - diamond, y)), fill=GOLD)


def section_heading(
    draw: ImageDraw.ImageDraw,
    title: str,
    center_x: int,
    top: int,
    max_width: int,
    size: int,
    light: bool = False,
) -> int:
    fill = WHITE if light else NAVY
    heading = fit_font(title, DISPLAY_FONT, size, max_width)
    centered_text(draw, (center_x, top), title, heading, fill)
    line_y = top + round(size * 1.15)
    decorative_rule(draw, center_x - max_width // 2, center_x + max_width // 2, line_y, size / 130)
    return line_y


def menu_rows(
    draw: ImageDraw.ImageDraw,
    rows: Iterable[tuple[str, int]],
    x0: int,
    x1: int,
    top: int,
    row_height: int,
    text_size: int,
    price_size: int,
    light: bool = False,
) -> int:
    item_color = WHITE if light else INK
    muted = "#E6D8C2" if light else "#B7A995"
    name_font = font(BODY_FONT, text_size)
    price_font = font(BODY_FONT, price_size)
    y = top
    for index, (name, amount) in enumerate(rows):
        max_name_width = round((x1 - x0) * 0.72)
        fitted = fit_font(name, BODY_FONT, text_size, max_name_width, round(text_size * 0.72))
        draw.text((x0, y), name, font=fitted, fill=item_color)
        amount_text = price(amount)
        amount_w = price_font.getlength(amount_text)
        draw.text((x1 - amount_w, y), amount_text, font=price_font, fill=GOLD_LIGHT if light else GOLD)
        if index < len(list(rows)) - 1:
            baseline = y + round(row_height * 0.70)
            left = x0 + round(fitted.getlength(name)) + round(text_size * 0.35)
            right = x1 - round(amount_w) - round(text_size * 0.35)
            if right > left:
                dot = max(5, round(text_size * 0.065))
                cursor = left
                while cursor < right:
                    draw.ellipse((cursor, baseline, cursor + dot, baseline + dot), fill=muted)
                    cursor += dot * 3
        y += row_height
    return y


def draw_badge(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], title: str, subtitle: str, scale: float) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=round(42 * scale), fill=GOLD, outline=GOLD_LIGHT, width=round(5 * scale))
    badge_height = y1 - y0
    title_font = fit_font(title, DISPLAY_FONT, round(94 * scale), x1 - x0 - round(70 * scale), round(54 * scale))
    subtitle_font = fit_font(subtitle, BODY_FONT, round(39 * scale), x1 - x0 - round(70 * scale), round(25 * scale))
    title_box = draw.textbbox((0, 0), title, font=title_font)
    subtitle_box = draw.textbbox((0, 0), subtitle, font=subtitle_font)
    title_h = title_box[3] - title_box[1]
    subtitle_h = subtitle_box[3] - subtitle_box[1]
    group_h = title_h + subtitle_h + round(26 * scale)
    group_y = y0 + (badge_height - group_h) // 2 - title_box[1]
    centered_text(draw, ((x0 + x1) // 2, group_y), title, title_font, NAVY)
    centered_text(draw, ((x0 + x1) // 2, group_y + title_h + round(26 * scale)), subtitle, subtitle_font, NAVY)


def create_canvas(size: tuple[int, int]) -> Image.Image:
    canvas = Image.new("RGBA", size, CREAM)
    draw = ImageDraw.Draw(canvas)
    w, h = size
    # Warm paper grain keeps the piece from feeling like a sterile price sheet.
    for y in range(0, h, max(18, h // 220)):
        alpha = 9 if (y // 18) % 2 else 5
        draw.line((0, y, w, y), fill=(218, 203, 181, alpha), width=max(2, h // 1600))
    return canvas


def save_outputs(canvas: Image.Image, stem: str, preview_size: tuple[int, int]) -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rgb = Image.new("RGB", canvas.size, CREAM)
    rgb.paste(canvas.convert("RGB"))
    rgb.save(OUTPUT / f"{stem}.png", format="PNG", compress_level=3, dpi=(152.4, 152.4))
    rgb.save(OUTPUT / f"{stem}.jpg", format="JPEG", quality=95, subsampling=0, optimize=True, dpi=(152.4, 152.4))
    preview = rgb.resize(preview_size, Image.Resampling.LANCZOS)
    preview.save(OUTPUT / f"{stem}-preview.png", format="PNG", optimize=True)


def build_horizontal() -> None:
    w, h = HORIZONTAL_SIZE
    canvas = create_canvas((w, h))
    draw = ImageDraw.Draw(canvas)
    s = w / 8520

    border = round(78 * s)
    draw.rounded_rectangle((border, border, w - border, h - border), radius=round(80 * s), fill=CREAM, outline=NAVY, width=round(46 * s))
    draw.rounded_rectangle((border + 54, border + 54, w - border - 54, h - border - 54), radius=round(60 * s), outline=GOLD, width=round(18 * s))

    header_h = round(690 * s)
    draw.rounded_rectangle((border + 78, border + 78, w - border - 78, border + header_h), radius=round(50 * s), fill=NAVY)
    paste_logo(canvas, (round(3770 * s), round(105 * s), round(4750 * s), round(600 * s)))
    centered_text(draw, (w // 2, round(583 * s)), "MENÚ DE SALADOS", font(BODY_FONT, round(70 * s)), GOLD_LIGHT)

    # Two clear halves, with the product art acting as the visual anchor instead of card thumbnails.
    divider_x = round(4310 * s)
    draw.line((divider_x, round(825 * s), divider_x, round(3425 * s)), fill=GOLD, width=round(14 * s))
    draw.ellipse((divider_x - round(26 * s), round(2070 * s), divider_x + round(26 * s), round(2122 * s)), fill=GOLD)

    # Left: empanada art plate and its menu.
    emp_art = stylize_food(ASSETS / "Empanadas.jpg", (round(1560 * s), round(1500 * s)), (0.55, 0.56))
    paste_panel(canvas, emp_art, (round(250 * s), round(1020 * s), round(1810 * s), round(2520 * s)), round(750 * s), round(18 * s), round(30 * s))
    section_heading(draw, "EMPANADAS", round(3000 * s), round(875 * s), round(1950 * s), round(150 * s))
    menu_rows(draw, EMPANADAS, round(1940 * s), round(4070 * s), round(1230 * s), round(330 * s), round(77 * s), round(87 * s))

    # Right: pizza plate above, bread plate below; lists stay highly readable at distance.
    pizza_art = stylize_food(ASSETS / "Pizza.jpg", (round(1420 * s), round(1120 * s)), (0.50, 0.61))
    paste_panel(canvas, pizza_art, (round(6760 * s), round(830 * s), round(8180 * s), round(1950 * s)), round(560 * s), round(18 * s), round(26 * s))
    section_heading(draw, "PIZZAS", round(5530 * s), round(875 * s), round(1850 * s), round(145 * s))
    menu_rows(draw, PIZZAS, round(4580 * s), round(6500 * s), round(1235 * s), round(315 * s), round(78 * s), round(88 * s))

    bread_art = stylize_food(ASSETS / "Milagrito.jpg", (round(1420 * s), round(1120 * s)), (0.52, 0.50))
    paste_panel(canvas, bread_art, (round(6760 * s), round(2120 * s), round(8180 * s), round(3240 * s)), round(560 * s), round(18 * s), round(26 * s))
    section_heading(draw, "PAN", round(5530 * s), round(1935 * s), round(1850 * s), round(145 * s))
    menu_rows(draw, PANES, round(4580 * s), round(6500 * s), round(2300 * s), round(245 * s), round(72 * s), round(82 * s))

    draw_badge(draw, (round(255 * s), round(2710 * s), round(1850 * s), round(3260 * s)), "ALIADOS", "Jamón/queso $1.200  ·  Salame/queso $1.300", s)
    draw_badge(draw, (round(4580 * s), round(3270 * s), round(6500 * s), round(3690 * s)), "SOPAIPILLAS", "Consulta precio y disponibilidad", s)

    footer_font = font(BODY_FONT, round(47 * s))
    centered_text(draw, (round(3040 * s), round(3490 * s)), "Precios sujetos a disponibilidad", footer_font, NAVY_2)
    save_outputs(canvas, "menu-entrada-horizontal-142x64cm", PREVIEW_HORIZONTAL)


def build_vertical() -> None:
    w, h = VERTICAL_SIZE
    canvas = create_canvas((w, h))
    draw = ImageDraw.Draw(canvas)
    s = w / 3840

    border = round(70 * s)
    draw.rounded_rectangle((border, border, w - border, h - border), radius=round(72 * s), fill=CREAM, outline=NAVY, width=round(42 * s))
    draw.rounded_rectangle((border + 48, border + 48, w - border - 48, h - border - 48), radius=round(55 * s), outline=GOLD, width=round(16 * s))

    draw.rounded_rectangle((round(165 * s), round(165 * s), round(3675 * s), round(1320 * s)), radius=round(55 * s), fill=NAVY)
    paste_logo(canvas, (round(1020 * s), round(220 * s), round(2820 * s), round(1150 * s)))
    centered_text(draw, (w // 2, round(1110 * s)), "MENÚ DE SALADOS", font(BODY_FONT, round(64 * s)), GOLD_LIGHT)

    # Empanadas: hero plate followed immediately by the full list.
    emp_art = stylize_food(ASSETS / "Empanadas.jpg", (round(3000 * s), round(1720 * s)), (0.52, 0.52))
    paste_panel(canvas, emp_art, (round(420 * s), round(1450 * s), round(3420 * s), round(3170 * s)), round(150 * s), round(16 * s), round(28 * s))
    draw.rounded_rectangle((round(320 * s), round(2920 * s), round(3520 * s), round(5000 * s)), radius=round(90 * s), fill=CREAM, outline=GOLD, width=round(13 * s))
    section_heading(draw, "EMPANADAS", w // 2, round(3090 * s), round(2800 * s), round(160 * s))
    menu_rows(draw, EMPANADAS, round(510 * s), round(3330 * s), round(3530 * s), round(270 * s), round(78 * s), round(88 * s))

    # Lower half: mixed illustrated plates with compact, distance-readable lists.
    draw.rounded_rectangle((round(165 * s), round(5150 * s), round(3675 * s), round(8240 * s)), radius=round(80 * s), fill=NAVY)
    pizza_art = stylize_food(ASSETS / "Pizza.jpg", (round(1350 * s), round(1250 * s)), (0.50, 0.61))
    paste_panel(canvas, pizza_art, (round(230 * s), round(5330 * s), round(1580 * s), round(6580 * s)), round(620 * s), round(15 * s), round(22 * s))
    bread_art = stylize_food(ASSETS / "Milagrito.jpg", (round(1350 * s), round(1250 * s)), (0.52, 0.49))
    paste_panel(canvas, bread_art, (round(2260 * s), round(6790 * s), round(3610 * s), round(8040 * s)), round(620 * s), round(15 * s), round(22 * s))

    section_heading(draw, "PIZZAS", round(2630 * s), round(5360 * s), round(1750 * s), round(135 * s), light=True)
    menu_rows(draw, PIZZAS, round(1770 * s), round(3500 * s), round(5710 * s), round(270 * s), round(73 * s), round(83 * s), light=True)

    section_heading(draw, "PAN", round(1110 * s), round(6650 * s), round(1750 * s), round(135 * s), light=True)
    menu_rows(draw, PANES, round(250 * s), round(1970 * s), round(6990 * s), round(225 * s), round(67 * s), round(77 * s), light=True)

    draw_badge(draw, (round(1740 * s), round(6150 * s), round(3500 * s), round(6590 * s)), "SOPAIPILLAS", "Consulta precio y disponibilidad", s * 0.9)
    draw_badge(draw, (round(250 * s), round(7900 * s), round(2100 * s), round(8260 * s)), "ALIADOS", "Jamón/queso $1.200 · Salame/queso $1.300", s * 0.82)

    save_outputs(canvas, "menu-entrada-vertical-64x142cm", PREVIEW_VERTICAL)


def main() -> None:
    build_horizontal()
    build_vertical()
    for output in sorted(OUTPUT.iterdir()):
        print(output)


if __name__ == "__main__":
    main()
