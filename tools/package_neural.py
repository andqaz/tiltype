"""Подключает рабочие офлайн-веса TilType AI из каталога моделей плагина."""

import json
from pathlib import Path

LANGUAGES = ("en", "kk", "ru")
SCRIPT_PREFIX = "scripts/ai/"
PHRASE_SUFFIXES = (
    ".json", ".bin", "-phrases.txt", "-pointer.json", "-alternatives.txt",
    "-purpose-profile.json", "-purpose-inventory.txt", "-document-vector.json",
)


def neural_scripts(root: Path, resources: list[str]) -> dict[str, Path]:
    """Использует один экземпляр исходников ИИ для обеих сборок."""
    source = root / "tiltype-ai" / "plugin" / "scripts"
    return {resource: source / Path(resource).name for resource in resources if resource.startswith(SCRIPT_PREFIX)}


def required_models(plugin: Path) -> list[str]:
    """Перечисляет ресурсы всех движков и проверяет размер входа GRU."""
    resources = ["MODEL-NOTICE.md", "TRAINING-NOTICE.md"]
    for lang in LANGUAGES:
        resources.extend(f"models/{lang}{suffix}" for suffix in PHRASE_SUFFIXES)
        resources.extend(f"models/word/{lang}{suffix}" for suffix in (".json", ".bin"))
        resources.extend(f"models/{lang}-{kind}.json" for kind in ("recurrent", "topics"))
        base = json.loads((plugin / f"models/{lang}.json").read_text(encoding="utf8"))
        gru = json.loads((plugin / f"models/{lang}-recurrent.json").read_text(encoding="utf8"))
        if gru["input"] != base["embedding"]["columns"]:
            raise ValueError(f"Incompatible GRU input dimension for {lang}")
    return resources
