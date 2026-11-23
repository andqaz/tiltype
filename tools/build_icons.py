"""Рисует значки TilType для панели редактора и карточки Marketplace.

Рендерит исходный знак в повышенном разрешении и создаёт PNG для каждого масштаба.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "plugin" / "resources"
SCALES = ((1, ""), (1.25, "@1.25x"), (1.5, "@1.5x"), (1.75, "@1.75x"), (2, "@2x"))
PALETTES = {
    "light": ("#162D34", "#8BE4C1"),
    "dark": ("#25434A", "#A2F5CD"),
}


def draw_mark(palette: tuple[str, str]) -> Image.Image:
    """Возвращает исходный знак с литерой T и стрелкой продолжения слова."""
    background, accent = palette
    image = Image.new("RGBA", (256, 256))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((10, 10, 245, 245), radius=56, fill=background)
    draw.polygon([(46, 66), (151, 66), (151, 88), (111, 88), (111, 189), (86, 189), (86, 88), (46, 88)],
                 fill="#F5FCF9")
    draw.polygon([(128, 127), (174, 127), (158, 111), (172, 97), (211, 136),
                  (172, 175), (158, 161), (174, 145), (128, 145)], fill=accent)
    return image


def save_icons() -> None:
    """Сохраняет варианты темы и DPI под именами, которые ожидает ONLYOFFICE."""
    store = ROOT / "store" / "icons"
    store.mkdir(parents=True, exist_ok=True)
    for theme, palette in PALETTES.items():
        directory = ROOT / theme
        directory.mkdir(exist_ok=True)
        mark = draw_mark(palette)
        for scale, suffix in SCALES:
            size = int(28 * scale)
            mark.resize((size, size), Image.Resampling.LANCZOS).save(directory / f"icon{suffix}.png")

    mark = draw_mark(PALETTES["light"])
    for scale, suffix in SCALES:
        width, height, size = round(120 * scale), round(60 * scale), round(54 * scale)
        canvas = Image.new("RGBA", (width, height))
        canvas.alpha_composite(mark.resize((size, size), Image.Resampling.LANCZOS),
                               ((width - size) // 2, (height - size) // 2))
        canvas.save(store / f"icon{suffix}.png")


if __name__ == "__main__":
    save_icons()
