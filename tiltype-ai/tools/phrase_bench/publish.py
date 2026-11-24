"""Упаковывает результаты стенда в автономный HTML для просмотра без сети."""

from evaluate import hits
from panel import HERE, OUT, read


def publish(split="development"):
    """Связывает видимый контекст, эталоны и списки источников по ключу курсора."""
    import json

    rows = read(OUT / f"{split}-inputs.json")
    labels = read(OUT / f"{split}-labels.json")
    outputs = read(OUT / f"{split}-candidates.json")
    data = []
    for row in rows:
        label = labels[row["id"]]
        result = outputs[row["id"]]
        pool = result["pool"]
        status = (
            "first"
            if hits(pool[:1], label["pair"])
            else "below_first"
            if hits(pool, label["pair"])
            else "cut_at_merge"
            if any(
                hits(options, label["pair"]) for options in result["sources"].values()
            )
            else "absent"
        )
        data.append(
            {k: row[k] for k in ("id", "lang", "genre", "mode", "typed", "paired")}
            | {
                "context": (row["history"] + row["before"])[-650:],
                "verified": result["priorOffered"],
                "future": label["future"],
                "sources": result["sources"],
                "pool": pool,
                "status": status,
            }
        )
    stamp = read(OUT / "protocol.json")["sha256"][f"{split}-inputs.json"]
    folder = HERE / "viewer"
    html = (folder / "index.html").read_text(encoding="utf-8-sig")
    html = html.replace(
        "/* STYLES */", (folder / "style.css").read_text(encoding="utf-8-sig")
    )
    html = html.replace(
        "/* LOGIC */", (folder / "review.js").read_text(encoding="utf-8-sig")
    )
    payload = json.dumps(
        {"stamp": stamp, "rows": data}, ensure_ascii=False, separators=(",", ":")
    ).replace("<", "\\u003c")
    (OUT / f"{split}-review.html").write_text(
        html.replace("JSON_DATA", payload), encoding="utf8"
    )


if __name__ == "__main__":
    publish()
