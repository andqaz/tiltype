"""Учится дописывать второе слово после уже выбранного первого слова.

Группирует продолжения по контексту и первому слову, учитывает обрывы
предложений и исключает отложенные фразы из всех входных корпусов.
"""

import argparse
from collections import Counter, defaultdict
from collections.abc import Iterable
from itertools import chain, islice
from pathlib import Path

from build_context_ranking import write_evidence_overlay
from import_dialogues import held_out_runs
from sentence_data import dialogue_sentences, training_sentences

CONTEXT_MIN = 1
CONTEXT_MAX = 4
GENERAL_LIMIT = 850_000
DIALOGUE_LIMIT = 220_000
RESULT_LIMIT = 22_000
MIN_HITS = 5
MIN_SHARE_PERCENT = 78


def collect_extensions(runs: Iterable[list[str]], excluded: set[str]) -> dict[str, str]:
    """Возвращает надёжные продолжения поверх уже выбранного первого слова."""
    totals: Counter[tuple[str, ...]] = Counter()
    endings: dict[tuple[str, ...], Counter[str]] = defaultdict(Counter)
    seen = set()
    for words in runs:
        key = " ".join(words)
        if key in seen or key in excluded:
            continue
        seen.add(key)
        for index in range(1, len(words)):
            for width in range(CONTEXT_MIN, min(CONTEXT_MAX, index) + 1):
                prefix = tuple(words[index - width:index + 1])
                totals[prefix] += 1
                if index + 1 < len(words):
                    endings[prefix][words[index + 1]] += 1
    ranked = []
    for prefix, options in endings.items():
        second, hits = min(options.items(), key=lambda choice: (-choice[1], choice[0]))
        total = totals[prefix]
        if hits >= MIN_HITS and hits * 100 >= total * MIN_SHARE_PERCENT:
            ranked.append((hits * hits / total, prefix, second))
    ranked.sort(reverse=True)
    return {"+" + " ".join(prefix): second for _, prefix, second in ranked[:RESULT_LIMIT]}


def main() -> None:
    """Дописывает обученные продолжения в подготовленный ресурс одного языка."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=("ru", "kk", "en"))
    parser.add_argument("dialogues", type=Path)
    parser.add_argument("resource", type=Path)
    args = parser.parse_args()
    language = args.language
    runs = chain(islice(training_sentences(language), GENERAL_LIMIT),
                 islice(dialogue_sentences(language, args.dialogues), DIALOGUE_LIMIT))
    additions = collect_extensions(runs, set(held_out_runs(language)))
    write_evidence_overlay(args.resource, "+", additions)
    print(f"{language}: {len(additions):,} conditional phrase continuations", flush=True)


if __name__ == "__main__":
    main()
