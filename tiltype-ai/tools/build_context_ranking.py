"""Оценивает вероятности однословных продолжений для TilType Phrases.

Сжимает наблюдаемые распределения до нескольких вариантов на контекст.
Результат дополняет корпусный ресурс фразового режима.
"""

import argparse
import json
from collections import Counter, defaultdict
from itertools import chain, islice
from pathlib import Path

from import_dialogues import held_out_runs
from sentence_data import dialogue_sentences, training_sentences

GENERAL_LIMIT = 800_000
DIALOGUE_LIMIT = 220_000
CONTEXT_LIMIT = 3
RESULT_LIMIT = 18_000
PREDICTION_LIMIT = 3
MIN_CONTEXT_HITS = 5
MIN_WORD_HITS = 3
MIN_CONTEXT_SHARE_PERCENT = 24


def collect_distributions(language: str, dialogues: Path) -> dict[str, str]:
    """Возвращает частоты для надёжных контекстов без контрольных примеров."""
    excluded = set(held_out_runs(language))
    runs = chain(islice(training_sentences(language), GENERAL_LIMIT),
                 islice(dialogue_sentences(language, dialogues), DIALOGUE_LIMIT))
    counts: dict[str, Counter[str]] = defaultdict(Counter)
    for words in runs:
        if " ".join(words) in excluded:
            continue
        for index in range(1, len(words)):
            for width in range(1, min(CONTEXT_LIMIT, index) + 1):
                counts[" ".join(words[index - width:index])][words[index]] += 1
    entries = []
    for context, outcomes in counts.items():
        total = outcomes.total()
        best = outcomes.most_common(PREDICTION_LIMIT)
        hits = best[0][1]
        if hits < MIN_CONTEXT_HITS or hits * 100 < total * MIN_CONTEXT_SHARE_PERCENT:
            continue
        encoded = "|".join(f"{word},{round(100 * count / total)}" for word, count in best if count >= MIN_WORD_HITS)
        entries.append((hits * hits / total, context, encoded))
    entries.sort(reverse=True)
    return {"~" + context: encoded for _, context, encoded in entries[:RESULT_LIMIT]}


def write_evidence_overlay(resource: Path, prefix: str, additions: dict[str, str]) -> None:
    """Атомарно заменяет записи указанного типа в корпусном ресурсе."""
    evidence = json.loads(resource.read_text(encoding="utf8"))
    evidence = {key: value for key, value in evidence.items() if not key.startswith(prefix)}
    evidence.update(additions)
    staged = resource.with_suffix(".tmp")
    staged.write_text(json.dumps(evidence, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf8")
    staged.replace(resource)


def main() -> None:
    """Добавляет обученные распределения в ресурс одного языка."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=("ru", "kk", "en"))
    parser.add_argument("dialogues", type=Path)
    parser.add_argument("resource", type=Path)
    args = parser.parse_args()
    scores = collect_distributions(args.language, args.dialogues)
    write_evidence_overlay(args.resource, "~", scores)
    print(f"{args.language}: {len(scores):,} ranked contexts", flush=True)


if __name__ == "__main__":
    main()
