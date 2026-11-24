"""Собирает подтверждённые фразы из обучающих предложений TilType AI.

Оставляет продолжения, которые достаточно часто встречаются после одной
и той же последовательности. Нейронная модель дополняет список словами.
"""

import argparse
import json
from collections import Counter
from itertools import islice
from pathlib import Path

from sentence_data import training_sentences
from training_data import ALPHABETS

MAX_SENTENCES = 850_000
MAX_ENTRIES = 24_000
MAX_WORD_ENTRIES = 18_000
CONTEXT_LENGTHS = (2, 3)
MIN_OCCURRENCES = 5
MIN_SHARE = 0.46
MIN_WORD_OCCURRENCES = 8
MIN_WORD_SHARE_PERCENT = 52
STRONG_PHRASE_OCCURRENCES = 8
STRONG_PHRASE_SHARE_PERCENT = 72


def collect_evidence(language: str) -> dict[str, str]:
    """Возвращает однословные и двухсловные продолжения, подтверждённые корпусом."""
    totals: Counter[str] = Counter()
    occurrences: Counter[tuple[str, str]] = Counter()
    words: Counter[tuple[str, str]] = Counter()
    for run in islice(training_sentences(language), MAX_SENTENCES):
        for index in range(2, len(run)):
            for width in CONTEXT_LENGTHS:
                if index < width:
                    continue
                context = " ".join(run[index - width:index])
                totals[context] += 1
                words[context, run[index]] += 1
                if index + 1 < len(run):
                    phrase = " ".join(run[index:index + 2])
                    occurrences[context, phrase] += 1
    best: dict[str, tuple[int, str]] = {}
    for (context, phrase), count in occurrences.items():
        if count < MIN_OCCURRENCES or count / totals[context] < MIN_SHARE:
            continue
        previous = best.get(context)
        if previous is None or count > previous[0] or (count == previous[0] and phrase < previous[1]):
            best[context] = count, phrase
    ordered = sorted(best.items(), key=lambda item: (-item[1][0], item[0]))
    evidence = {context: phrase for context, (_, phrase) in ordered[:MAX_ENTRIES]}
    word_entries = [
        (context, word, count)
        for (context, word), count in words.items()
        if context not in evidence and count >= MIN_WORD_OCCURRENCES and count * 100 >= MIN_WORD_SHARE_PERCENT * totals[context]
    ]
    word_entries.sort(key=lambda entry: (-entry[2], entry[0], entry[1]))
    for context, word, _ in word_entries[:MAX_WORD_ENTRIES]:
        evidence.setdefault(context, word)
    for (context, phrase), count in occurrences.items():
        if evidence.get(context) == phrase and count >= STRONG_PHRASE_OCCURRENCES and count * 100 >= STRONG_PHRASE_SHARE_PERCENT * totals[context]:
            evidence["!" + context] = phrase
    return evidence


def main() -> None:
    """Собирает проверяемый корпусный ресурс для одного языка."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=ALPHABETS)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    evidence = collect_evidence(args.language)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / f"{args.language}-phrases.json").write_text(
        json.dumps(evidence, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf8"
    )
    print(f"{args.language}: {len(evidence):,} corpus-supported contexts", flush=True)


if __name__ == "__main__":
    main()
