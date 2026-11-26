"""Упаковывает опубликованный каталог desktop в установочный файл ONLYOFFICE.

Проверяет структуру и целостность архива перед заменой итогового файла.
Время записей фиксировано для воспроизводимости локальной сборки.
"""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]


def build():
    """Записывает dist/tiltype.plugin и выдаёт ошибку при неполном пакете."""
    source = ROOT / "desktop"
    destination = ROOT / "dist/tiltype.plugin"
    destination.parent.mkdir(exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    with ZipFile(temporary, "w") as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                entry = ZipInfo(path.relative_to(source).as_posix())
                archive.writestr(entry, path.read_bytes(), compress_type=ZIP_DEFLATED)
    with ZipFile(temporary) as archive:
        required = {"config.json", "index.html", "models/writer.fp16", "runtime/decoder.wasm"}
        if not required.issubset(archive.namelist()) or archive.testzip():
            raise ValueError("Invalid desktop package")
    temporary.replace(destination)


if __name__ == "__main__":
    build()
