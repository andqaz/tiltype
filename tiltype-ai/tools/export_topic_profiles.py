"""Экспортирует проверенную статистику окончаний в ресурсы TilType Phrases."""

import argparse
import json
from pathlib import Path


def main() -> None:
    """Оставляет только признаки, которые загружает ранжировщик документа."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    arguments.output.mkdir(parents=True, exist_ok=True)
    for language in ("ru", "kk", "en"):
        source = arguments.source / f"context-word-forms-{language}.json"
        trained = json.loads(source.read_text(encoding="utf-8"))
        profile = {key: trained[key] for key in ("profile", "global", "total")}
        destination = arguments.output / f"{language}-pointer.json"
        pending = destination.with_suffix(".tmp")
        pending.write_text(json.dumps(profile, ensure_ascii=False, separators=(",", ":")) + "\n",
                           encoding="utf-8", newline="\n")
        pending.replace(destination)


if __name__ == "__main__":
    main()
