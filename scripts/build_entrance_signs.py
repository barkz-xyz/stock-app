from __future__ import annotations

from pathlib import Path

from reportlab.lib.colors import Color, HexColor
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from build_catalog_variants import (
    ASSETS,
    FONT_BODY,
    FONT_DISPLAY,
    GOLD,
    NAVY,
    PALE_GOLD,
    PAPER,
    WHITE,
    draw_contain,
    draw_crop,
    draw_logo,
    draw_wrapped,
    fmt_price,
    load_products,
    register_fonts,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "cartel-entrada"
HORIZONTAL_PDF = OUTPUT_DIR / "cartel-entrada-horizontal-142x64cm.pdf"
VERTICAL_PDF = OUTPUT_DIR / "cartel-entrada-vertical-64x142cm.pdf"

CREAM = HexColor("#F6F0E7")
LIGHT_GOLD = HexColor("#F3D8A3")
SOFT_LINE = HexColor("#DED5C8")


def product_prices() -> dict[str, int]:
    return {product.name: product.price for product in load_products()}


def selected_menu() -> list[dict[str, object]]:
    prices = product_prices()
    return [
        {
            "title": "EMPANADAS",
            "subtitle": "MASA DE HOJA · HORNEADAS",
            "image": "Empanadas.jpg",
            "items": [
                ("Queso masa de hoja", prices["Empanada queso masa de hoja"]),
                ("Jamón/queso masa de hoja", prices["Empanada jamón/queso masa de hoja"]),
                ("Champiñón/queso", prices["Empanada champiñón/queso"]),
                ("Pino (carne picada)", prices["Empanada pino (carne picada)"]),
                ("Pollo/queso", prices["Empanada pollo/queso"]),
            ],
        },
        {
            "title": "PANADERÍA",
            "subtitle": "PANES & ALIADOS",
            "image": "Milagrito.jpg",
            "items": [
                ("Aliado amasado jamón/queso", prices["Aliado amasado jamón/queso"]),
                ("Aliado dobladita salame/queso", prices["Aliado dobladita salame/queso"]),
                ("Croissant", prices["Croissant"]),
                ("Pan amasado o hallulla", prices["Pan amasado"]),
                ("Pan dobladita o milagrito", prices["Pan dobladita"]),
            ],
        },
        {
            "title": "PIZZA & MÁS",
            "subtitle": "SALADOS Y FAVORITOS",
            "image": "Pizza.jpg",
            "items": [
                ("Berlines", prices["Berlines"]),
                ("Rolls de canela", prices["Rolls de canela"]),
                ("Pizza trozo", prices["Pizza trozo"]),
                ("Pie de limón", prices["Pie de limón"]),
                ("Pizza mediana", prices["Pizza mediana"]),
            ],
        },
    ]


def draw_frame(c: canvas.Canvas, width: float, height: float) -> None:
    c.setFillColor(NAVY)
    c.rect(0, 0, width, height, fill=1, stroke=0)
    c.setStrokeColor(GOLD)
    c.setLineWidth(3.2)
    c.rect(13 * mm, 13 * mm, width - 26 * mm, height - 26 * mm, fill=0, stroke=1)
    c.setLineWidth(1.15)
    c.rect(19 * mm, 19 * mm, width - 38 * mm, height - 38 * mm, fill=0, stroke=1)


def draw_wholesale_ribbon(c: canvas.Canvas, x: float, y: float, width: float, height: float) -> None:
    c.setFillColor(GOLD)
    c.roundRect(x, y, width, height, height / 2, fill=1, stroke=0)
    c.setFillColor(NAVY)
    font_size = min(22, height * 0.31)
    c.setFont(FONT_BODY, font_size)
    c.drawCentredString(
        x + width / 2,
        y + (height - font_size) / 2 + font_size * 0.18,
        "VENTA AL POR MAYOR DESDE 12 UNIDADES · PRECIO A CONVENIR POR INTERNO",
    )


def draw_horizontal_menu_card(
    c: canvas.Canvas,
    card: dict[str, object],
    x: float,
    y: float,
    width: float,
    height: float,
    index: int,
) -> None:
    c.setFillColor(PAPER)
    c.roundRect(x, y, width, height, 14 * mm, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.roundRect(x, y + height - 16 * mm, width, 16 * mm, 8 * mm, fill=1, stroke=0)
    c.rect(x, y + height - 16 * mm, width, 8 * mm, fill=1, stroke=0)

    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 55)
    c.drawString(x + 20 * mm, y + height - 48 * mm, str(card["title"]))
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 22)
    c.drawString(x + 20 * mm, y + height - 66 * mm, str(card["subtitle"]))

    items = list(card["items"])
    row_top = y + height - 104 * mm
    row_gap = 48 * mm
    text_x = x + 20 * mm
    price_x = x + width - 20 * mm
    for row_index, (name, price) in enumerate(items):
        baseline = row_top - row_index * row_gap
        c.setFillColor(NAVY)
        draw_wrapped(
            c,
            str(name),
            text_x,
            baseline,
            width - 95 * mm,
            FONT_BODY,
            27,
            NAVY,
            leading=30,
            max_lines=2,
        )
        c.setFillColor(GOLD)
        c.setFont(FONT_DISPLAY, 34)
        c.drawRightString(price_x, baseline - 1, fmt_price(int(price)))
        if row_index < len(items) - 1:
            c.setStrokeColor(SOFT_LINE)
            c.setLineWidth(1)
            c.line(text_x, baseline - 19 * mm, price_x, baseline - 19 * mm)

    photo_x = x + 18 * mm
    photo_y = y + 22 * mm
    photo_w = width - 36 * mm
    photo_h = 70 * mm
    draw_crop(
        c,
        ASSETS / str(card["image"]),
        photo_x,
        photo_y,
        photo_w,
        photo_h,
        f"entrance-horizontal-{index}",
        radius=8 * mm,
        focus_y=0.55,
    )
    c.saveState()
    c.setFillColor(Color(28 / 255, 38 / 255, 48 / 255, alpha=0.18))
    c.roundRect(photo_x, photo_y, photo_w, photo_h, 8 * mm, fill=1, stroke=0)
    c.restoreState()


def build_horizontal() -> Path:
    width, height = 1420 * mm, 640 * mm
    c = canvas.Canvas(str(HORIZONTAL_PDF), pagesize=(width, height), pageCompression=1)
    c.setTitle("Cartel de entrada horizontal - Atelier del Puerto")
    c.setAuthor("Atelier del Puerto")
    c.setSubject("Cartel exterior 142 x 64 cm")
    draw_frame(c, width, height)

    c.setFillColor(LIGHT_GOLD)
    c.setFont(FONT_BODY, 23)
    c.drawString(57 * mm, height - 77 * mm, "PANADERÍA · PASTELERÍA")
    c.drawRightString(width - 57 * mm, height - 77 * mm, "SALADOS · PIZZAS")
    draw_contain(
        c,
        ASSETS / "recurso horizontal.webp",
        (width - 600 * mm) / 2,
        506 * mm,
        600 * mm,
        110 * mm,
    )

    cards = selected_menu()
    side = 45 * mm
    gap = 22 * mm
    card_width = (width - 2 * side - 2 * gap) / 3
    card_y = 43 * mm
    card_height = 423 * mm
    for index, card in enumerate(cards):
        draw_horizontal_menu_card(
            c,
            card,
            side + index * (card_width + gap),
            card_y,
            card_width,
            card_height,
            index,
        )

    draw_wholesale_ribbon(c, 356 * mm, 477 * mm, 708 * mm, 25 * mm)
    c.save()
    return HORIZONTAL_PDF


def draw_vertical_menu_card(
    c: canvas.Canvas,
    card: dict[str, object],
    x: float,
    y: float,
    width: float,
    height: float,
    index: int,
) -> None:
    c.setFillColor(PAPER)
    c.roundRect(x, y, width, height, 13 * mm, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.rect(x, y + height - 10 * mm, width, 10 * mm, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 50)
    c.drawString(x + 18 * mm, y + height - 39 * mm, str(card["title"]))
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 18)
    c.drawString(x + 19 * mm, y + height - 56 * mm, str(card["subtitle"]))

    photo_size = 150 * mm
    photo_x = x + width - photo_size - 18 * mm
    photo_y = y + (height - photo_size) / 2 - 3 * mm
    draw_crop(
        c,
        ASSETS / str(card["image"]),
        photo_x,
        photo_y,
        photo_size,
        photo_size,
        f"entrance-vertical-{index}",
        radius=10 * mm,
        focus_y=0.55,
    )

    items = list(card["items"])
    text_x = x + 19 * mm
    price_x = x + width - photo_size - 32 * mm
    first_baseline = y + height - 88 * mm
    row_gap = 27 * mm
    for row_index, (name, price) in enumerate(items):
        baseline = first_baseline - row_index * row_gap
        c.setFillColor(NAVY)
        c.setFont(FONT_BODY, 22)
        c.drawString(text_x, baseline, str(name))
        c.setFillColor(GOLD)
        c.setFont(FONT_DISPLAY, 27)
        c.drawRightString(price_x, baseline - 1, fmt_price(int(price)))
        if row_index < len(items) - 1:
            c.setStrokeColor(SOFT_LINE)
            c.setLineWidth(0.8)
            c.line(text_x, baseline - 10 * mm, price_x, baseline - 10 * mm)


def build_vertical() -> Path:
    width, height = 640 * mm, 1420 * mm
    c = canvas.Canvas(str(VERTICAL_PDF), pagesize=(width, height), pageCompression=1)
    c.setTitle("Cartel de entrada vertical - Atelier del Puerto")
    c.setAuthor("Atelier del Puerto")
    c.setSubject("Cartel exterior 64 x 142 cm")
    draw_frame(c, width, height)

    draw_contain(
        c,
        ASSETS / "recurso horizontal.webp",
        55 * mm,
        height - 181 * mm,
        530 * mm,
        138 * mm,
    )

    hero_x, hero_y = 45 * mm, 862 * mm
    hero_w, hero_h = 550 * mm, 326 * mm
    draw_crop(
        c,
        ASSETS / "Empanadas.jpg",
        hero_x,
        hero_y,
        hero_w,
        hero_h,
        "entrance-vertical-hero",
        radius=14 * mm,
        focus_y=0.54,
    )
    c.saveState()
    c.setFillColor(Color(28 / 255, 38 / 255, 48 / 255, alpha=0.38))
    c.roundRect(hero_x, hero_y, hero_w, hero_h, 14 * mm, fill=1, stroke=0)
    c.restoreState()
    c.setFillColor(WHITE)
    c.setFont(FONT_DISPLAY, 63)
    c.drawString(hero_x + 25 * mm, hero_y + 52 * mm, "Hecho para compartir")
    c.setFillColor(LIGHT_GOLD)
    c.setFont(FONT_BODY, 24)
    c.drawString(hero_x + 27 * mm, hero_y + 32 * mm, "SABOR ARTESANAL · TODOS LOS DÍAS")

    card_x = 45 * mm
    card_w = 550 * mm
    card_h = 230 * mm
    card_ys = [606 * mm, 356 * mm, 106 * mm]
    for index, (card, card_y) in enumerate(zip(selected_menu(), card_ys)):
        draw_vertical_menu_card(c, card, card_x, card_y, card_w, card_h, index)

    draw_wholesale_ribbon(c, 81 * mm, 49 * mm, 478 * mm, 35 * mm)
    c.save()
    return VERTICAL_PDF


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    register_fonts()
    print(build_horizontal())
    print(build_vertical())


if __name__ == "__main__":
    main()
