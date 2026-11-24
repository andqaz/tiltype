"""Создаёт отдельный пакет TilType AI с локальными весами и ресурсами SDK."""

import argparse
import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from build_plugin import DESKTOP_SDK, WEB_SDK, LocalResources  # noqa: E402

PLUGIN = ROOT / "tiltype-ai" / "plugin"
OUTPUT = ROOT / "dist" / "tiltype-ai.plugin"
PHRASE_OUTPUT = ROOT / "dist" / "tiltype-ai-phrases.plugin"
ORIGINAL = ROOT / "plugin"


def pack_phrase_evidence(source: Path) -> str:
    """Преобразует корпусный JSON для обучения в индекс поставляемого расширения."""
    phrases = json.loads(source.read_text(encoding="utf-8"))
    records = []
    for key, value in sorted(phrases.items()):
        if not key or not isinstance(value, str) or any(char in key + value for char in "\t\r\n"):
            raise ValueError(f"Invalid phrase entry in {source}")
        records.append(f"{key}\t{value}\n")
    return "".join(records)


def main() -> None:
    """Проверяет содержимое, собирает архив и атомарно заменяет предыдущий пакет."""
    parser_cli = argparse.ArgumentParser(description=__doc__)
    parser_cli.add_argument("--models", type=Path, default=PLUGIN / "models")
    parser_cli.add_argument("--output", type=Path)
    parser_cli.add_argument("--phrases", action="store_true", help="Build a separate sentence-prediction plugin")
    parser_cli.add_argument("--training-notice", type=Path, help="Additional attribution for these weights")
    args = parser_cli.parse_args()
    settings = json.loads((PLUGIN / "config.json").read_text(encoding="utf-8"))
    if args.phrases:
        settings.update(name="TilType AI Phrases", guid="asc.{D890CB06-A39C-4B20-A7DE-B8D60A361CB0}")
        variation = settings["variations"][0]
        variation["description"] = "Offline sentence-aware word and phrase suggestions."
        variation["descriptionLocale"] = {
            "ru": "Офлайн-подсказки слов и фраз с учётом предложения.",
            "kk": "Сөйлем контекстіне сай сөздер мен тіркестерді офлайн ұсыну.",
        }
    output = args.output or (PHRASE_OUTPUT if args.phrases else OUTPUT)
    entry = settings["variations"][0]["url"]
    source = (PLUGIN / entry).read_text(encoding="utf-8")
    parser = LocalResources()
    parser.feed(source)
    shared = "scripts/editor-command-queue.js"
    required = set(parser.paths) - {shared, entry}
    files = {name: PLUGIN / name for name in required}
    for language in ("en", "ru", "kk"):
        for extension in ("json", "bin"):
            name = f"{language}.{extension}"
            files[f"models/{name}"] = args.models / name
        if args.phrases:
            files[f"models/{language}-phrases.txt"] = args.models / f"{language}-phrases.json"
            pointer = f"{language}-pointer.json"
            files[f"models/{pointer}"] = PLUGIN / "models" / pointer
            alternatives = f"{language}-alternatives.txt"
            files[f"models/{alternatives}"] = PLUGIN / "models" / alternatives
            purpose = f"{language}-purpose-profile.json"
            files[f"models/{purpose}"] = PLUGIN / "models" / purpose
            inventory = f"{language}-purpose-inventory.txt"
            files[f"models/{inventory}"] = PLUGIN / "models" / inventory
            vector = f"{language}-document-vector.json"
            files[f"models/{vector}"] = PLUGIN / "models" / vector
    for path in files.values():
        if not path.is_file():
            raise FileNotFoundError(path)
    icons = sorted((ORIGINAL / "resources").rglob("*.png"))
    if not icons:
        raise FileNotFoundError("TilType icon assets are unavailable")
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = output.with_suffix(".tmp")
    with ZipFile(staged, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("config.json", json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
        archive.writestr(entry, source.replace(WEB_SDK, DESKTOP_SDK))
        for name, source_path in sorted(files.items()):
            if name.endswith("-phrases.txt"):
                archive.writestr(name, pack_phrase_evidence(source_path))
            else:
                archive.write(source_path, name)
        archive.write(ORIGINAL / shared, shared)
        for icon in icons:
            archive.write(icon, icon.relative_to(ORIGINAL).as_posix())
        archive.write(ROOT / "LICENSE", "LICENSE")
        archive.write(ORIGINAL / "DICTIONARY-NOTICE.md", "DICTIONARY-NOTICE.md")
        archive.write(PLUGIN / "MODEL-NOTICE.md", "MODEL-NOTICE.md")
        if args.training_notice:
            archive.write(args.training_notice, "TRAINING-NOTICE.md")
    with ZipFile(staged) as archive:
        if archive.testzip() is not None:
            raise ValueError("Invalid TilType AI archive")
    staged.replace(output)
    print(f"{output} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
