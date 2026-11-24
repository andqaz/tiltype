"""Подготавливает внешние реплики для обучения TilType AI Phrases.

Проверяет текст, разбивает реплики по границам предложений, исключает
совпадения с контрольными корпусами и сохраняет только текст и статистику.
"""

import argparse
import json
import re
import unicodedata
from collections.abc import Iterable
from itertools import chain
from pathlib import Path

from dialogue_sources import (
    ksc2_messages,
    matreshka_messages,
    openassistant_messages,
    taskmaster_messages,
)
from sentence_data import sentence_alphabet, sentence_runs

# sentence_data подключает общие инструменты корпуса до импорта.
# isort: split
from build_predictions import (
    ADDITIONAL_CONTEXT_CORPORA,
    HOLDOUT_PERIOD,
    corpus_sentences,
    kaznerd_sentences,
    leipzig_sentences,
    sentence_id,
    tatoeba_sentences,
)

CHUNK = re.compile(r"[^.!?…\r\n]+[.!?…]*")
NON_PROSE = re.compile(r"https?://|www\.|[\w.+-]+@[\w.-]+\.\w+|"
                       r"(?:\d[\s()+-]*){7}|\x60|<[^>]+>", re.IGNORECASE)
MIN_WORDS = 3
MAX_WORDS = 120
MAX_MESSAGE_LENGTH = 6_000
KAZAKH_LETTERS = frozenset("әғқңөұүһі")


def held_out_runs(language: str) -> Iterable[str]:
    """Возвращает нормализованные фрагменты из обеих контрольных частей."""
    allowed = sentence_alphabet(language)
    sources = chain(
        tatoeba_sentences(language),
        kaznerd_sentences() if language == "kk" else (),
        corpus_sentences(language),
        leipzig_sentences(ADDITIONAL_CONTEXT_CORPORA[language]),
    )
    for sentence in sources:
        if sentence_id(sentence) % HOLDOUT_PERIOD == 0:
            yield from (" ".join(run) for run in sentence_runs(sentence, allowed))


def import_language(language: str, directory: Path) -> dict[str, dict[str, int]]:
    """Записывает очищенные фразы одного языка и возвращает счётчики по источникам."""
    if language == "kk":
        sources = {"KSC2": ksc2_messages()}
    else:
        primary = {"Taskmaster": taskmaster_messages(directory)} if language == "en" else {
            "Matreshka": matreshka_messages(directory),
        }
        sources = {"OpenAssistant": openassistant_messages(directory, language), **primary}
    allowed = sentence_alphabet(language)
    held_out = set(held_out_runs(language))
    seen: set[str] = set()
    stats: dict[str, dict[str, int]] = {}
    target = directory / f"{language}.jsonl"
    temporary = target.with_suffix(".part")
    with temporary.open("w", encoding="utf8", newline="\n") as output:
        for source, messages in sources.items():
            counts = {"messages": 0, "runs": 0, "words": 0}
            for message in messages:
                counts["messages"] += 1
                if not message or len(message) > MAX_MESSAGE_LENGTH:
                    continue
                text = unicodedata.normalize("NFC", message)
                if NON_PROSE.search(text):
                    continue
                for chunk in CHUNK.finditer(text):
                    for run in clean_runs(chunk.group(), language, allowed):
                        key = " ".join(run)
                        if key in seen or key in held_out or sentence_id(key) % HOLDOUT_PERIOD == 0:
                            continue
                        seen.add(key)
                        output.write(json.dumps(key, ensure_ascii=False) + "\n")
                        counts["runs"] += 1
                        counts["words"] += len(run)
            if counts["runs"] == 0:
                raise ValueError(f"No usable {language} utterances in {source}")
            stats[source] = counts
            print(f"{language} {source}: {counts}", flush=True)
    temporary.replace(target)
    return stats


def clean_runs(text: str, language: str, allowed: re.Pattern[str]) -> Iterable[list[str]]:
    """Оставляет фрагменты допустимой длины и с признаками нужного языка."""
    for run in sentence_runs(text, allowed):
        if not MIN_WORDS <= len(run) <= MAX_WORDS:
            continue
        if language == "kk" and KAZAKH_LETTERS.isdisjoint("".join(run)):
            continue
        yield run


def main() -> None:
    """Импортирует один язык в общий каталог локальных корпусов."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=("en", "ru", "kk"))
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    stats = import_language(args.language, args.directory)
    (args.directory / f"{args.language}-import.json").write_text(
        json.dumps(stats, indent=2) + "\n", encoding="utf8",
    )


if __name__ == "__main__":
    main()
