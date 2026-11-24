"""Сравнивает независимые основания для подъёма фразы на фиксированной панели.

Использует прежние кандидаты документа и общий оценщик стенда. Сверяет
контрольный вариант с сохранённым результатом предыдущего эксперимента.
"""

import hashlib

from mail_sources import supported_document_phrase
from mail_trial import score
from panel import OUT, read, save
from sources import terms


def promote(pool, phrase, slot=0):
    """Помещает фразу в заданную строку и сохраняет порядок остальных вариантов."""
    if not phrase or phrase in pool[:slot]:
        return pool
    rest = [item for item in pool if item != phrase]
    return (rest[:slot] + [phrase] + rest[slot:])[:20]


def compare(row, result):
    """Применяет правила к одному левому контексту без обращения к эталону."""
    pool = result["pool"]
    phrases = result["sources"]["document"]
    context = supported_document_phrase(row, phrases, use_prefix=False)
    prefix = supported_document_phrase(row, phrases, use_context=False)
    either = context or prefix
    # При слабом сигнале сохраняем готовую фразу в первой строке. Короткое
    # однословное дополнение по-прежнему может уступить место паре слов.
    protect_first = not context and bool(pool) and len(terms(pool[0])) >= 2
    return {
        "previous": pool,
        "context": promote(pool, context),
        "prefix": promote(pool, prefix),
        "either": promote(pool, either),
        "protected": promote(pool, either, int(protect_first)),
    }


def main():
    """Сохраняет списки и сводные попадания для рабочей выборки трёх языков."""
    protocol = read(OUT / "protocol.json")
    for name in ("development-inputs.json", "development-labels.json"):
        if (
            hashlib.sha256((OUT / name).read_bytes()).hexdigest()
            != protocol["sha256"][name]
        ):
            raise ValueError(f"Изменилась выборка {name}")
    rows = read(OUT / "development-inputs.json")
    base = read(OUT / "development-candidates.json")
    prior = read(OUT / "mail-development-candidates.json")
    outputs = {}
    for row in rows:
        key = row["id"]
        options = compare(row, base[key])
        if (
            options["either"] != prior[key]["document"]
            or options["previous"] != prior[key]["previous"]
        ):
            raise ValueError(f"Не воспроизведён предыдущий эксперимент для {key}")
        outputs[key] = options
    save(OUT / "document-signals-candidates.json", outputs)
    report = score(rows, outputs, read(OUT / "development-labels.json"))
    save(OUT / "document-signals-scores.json", report)


if __name__ == "__main__":
    main()
