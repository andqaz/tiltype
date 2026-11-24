"""Упаковывает рабочие файлы плагина в архив ONLYOFFICE с манифестом в корне."""

import json
from html.parser import HTMLParser
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin"
OUTPUT = ROOT / "dist" / "tiltype.plugin"
WEB_SDK = "https://onlyoffice.github.io/sdkjs-plugins/v1/"
DESKTOP_SDK = "../v1/"


class LocalResources(HTMLParser):
    """Собирает пути к скриптам и стилям, которые должны войти в пакет."""

    def __init__(self) -> None:
        super().__init__()
        self.paths: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Учитывает URL ресурсов плагина и пропускает общий SDK редактора."""
        attributes = dict(attrs)
        path = attributes.get("src") if tag == "script" else attributes.get("href") if tag == "link" else None
        if path and not path.startswith(WEB_SDK):
            self.paths.append(path)


def main() -> None:
    """Проверяет обязательные ресурсы, создаёт архив и проверяет его целостность."""
    config = json.loads((PLUGIN / "config.json").read_text(encoding="utf-8"))
    variation = config["variations"][0]
    pages = [variation["url"], "settings.html"]
    screenshots = variation["store"]["screenshots"]
    if not screenshots:
        raise ValueError("The Marketplace card requires at least one screenshot")
    required = [*pages, *screenshots, "README.md", "translations/langs.json", "3rd-Party.txt"]
    icon_directories = {
        "resources/light",
        "resources/dark",
        *variation["store"]["icons"].values(),
    }
    required += [
        f"{directory}/icon{scale}.png"
        for directory in sorted(icon_directories)
        for scale in ("", "@1.25x", "@1.5x", "@1.75x", "@2x")
    ]
    required += [f"dictionaries/{language}.txt" for language in ("en", "kk", "ru")]
    required += [
        f"dictionaries/hunspell/{locale}/{locale}.{extension}"
        for locale in ("en_US", "ru_RU", "kk_KZ")
        for extension in ("aff", "dic")
    ]
    parser = LocalResources()
    for page in pages:
        parser.feed((PLUGIN / page).read_text(encoding="utf-8"))
    required.extend(parser.paths)
    for resource in required:
        if not (PLUGIN / resource).is_file():
            raise FileNotFoundError(PLUGIN / resource)

    OUTPUT.parent.mkdir(exist_ok=True)
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for file in sorted(PLUGIN.rglob("*")):
            if file.is_file():
                name = file.relative_to(PLUGIN).as_posix()
                if file.suffix == ".html":
                    desktop_page = file.read_text(encoding="utf-8").replace(WEB_SDK, DESKTOP_SDK)
                    archive.writestr(name, desktop_page)
                else:
                    archive.write(file, name)
        archive.write(ROOT / "LICENSE", "LICENSE")

    with ZipFile(OUTPUT) as archive:
        corrupt_entry = archive.testzip()
        if corrupt_entry:
            raise ValueError(f"Corrupt archive entry: {corrupt_entry}")
    print(f"{OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
