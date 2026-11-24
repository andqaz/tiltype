"""Сравнивает собственные подсловные веса с установленными пакетами TilType.

Измеряет первые слова, целые фразы и ресурсы на одном наборе входов.
Выбор языка выполняется по введённому тексту, как в самом плагине.
"""

import argparse
import hashlib
import json
import math
import random
import re
import statistics
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

import psutil
import torch
from benchmark import PARTITIONS, ROOT, extract_package, run_engine, summarize
from benchmark_sentences import held_out_positions
from sentence_data import SENTENCE_BOUNDARY, WORD
from subword_data import PAD, token_id
from subword_model import PhrasePredictor, SubwordModel
from tokenizers import Tokenizer

CASES_PER_LENGTH = 100
CPU_THREADS = 4
TEXT_LIMIT = 600
LANGUAGE_CONTEXT = 6
KAZAKH = re.compile("[әғқңөұүһі]")
ENGLISH = re.compile(r"[a-z]+(?:['-][a-z]+)*")
CYRILLIC = re.compile(r"[а-яёәғқңөұүһі]+(?:['-][а-яёәғқңөұүһі]+)*")


def select_context(before: str, ranks: dict[str, dict[str, int]]) -> tuple[str, str] | None:
    """Выбирает язык и последнее предложение по тем же признакам, что Phrases."""
    text = before[-TEXT_LIMIT:].lower().replace("’", "'")
    words = WORD.findall(SENTENCE_BOUNDARY.split(text)[-1])
    if not words:
        return None
    latin = ENGLISH.fullmatch(words[-1])
    alphabet = ENGLISH if latin else CYRILLIC
    start = len(words)
    while start and alphabet.fullmatch(words[start - 1]):
        start -= 1
    context = words[start:]
    if not context:
        return None
    if latin:
        return "en", " ".join(context)
    recent = context[-LANGUAGE_CONTEXT:]
    if any(KAZAKH.search(word) for word in recent):
        return "kk", " ".join(context)
    scores = {language: sum(1 / math.log2(vocabulary[word] + 1) for word in recent if word in vocabulary)
              for language, vocabulary in ranks.items()}
    language = "kk" if scores["kk"] > scores["ru"] else "ru"
    return language, " ".join(context)


def make_sample(partition: str) -> dict[str, list[tuple[str, str, list[str]]]]:
    """Берёт по 100 коротких и длинных примеров для каждого языка."""
    rng = random.Random(4181)
    selected = {}
    for language, rows in held_out_positions(partition).items():
        short = rng.sample([row for row in rows if len(row[0].split()) <= 6], CASES_PER_LENGTH)
        long = rng.sample([row for row in rows if len(row[0].split()) > 6], CASES_PER_LENGTH)
        selected[language] = short + long
        rng.shuffle(selected[language])
    return selected


def load_ranks(package: Path) -> dict[str, dict[str, int]]:
    """Читает частотные индексы для русского и казахского языков."""
    with ZipFile(package) as archive:
        return {
            language: {word: index for index, word in enumerate(
                json.loads(archive.read(f"models/{language}.json"))["words"], 1)}
            for language in ("ru", "kk")
        }


def score(predictor: PhrasePredictor, ranks: dict[str, dict[str, int]],
          data: dict[str, list[tuple[str, str, list[str]]]]) -> dict:
    """Считает точность продолжений и ресурсы прогретого CPU-инференса."""
    for rows in data.values():
        for before, _, _ in rows[:4]:
            context = select_context(before, ranks)
            if context:
                predictor.suggest(context[1], context[0])
    process = psutil.Process()
    cpu_start = time.process_time()
    durations = []
    quality: dict[str, dict[str, int]] = {}
    for language, rows in data.items():
        counts = dict(tested=len(rows), matched=0, covered=0, alternativesMatched=0,
                      longMatched=0, phraseOffered=0, phraseExact=0)
        for before, expected, continuation in rows:
            started = time.perf_counter()
            context = select_context(before, ranks)
            options = predictor.suggest(context[1], context[0]) if context else []
            durations.append((time.perf_counter() - started) * 1000)
            primary = options[0].split() if options else []
            matched = bool(primary and primary[0] == expected)
            counts["covered"] += int(bool(primary))
            counts["matched"] += int(matched)
            counts["alternativesMatched"] += int(any(option.split()[0] == expected for option in options))
            counts["longMatched"] += int(matched and len(before.split()) > 6)
            counts["phraseOffered"] += int(len(primary) > 1)
            counts["phraseExact"] += int(len(primary) > 1 and primary == continuation[:len(primary)])
        quality[language] = counts
        print(f"{language}: {counts}", flush=True)
    return {
        "quality": quality, "steadyRssMB": process.memory_info().rss / 1e6,
        "timings": {
            "latencyP50Ms": statistics.median(durations),
            "latencyP95Ms": sorted(durations)[math.ceil(len(durations) * 0.95) - 1],
            "cpuMsPer1000": (time.process_time() - cpu_start) * 1e6 / len(durations),
        },
    }


def main() -> None:
    """Сравнивает экспериментальные веса с обычным и фразовым TilType."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--partition", choices=PARTITIONS, default="development")
    args = parser.parse_args()
    torch.set_num_threads(CPU_THREADS)
    torch.set_num_interop_threads(1)
    tokenizer_path = args.models / "tokenizer.json"
    model_path = args.models / "model.pt"
    data = make_sample(args.partition)
    payload = json.dumps(data, ensure_ascii=False).encode("utf8")
    result = {"sample": {"partition": args.partition, "perLanguage": CASES_PER_LENGTH * 2,
                         "sha256": hashlib.sha256(payload).hexdigest()}}
    phrases = ROOT / "dist/tiltype-ai-phrases.plugin"
    with TemporaryDirectory(prefix="tiltype-subword-") as folder:
        stage = Path(folder)
        sample_path = stage / "sample.json"
        sample_path.write_bytes(payload)
        packages = {
            "dictionary": ROOT / "dist/tiltype.plugin",
            "phrases": phrases,
            "baselineNeural": ROOT / "dist/tiltype-ai.plugin",
        }
        for mode, package in packages.items():
            meta, assets, script = extract_package(package, stage / mode, mode)
            result[mode] = {**meta, **summarize([run_engine(mode, assets, script, sample_path)])}
    started = time.perf_counter()
    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    model = SubwordModel(tokenizer.get_vocab_size(), token_id(tokenizer, PAD))
    model.load_state_dict(torch.load(model_path, weights_only=True, map_location="cpu"))
    predictor = PhrasePredictor(model, tokenizer)
    load_ms = (time.perf_counter() - started) * 1000
    result["subword"] = {
        "modelBytes": model_path.stat().st_size + tokenizer_path.stat().st_size,
        "parameters": sum(parameter.numel() for parameter in model.parameters()),
        "loadMs": load_ms,
        **score(predictor, load_ranks(phrases), data),
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
