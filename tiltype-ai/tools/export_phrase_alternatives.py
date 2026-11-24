"""Упаковывает словарные частоты в построчный индекс фраз TilType Phrases."""

import argparse
from fractions import Fraction
import json
from math import lcm
from pathlib import Path


MAX_FREQUENCY_DENOMINATOR = 5_000_000
MAX_EXACT_INTEGER = 2**53 - 1


def encode_frequencies(entries: list[tuple[str, float]]) -> tuple[int, str]:
    """Кодирует частоты общим знаменателем или сохраняет исходные числа."""
    probabilities = [Fraction(probability).limit_denominator(MAX_FREQUENCY_DENOMINATOR)
                     for _, probability in entries]
    total = lcm(*(probability.denominator for probability in probabilities))
    if total <= MAX_EXACT_INTEGER:
        counts = [value.numerator * (total // value.denominator) for value in probabilities]
        if all(count / total == probability for count, (_, probability) in zip(counts, entries, strict=True)):
            return total, "|".join(f"{word},{count}" for (word, _), count in zip(entries, counts, strict=True))
    return 0, "|".join(f"{word},{probability!r}" for word, probability in entries)


def main() -> None:
    """Экспортирует частоты без округления, сортируя ключи как JavaScript."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    arguments.output.mkdir(parents=True, exist_ok=True)
    for language in ("ru", "kk", "en"):
        source = arguments.source / f"conditional-second-{language}.json"
        data = json.loads(source.read_text(encoding="utf-8"))
        entries = {**data["words"], **data["contexts"]}
        destination = arguments.output / f"{language}-alternatives.txt"
        pending = destination.with_suffix(".tmp")
        with pending.open("w", encoding="utf-8", newline="\n") as stream:
            for key in sorted(entries, key=lambda item: item.encode("utf-16-be")):
                total, values = encode_frequencies(entries[key])
                stream.write(f"{key}\t{total}\t{values}\n")
        pending.replace(destination)


if __name__ == "__main__":
    main()
