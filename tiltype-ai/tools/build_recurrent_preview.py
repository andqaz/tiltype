"""Собирает отдельный ONLYOFFICE-пакет GRU из текущего TilType AI Phrases."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / "dist" / "tiltype-ai-phrases.plugin"
OUTPUT = ROOT / "dist" / "tiltype-ai-phrases-gru-preview.plugin"
SCRIPTS = ("recurrent-phrase-decoder.js", "recurrent-phrase-options.js")
GUID = "asc.{8AF6FC3B-C7D2-4A88-92E3-CA16ACA27F05}"


def replace_once(source: str, before: str, after: str) -> str:
    """Заменяет ровно один проверенный фрагмент исходного пакета."""
    if source.count(before) != 1:
        raise ValueError(f"Unexpected archive layout near {before!r}")
    return source.replace(before, after, 1)


def insert(source: str, anchor: str, body: str) -> str:
    """Вставляет код перед проверенным фрагментом исходного пакета."""
    return replace_once(source, anchor, body + anchor)


def bind_enter(plugin: str) -> str:
    """Назначает Enter клавишей вставки в Preview и обновляет надпись в списке."""
    plugin = replace_once(plugin, "  const TAB = 9;\n", "")
    plugin = replace_once(plugin, "  [Tab]", "  [Enter]")
    plugin = replace_once(plugin, "после пробела и принимает её по Tab", "после пробела и принимает её по Enter")
    return replace_once(plugin,
                        "if (unmodified && (key.keyCode === TAB || key.keyCode === ENTER)) {\n"
                        "        finish(key.keyCode === TAB);",
                        "if (unmodified && key.keyCode === ENTER) {\n"
                        "        finish(true);")


def overlay(archive: ZipFile) -> dict[str, bytes]:
    """Дополняет выпущенный пакет браузерным декодером и уникальным конфигом."""
    config = json.loads(archive.read("config.json"))
    config.update(name="TilType AI Phrases GRU Preview", guid=GUID)
    config["variations"][0].update(
        description="Experimental offline GRU phrase completion.",
        descriptionLocale={
            "ru": "Экспериментальное локальное продолжение фраз моделью GRU.",
            "kk": "GRU үлгісімен тіркестерді офлайн жалғастырудың сынақ нұсқасы.",
        },
    )
    entry = config["variations"][0]["url"]
    html = insert(archive.read(entry).decode("utf8"), '  <script defer src="scripts/load-model.js">',
                  "".join(f'  <script defer src="scripts/{name}"></script>\n' for name in SCRIPTS))
    loader = insert(archive.read("scripts/load-model.js").decode("utf8"), "  return model;\n",
                    '  await optional(language + "-recurrent.json", text => {\n'
                    '    neuralRecurrentPhraseOptions.attach(model, JSON.parse(text));\n'
                    '  });\n')
    plugin = insert(archive.read("scripts/plugin.js").decode("utf8"), "      if (!options.length) return;\n",
                    "      const recurrentInput = sentenceMode && (selected ?? neuralEngine.selectSentence(result.before, models));\n"
                    "      if (recurrentInput) {\n"
                    '        options = neuralRecurrentPhraseOptions.apply(options, result.before, result.history ?? "", recurrentInput.model);\n'
                    "      }\n")
    plugin = bind_enter(plugin)
    changes = {"config.json": json.dumps(config, ensure_ascii=False, indent=2) + "\n",
               entry: html, "scripts/load-model.js": loader, "scripts/plugin.js": plugin}
    files = {name: text.encode("utf8") for name, text in changes.items()}
    for name in SCRIPTS:
        files[f"scripts/{name}"] = (ROOT / "tiltype-ai" / "plugin" / "scripts" / name).read_bytes()
    cache = ROOT / ".cache" / "tiltype-ai-variants" / "document-context"
    for language in ("ru", "kk", "en"):
        source = json.loads((cache / f"recurrent-phrase-{language}.json").read_text(encoding="utf8"))
        keys = ("hidden", "input", "words", "history", "recurrent", "output")
        files[f"models/{language}-recurrent.json"] = json.dumps(
            {key: source[key] for key in keys}, ensure_ascii=False, separators=(",", ":")).encode("utf8")
    return files


def main() -> None:
    """Проверяет архив перед атомарной записью отдельного установщика."""
    with ZipFile(RELEASE) as base, TemporaryDirectory(prefix="tiltype-gru-", dir=OUTPUT.parent) as work:
        files = overlay(base)
        staged = Path(work) / OUTPUT.name
        with ZipFile(staged, "w", ZIP_DEFLATED, compresslevel=9) as candidate:
            for name in sorted(set(base.namelist()) | files.keys()):
                candidate.writestr(name, files[name] if name in files else base.read(name))
        with ZipFile(staged) as candidate:
            config = json.loads(candidate.read("config.json"))
            if candidate.testzip() or config["guid"] != GUID or config["version"] != json.loads(base.read("config.json"))["version"]:
                raise ValueError("Invalid GRU preview package")
        staged.replace(OUTPUT)
    print(f"{OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
