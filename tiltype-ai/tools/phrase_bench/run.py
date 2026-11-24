"""Запускает поиск без правого контекста и сравнивает с упаковкой TilType.

Сохраняет варианты всех источников до открытия эталонов. Итоговая панель
оценивается только при прохождении порога на русском и казахском.
"""

import argparse
import hashlib
import subprocess
import tempfile
import zipfile

from evaluate import evaluate
from panel import CORPUS, HERE, LANGS, OUT, ROOT, read, save
from panel import main as prepare
from publish import publish
from sources import CorpusIndex, document_candidates, merge


def candidates(split, package):
    """Извлекает кандидатов для всех видимых входов и сохраняет их происхождение."""
    inputs = OUT / f"{split}-inputs.json"
    rows = read(inputs)
    target = OUT / f"{split}-baseline.json"
    subprocess.run(
        ["node", str(HERE / "baseline.cjs"), str(package), str(inputs), str(target)],
        check=True,
    )
    baseline = read(target)
    index = CorpusIndex(rows)
    output = {}
    for row in rows:
        base = baseline[row["id"]]
        sources = {
            "plugin": base["choices"],
            "corpus": index.candidates(row),
            "document": document_candidates(row),
        }
        pool = merge(list(sources.values()))
        output[row["id"]] = {
            "sources": sources,
            "pool": pool,
            "priorOffered": base["priorOffered"],
        }
    save(OUT / f"{split}-candidates.json", output)


def main():
    """Проверяет архив, фиксирует выборки и применяет заранее определённый порог."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--package", default=str(ROOT / "dist/tiltype-ai-unified.plugin")
    )
    args = parser.parse_args()
    prepare()
    archive = ROOT / args.package
    protocol = read(OUT / "protocol.json")
    protocol["trainingManifest"] = read(CORPUS / "manifest.json")["uncompressedSha256"][
        "train"
    ]
    protocol["packageSHA256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(dir=OUT) as tmp, zipfile.ZipFile(archive) as z:
        z.extractall(tmp)
        for split in ("development", "test"):
            candidates(split, tmp)
            result = evaluate(split)
            publish(split)
            print(split, {l: result["groups"][l]["deltaPP"] for l in LANGS}, flush=True)
            if split == "development":
                protocol["developmentGatePassed"] = all(
                    result["groups"][l]["deltaPP"] >= protocol["pairPoolGatePP"]
                    for l in ("ru", "kk")
                )
                if not protocol["developmentGatePassed"]:
                    break
    save(OUT / "protocol.json", protocol)


if __name__ == "__main__":
    main()
