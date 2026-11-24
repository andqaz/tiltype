"""Сравнивает TilType AI и существующий словарный пакет на одном компьютере.

Для каждого движка использует одни и те же отложенные позиции, отдельные
процессы и одинаковую нагрузку после прогрева.
"""

import argparse
import hashlib
import json
import platform
import random
import statistics
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile

import psutil

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from measure_predictions import examples  # noqa: E402

LANGUAGES = ("en", "ru", "kk")
EXAMPLES_PER_LANGUAGE = 6_000
SEED = 10_919
REPEATS = 3
TOOLS = Path(__file__).resolve().parent
PARTITIONS = {"development": 0, "evaluation": 1}


def sample_positions(partition_name: str) -> dict[str, list[tuple[str, str]]]:
    """Равномерно выбирает позиции из контрольной половины каждого языка."""
    output: dict[str, list[tuple[str, str]]] = {language: [] for language in LANGUAGES}
    rng = {language: random.Random(SEED) for language in LANGUAGES}
    seen = dict.fromkeys(LANGUAGES, 0)
    selected_partition = PARTITIONS[partition_name]
    for language, partition, before, expected in examples():
        if partition != selected_partition:
            continue
        seen[language] += 1
        batch = output[language]
        row = (before[-150:], expected)
        if len(batch) < EXAMPLES_PER_LANGUAGE:
            batch.append(row)
        else:
            position = rng[language].randrange(seen[language])
            if position < EXAMPLES_PER_LANGUAGE:
                batch[position] = row
    if any(len(rows) != EXAMPLES_PER_LANGUAGE for rows in output.values()):
        raise ValueError("Not enough evaluation positions")
    return output


def extract_package(package: Path, directory: Path, mode: str) -> tuple[dict, Path, Path]:
    """Извлекает только измеряемый код и веса из установочного пакета."""
    assets = directory / ("dictionaries" if mode == "dictionary" else "models")
    assets.mkdir(parents=True, exist_ok=True)
    script = directory / ("next-word.js" if mode == "dictionary" else "engine.js")
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    metadata: dict[str, str | int | dict[str, int]] = {
        "sha256": digest,
        "packageBytes": package.stat().st_size,
    }
    with ZipFile(package) as archive:
        manifest = json.loads(archive.read("config.json"))
        metadata["version"] = manifest["version"]
        script.write_bytes(archive.read("scripts/" + script.name))
        if mode == "dictionary":
            names = (f"predict-{language}{suffix}.json" for language in LANGUAGES for suffix in ("", "-fallback"))
        else:
            names = (f"{language}.{suffix}" for language in LANGUAGES for suffix in ("json", "bin"))
        for name in names:
            (assets / name).write_bytes(archive.read(f"{assets.name}/{name}"))
        if mode in ("phrases", "previousPhrases"):
            packed = "scripts/phrase-evidence-index.js" in archive.namelist()
            for language in LANGUAGES:
                name = f"{language}-phrases.{'txt' if packed else 'json'}"
                (assets / name).write_bytes(archive.read(f"models/{name}"))
            if packed:
                (assets / "phrase-evidence-index.js").write_bytes(archive.read("scripts/phrase-evidence-index.js"))
        if mode != "dictionary":
            metadata["vocabularySize"] = {
                language: len(json.loads(archive.read(f"models/{language}.json"))["words"])
                for language in LANGUAGES
            }
    return metadata, assets, script


def run_engine(mode: str, assets: Path, script: Path, samples: Path) -> dict:
    """Запускает независимый измерительный процесс с явным сбором мусора."""
    command = ["node", "--expose-gc", str(TOOLS / "benchmark-runtime.cjs"), mode, str(assets), str(script), str(samples)]
    completed = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    return json.loads(completed.stdout)


def summarize(runs: list[dict]) -> dict:
    """Сводит медианы ресурсов и проверяет стабильность качества между запусками."""
    quality = runs[0]["quality"]
    if any(run["quality"] != quality for run in runs):
        raise RuntimeError("Inference results varied across benchmark runs")
    return {
        "quality": quality,
        "loadMs": statistics.median(run["loadMs"] for run in runs),
        "loadedRssDeltaMB": statistics.median(
            run["loadedMemory"]["rssMB"] - run["emptyMemory"]["rssMB"] for run in runs
        ),
        "steadyRssMB": statistics.median(run["steadyMemory"]["rssMB"] for run in runs),
        "peakRssMB": statistics.median(run["peakRssMB"] for run in runs),
        "timings": {
            key: statistics.median(run["timings"][key] for run in runs)
            for key in runs[0]["timings"]
        },
    }


def processor_name() -> str:
    """Читает модель процессора Windows, если она доступна."""
    if sys.platform == "win32":
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
                return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
        except OSError:
            return platform.processor()
    return platform.processor()


def main() -> None:
    """Собирает отчёт о качестве, времени работы на процессоре и памяти."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dictionary", type=Path, default=ROOT / "dist" / "tiltype.plugin")
    parser.add_argument("--neural", type=Path, default=ROOT / "dist" / "tiltype-ai.plugin")
    older_model = parser.add_mutually_exclusive_group()
    older_model.add_argument("--baseline-neural", type=Path)
    older_model.add_argument("--compact-neural", type=Path)
    parser.add_argument("--partition", choices=PARTITIONS, default="evaluation")
    parser.add_argument("--output", type=Path, default=ROOT / "tiltype-ai" / "benchmark-results.json")
    args = parser.parse_args()
    cache = ROOT / ".cache" / "tiltype-ai-benchmark"
    cache.mkdir(parents=True, exist_ok=True)
    samples = cache / "samples.json"
    samples.write_text(json.dumps(sample_positions(args.partition), ensure_ascii=False), encoding="utf-8")
    engines = {
        "dictionary": extract_package(args.dictionary, cache / "dictionary", "dictionary"),
        "neural": extract_package(args.neural, cache / "neural", "neural"),
    }
    if args.compact_neural:
        engines["compactNeural"] = extract_package(args.compact_neural, cache / "compact-neural", "compactNeural")
    if args.baseline_neural:
        engines["baselineNeural"] = extract_package(args.baseline_neural, cache / "baseline-neural", "baselineNeural")
    result: dict[str, list[dict]] = {name: [] for name in engines}
    modes = tuple(engines)
    for iteration in range(REPEATS):
        start = iteration % len(modes)
        mode_order = modes[start:] + modes[:start]
        for mode in mode_order:
            _, assets, script = engines[mode]
            result[mode].append(run_engine(mode, assets, script, samples))
            print(f"{mode}: {iteration + 1}/{REPEATS}", flush=True)
    report = {
        "sample": {"seed": SEED, "partition": args.partition, "positionsPerLanguage": EXAMPLES_PER_LANGUAGE,
                   "sha256": hashlib.sha256(samples.read_bytes()).hexdigest()},
        "environment": {"system": platform.platform(), "processor": processor_name(),
                        "logicalProcessors": psutil.cpu_count(), "ramBytes": psutil.virtual_memory().total,
                        "node": subprocess.check_output(["node", "--version"], text=True).strip()},
        "repeats": REPEATS,
        **{name: {**engines[name][0], **summarize(runs)} for name, runs in result.items()},
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()
