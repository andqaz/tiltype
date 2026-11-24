"""Сравнивает четыре комбинации источников на одних и тех же курсорах.

Читает сохранённые выходы прежнего стенда. Открывает эталоны только после
записи кандидатов, считает попадания, приобретения и потери на каждой позиции.
"""

import hashlib
from collections import Counter, defaultdict

from evaluate import hits, interval
from mail_sources import Correspondence, documents, supported_document_phrase
from panel import HERE, OUT, read, save
from sources import merge, terms


def variants(row, result, mail):
    """Возвращает четыре пула с одинаковым лимитом и независимыми переключателями."""
    sources = result["sources"]
    baseline = result["pool"]
    letters = mail.candidates(row)
    augmented = (
        merge([letters, sources["plugin"], sources["corpus"], sources["document"]])
        if letters
        else baseline
    )
    phrase = supported_document_phrase(row, sources["document"])

    def promote(pool):
        return (
            ([phrase] + [other for other in pool if other != phrase])[:20]
            if phrase
            else pool
        )

    return {
        "previous": baseline,
        "mail": augmented,
        "document": promote(baseline),
        "both": promote(augmented),
    }


def score(rows, results, labels):
    """Считает парные разности относительно прежнего стенда, включая разбивку по жанру."""
    groups = defaultdict(Counter)
    changes = defaultdict(list)
    for row in rows:
        outputs = results[row["id"]]
        expected = labels[row["id"]]["pair"]
        for name, choices in outputs.items():
            for k in (1, 3, 20):
                hit = hits(choices[:k], expected)
                delta = int(hit) - int(hits(outputs["previous"][:k], expected))
                for group in (row["lang"], row["lang"] + "/" + row["genre"]):
                    counts = groups[f"{group}/{name}/{k}"]
                    counts.update(n=1, hits=hit, gained=delta > 0, lost=delta < 0)
                if k < 20:
                    changes[f"{row['lang']}/{name}/{k}"].append((row, delta))
    return {
        "groups": dict(groups),
        "intervalPP": {key: interval(values) for key, values in changes.items()},
    }


def main():
    """Проверяет идентичность входов и отсутствие длинных копий из писем обеих панелей."""
    protocol = read(OUT / "protocol.json")
    docs = list(documents())
    train = set()
    for doc in docs:
        words = terms(doc["text"])
        train.update(tuple(words[i : i + 12]) for i in range(len(words) - 11))
    for split_letters in read(HERE / "letters.json").values():
        for versions in split_letters:
            for before, after in versions:
                words = terms(before + " " + after)
                if any(
                    tuple(words[i : i + 12]) in train for i in range(len(words) - 11)
                ):
                    raise ValueError("Обнаружена копия тестового письма")
    for part in ("inputs", "labels"):
        path = OUT / f"development-{part}.json"
        if (
            hashlib.sha256(path.read_bytes()).hexdigest()
            != protocol["sha256"][path.name]
        ):
            raise ValueError(f"Выборка изменилась: {path}")
    rows = read(OUT / "development-inputs.json")
    previous = read(OUT / "development-candidates.json")
    mail = Correspondence(docs)
    results = {row["id"]: variants(row, previous[row["id"]], mail) for row in rows}
    save(OUT / "mail-development-candidates.json", results)
    report = score(rows, results, read(OUT / "development-labels.json"))
    report["inputSHA256"] = protocol["sha256"]["development-inputs.json"]
    report["corpusFilesSHA256"] = {
        p: hashlib.sha256((HERE / p).read_bytes()).hexdigest()
        for p in ("official_letters.json", "workplace_letters.tsv")
    }
    save(OUT / "mail-development-scores.json", report)


if __name__ == "__main__":
    main()
