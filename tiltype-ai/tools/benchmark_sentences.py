"""Сравнивает фразовый TilType AI с однословным AI и обычным словарём.

Использует отложенные предложения и измеряет первый вариант, список
вариантов, точность всей вставляемой фразы, задержку и память.
"""

import argparse
import hashlib
import json
import random
import re
from itertools import chain
from pathlib import Path
from tempfile import TemporaryDirectory

from benchmark import LANGUAGES, PARTITIONS, REPEATS, SEED, ROOT, extract_package, run_engine, summarize
from sentence_data import sentence_runs
from training_data import ALPHABETS
from build_predictions import HOLDOUT_PERIOD, kaznerd_sentences, sentence_id, tatoeba_sentences

SAMPLES_PER_GROUP = 1_500


def held_out_positions(partition: str = "evaluation") -> dict[str, list[tuple[str, str, list[str]]]]:
    """Фиксирует раздельные случайные выборки коротких и длинных контекстов."""
    result = {}
    for language, letters in ALPHABETS.items():
        sources = chain(tatoeba_sentences(language), kaznerd_sentences() if language == "kk" else ())
        allowed = re.compile(rf"[{letters}]+(?:['-][{letters}]+)*")
        groups: tuple[list[tuple[str, str, list[str]]], ...] = ([], [])
        counts = [0, 0]
        seen: set[int] = set()
        rng = random.Random(SEED)
        for sentence in sources:
            identifier = sentence_id(sentence)
            if identifier % HOLDOUT_PERIOD or (identifier // HOLDOUT_PERIOD) % 2 != PARTITIONS[partition] or identifier in seen:
                continue
            seen.add(identifier)
            for run in sentence_runs(sentence, allowed):
                for index in range(1, len(run)):
                    group = int(index > 6)
                    counts[group] += 1
                    position = len(groups[group]) if counts[group] <= SAMPLES_PER_GROUP else rng.randrange(counts[group])
                    if position >= SAMPLES_PER_GROUP:
                        continue
                    row = (" ".join(run[:index]) + " ", run[index], run[index:index + 3])
                    if position == len(groups[group]):
                        groups[group].append(row)
                    else:
                        groups[group][position] = row
        if any(len(group) != SAMPLES_PER_GROUP for group in groups):
            raise ValueError(f"Not enough held-out sentence positions for {language}")
        result[language] = groups[0] + groups[1]
        rng.shuffle(result[language])
    return result


def main() -> None:
    """Запускает три пакета и проверяет влияние расширенного контекста."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--previous-phrases", type=Path)
    parser.add_argument("--neural", type=Path, default=ROOT / "dist" / "tiltype-ai.plugin")
    parser.add_argument("--dictionary", type=Path, default=ROOT / "dist" / "tiltype.plugin")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--partition", choices=PARTITIONS, default="evaluation")
    args = parser.parse_args()

    payload = json.dumps(held_out_positions(args.partition), ensure_ascii=False).encode("utf8")
    with TemporaryDirectory(prefix="tiltype-sentences-") as directory:
        work = Path(directory)
        samples = work / "sentences.json"
        samples.write_bytes(payload)
        packages = {"dictionary": args.dictionary, "baselineNeural": args.neural, "phrases": args.candidate}
        if args.previous_phrases:
            packages["previousPhrases"] = args.previous_phrases
        engines = {mode: extract_package(package, work / mode, mode) for mode, package in packages.items()}
        runs: dict[str, list[dict]] = {mode: [] for mode in engines}
        modes = list(engines)
        for index in range(REPEATS):
            for mode in modes[index:] + modes[:index]:
                _, assets, runtime = engines[mode]
                runs[mode].append(run_engine(mode, assets, runtime, samples))
                print(f"{mode}: {index + 1}/{REPEATS}", flush=True)
        _, assets, runtime = engines["phrases"]
        control = run_engine("phrasesShort", assets, runtime, samples)
    report = {
        "sample": {"partition": args.partition, "perLanguage": SAMPLES_PER_GROUP * 2, "longPerLanguage": SAMPLES_PER_GROUP,
                   "languages": LANGUAGES, "sha256": hashlib.sha256(payload).hexdigest()},
        "repeats": REPEATS,
        **{mode: {**engines[mode][0], **summarize(runs[mode])} for mode in modes},
        "sameModelWithSixWords": control["quality"],
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
