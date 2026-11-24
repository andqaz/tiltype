"""Сравнивает выпущенные пакеты на прежней панели и тематических позициях dev.

Отбор тематических курсоров использует только слова слева. Эталоны и варианты
моделей не участвуют в отборе. Отчёт включает двухсловные и однословные метрики.
"""

import csv
import gzip
import json
import random
import re
import subprocess
from collections import defaultdict

from panel import CORPUS, HERE, LANGS, OUT, read, save

WORK = CORPUS.parent / "topic-expansion"
CURSOR = re.compile(r"(?<!\w)([^\W\d_]+) +([^\W\d_]+)(?!\w)")


def topical_panel():
    """Берёт до 16 позиций на тему и язык, не более одной из документа на тему."""
    with (HERE.parent / "topic-seeds.tsv").open(encoding="utf-8-sig") as stream:
        seeds = list(csv.DictReader(stream, delimiter="\t"))
    rng = random.Random(3197)
    groups = defaultdict(list)
    with gzip.open(CORPUS / "development.jsonl.gz", "rt", encoding="utf8") as stream:
        for doc in map(json.loads, stream):
            lang = doc["language"]
            local = defaultdict(list)
            for line in doc["text"].splitlines():
                for m in CURSOR.finditer(line):
                    before = line[: m.start()]
                    if not before.endswith(" ") or len(before.split()) < 3:
                        continue
                    words = re.findall(r"[^\W\d_]+", before.lower())[-5:]
                    for topic in seeds:
                        if any(w.startswith(tuple(topic[lang].split())) for w in words):
                            local[topic["topic"]].append((before, m[0].lower()))
            for topic, items in local.items():
                groups[lang, topic].append((doc, rng.choice(items)))
    rows, labels = [], {}
    seen = set()
    for (lang, topic), values in sorted(groups.items()):
        rng.shuffle(values)
        count = 0
        for doc, (before, pair) in values:
            signature = (lang, before, pair)
            if signature in seen:
                continue
            seen.add(signature)
            key = f"topic-{len(rows)}"
            rows.append(
                {
                    "id": key,
                    "lang": lang,
                    "mode": "space",
                    "before": before[-600:],
                    "history": "",
                    "typed": "",
                    "topic": topic,
                }
            )
            labels[key] = {"pair": " ".join(pair.split())}
            count += 1
            if count == 16:
                break
    return rows, labels


def main():
    """Прогоняет три фиксированных конфигурации, сохраняя результаты каждого курсора."""
    fixed = read(OUT / "development-inputs.json")
    extra, labels = topical_panel()
    labels.update(read(OUT / "development-labels.json"))
    rows = fixed + extra
    save(WORK / "inputs.json", rows)
    report = {}
    for tag, package, mode in [
        ("dictionary", "before", "dictionary"),
        ("before", "before", "phrases"),
        ("after", "after", "phrases"),
    ]:
        target = WORK / (tag + "-options.json")
        perf = WORK / (tag + "-perf.json")
        subprocess.run(
            [
                "node",
                str(HERE / "baseline.cjs"),
                str(WORK / package),
                str(WORK / "inputs.json"),
                str(target),
                mode,
                str(perf),
            ],
            check=True,
        )
        options = read(target)
        scores = {}
        for panel, subset in [("fixed", fixed), ("topic", extra)]:
            for lang in LANGS:
                subset_lang = [r for r in subset if r["lang"] == lang]
                top1 = top3 = word = 0
                for r in subset_lang:
                    pair = labels[r["id"]]["pair"].lower().split()
                    choices = [s.lower().split() for s in options[r["id"]]["choices"]]
                    word += int(bool(choices and choices[0][:1] == pair[:1]))
                    top1 += int(bool(choices and choices[0][:2] == pair))
                    top3 += int(any(s[:2] == pair for s in choices[:3]))
                scores[panel + "/" + lang] = {
                    "n": len(subset_lang),
                    "word": word,
                    "first": top1,
                    "three": top3,
                }
        report[tag] = {"quality": scores, "perf": read(perf)}
        print(tag, report[tag], flush=True)
    save(WORK / "comparison.json", report)


if __name__ == "__main__":
    main()
