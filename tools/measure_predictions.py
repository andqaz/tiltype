"""Готовит отложенные примеры и запускает проверку реального движка TilType.

Читает кэшированные корпуса тем же способом, что и сборщик, и передаёт
позиции в Node.js через стандартный ввод без промежуточных файлов.
"""

import argparse
import json
import re
import subprocess
from collections.abc import Iterator
from itertools import chain
from pathlib import Path

from build_predictions import ALPHABETS, HOLDOUT_PERIOD, ROOT, kaznerd_sentences, sentence_id, tatoeba_sentences, word_runs


def examples() -> Iterator[tuple[str, int, str, str]]:
    """Возвращает ожидаемое слово и видимый контекст из отложенных предложений."""
    for language, letters in ALPHABETS.items():
        sentences = tatoeba_sentences(language)
        if language == "kk":
            sentences = chain(sentences, kaznerd_sentences())
        alphabet = f"[{letters}]+"
        allowed = re.compile(rf"{alphabet}(?:['-]{alphabet})*")
        seen: set[int] = set()
        for sentence in sentences:
            ident = sentence_id(sentence)
            if ident % HOLDOUT_PERIOD or ident in seen:
                continue
            seen.add(ident)
            partition = (ident // HOLDOUT_PERIOD) % 2
            for run in word_runs(sentence, allowed):
                for index in range(1, len(run)):
                    yield language, partition, " ".join(run[:index]) + " ", run[index]


def main() -> None:
    """Проверяет указанные словари и JS-модуль на фиксированном разбиении."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, default=ROOT / "plugin" / "dictionaries")
    parser.add_argument("--runtime", type=Path, default=ROOT / "plugin" / "scripts" / "next-word.js")
    args = parser.parse_args()
    command = ["node", str(ROOT / "tools" / "score_predictions.cjs"), str(args.models), str(args.runtime)]
    with subprocess.Popen(command, stdin=subprocess.PIPE, text=True, encoding="utf-8") as process:
        if process.stdin is None:
            raise RuntimeError("Unable to open benchmark input")
        try:
            with process.stdin:
                for row in examples():
                    process.stdin.write(json.dumps(row, ensure_ascii=False) + "\n")
        except BrokenPipeError:
            raise SystemExit(process.wait() or 1)
        if process.wait():
            raise SystemExit(process.returncode)


if __name__ == "__main__":
    main()
