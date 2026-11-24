"""Сопоставляет сохранённые списки фраз с эталонами и готовит разбор ошибок.

Записывает вклад источников, точность первого варианта, интервалы по документам
и карточки для ручной оценки продолжений, отличающихся от текста автора.
"""

import csv
import random
import re
from collections import Counter, defaultdict
from typing import TypedDict

from panel import LANGS, OUT, read, save
from sources import merge

SOURCES = ("plugin", "corpus", "document")


class Result(TypedDict):
    """Агрегированные показатели по языку и отдельным условиям проверки."""

    groups: dict[str, dict[str, float]]
    intervals: dict[str, list[float]]


def hits(options, pair):
    """Проверяет полное совпадение двух первых слов, не засчитывая часть слова."""
    return any(o.lower() == pair or o.lower().startswith(pair + " ") for o in options)


def interval(records):
    """Оценивает разброс прироста повторной выборкой документов внутри жанра."""
    strata = defaultdict(lambda: defaultdict(list))
    for row, delta in records:
        strata[row["genre"]][row["doc"]].append(delta)
    rng = random.Random(96149)
    estimates = []
    for _ in range(1000):
        score = 0
        for docs in strata.values():
            values = list(docs.values())
            sampled = rng.choices(values, k=len(values))
            score += (
                sum(map(sum, sampled)) / sum(map(len, sampled)) * sum(map(len, values))
            )
        estimates.append(100 * score / len(records))
    estimates.sort()
    return [round(estimates[24], 2), round(estimates[974], 2)]


def evaluate(split: str) -> Result:
    """Разбирает промахи по стадиям и пишет карточки для независимой ручной оценки."""
    rows = read(OUT / f"{split}-inputs.json")
    labels = read(OUT / f"{split}-labels.json")
    results = read(OUT / f"{split}-candidates.json")
    counts = defaultdict(Counter)
    paired = defaultdict(list)
    reviews = []
    for row in rows:
        result = results[row["id"]]
        sources = result["sources"]
        pool = result["pool"]
        label = labels[row["id"]]
        pair = label["pair"]
        present = {s: hits(values, pair) for s, values in sources.items()}
        first = hits(pool[:1], pair)
        found = hits(pool, pair)
        status = (
            "first"
            if first
            else "below_first"
            if found
            else "cut_at_merge"
            if any(present.values())
            else "absent"
        )
        lang = row["lang"]
        metrics = {
            "n": 1,
            "base_pool": present["plugin"],
            "base_first": hits(sources["plugin"][:1], pair),
            "base_visible": hits(sources["plugin"][:3], pair),
            "pool": found,
            "visible": hits(pool[:3], pair),
            "first": first,
            "shown": bool(pool),
            "base_shown": bool(sources["plugin"]),
            status + "_cases": 1,
            "new": found and not present["plugin"],
            "lost": present["plugin"] and not found,
        }
        for name in SOURCES:
            metrics[name] = present[name]
            metrics[name + "_only"] = present[name] and sum(present.values()) == 1
            metrics["without_" + name] = hits(
                merge([sources[s] for s in SOURCES if s != name]), pair
            )
        for name, opts in (("base", sources["plugin"]), ("new", pool)):
            lead = opts[0].lower() if opts else ""
            exact = bool(
                lead
                and re.match(
                    re.escape(lead) + r"(?![^\W\d_]|['’-])", label["future"].lower()
                )
            )
            metrics[name + "_exactphrase"] = exact and len(lead.split()) >= 2
            metrics[name + "_saved"] = (
                max(0, len(lead) - len(row["typed"]) - 1) if exact else 0
            )
        groups = [lang, lang + "/" + row["genre"], lang + "/" + row["mode"]]
        if row["paired"]:
            groups.append(lang + "/paired")
        if row["mode"] == "afterTab":
            groups.append(
                lang + ("/verifiedTab" if result["priorOffered"] else "/controlledTab")
            )
        for g in groups:
            counts[g].update(metrics)
        paired[lang].append((row, int(found) - int(present["plugin"])))
        reviews.append(
            {
                "id": row["id"],
                "mode": row["mode"],
                "typed": row["typed"],
                "status": status,
                "expected": pair,
                "before": (row["history"] + row["before"])[-400:],
                "first": pool[0] if pool else "",
                "sourceHits": ",".join(s for s in SOURCES if present[s]),
                "alternatives": " | ".join(pool[:3]),
                "acceptFirst": "",
                "comment": "",
            }
        )
    totals: dict[str, dict[str, float]] = {
        group: dict(metrics) for group, metrics in counts.items()
    }
    for lang in LANGS:
        totals[lang]["deltaPP"] = round(
            100
            * (counts[lang]["pool"] - counts[lang]["base_pool"])
            / counts[lang]["n"],
            2,
        )
    report: Result = {
        "groups": totals,
        "intervals": {l: interval(paired[l]) for l in LANGS},
    }
    save(OUT / f"{split}-scores.json", report)
    with (OUT / f"{split}-review.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as stream:
        writer = csv.DictWriter(stream, fieldnames=list(reviews[0]))
        writer.writeheader()
        writer.writerows(reviews)
    return report
