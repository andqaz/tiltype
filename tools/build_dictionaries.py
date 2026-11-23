"""Формирует локальные словари плагина из частотных списков Leipzig Corpora Collection.

Загруженные архивы хранятся в .cache. Из архивов читаются только файлы частот.
"""

import re
import shutil
import tarfile
from collections import Counter, defaultdict
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
DOWNLOADS = "https://downloads.wortschatz-leipzig.de/corpora"
SUBTITLE_LISTS = "https://raw.githubusercontent.com/hermitdave/FrequencyWords/525f9b560de45753a5ea01069454e72e9aa541c6/content/2018"
MAX_WORDS = 150_000
CORPORA = {
    "en": (r"[a-z]{4,}", ("eng_news_2024_300K", "eng_news_2023_300K")),
    "ru": (r"[а-яё]{4,}", ("rus_news_2024_300K", "rus_news_2023_300K")),
    "kk": (
        r"[а-яёәғқңөұүһі]{4,}",
        ("kaz_news_2020_30K", "kaz_wikipedia_2021_300K", "kaz_wikipedia_2016_300K"),
    ),
}


def download(url: str) -> Path:
    """Загружает источник в кэш и возвращает путь к готовому файлу."""
    cached = ROOT / ".cache" / url.rsplit("/", 1)[-1]
    if not cached.exists():
        cached.parent.mkdir(exist_ok=True)
        partial = cached.with_suffix(".part")
        with urlopen(url, timeout=120) as response:
            with partial.open("wb") as output:
                shutil.copyfileobj(response, output)
        partial.replace(cached)
    return cached


def load_counts(corpus: str, alphabet: str) -> Counter[str]:
    """Считает частоты однородных словоформ после приведения к нижнему регистру."""
    archive = download(f"{DOWNLOADS}/{corpus}.tar.gz")
    counts: Counter[str] = Counter()
    with tarfile.open(archive, "r:gz") as source:
        member = source.extractfile(f"{corpus}/{corpus}-words.txt")
        if member is None:
            raise ValueError(f"Missing word list in {archive}")
        with member:
            for line in member:
                _, word, frequency = line.decode("utf-8").rstrip("\r\n").split("\t")
                word = word.lower()
                if re.fullmatch(alphabet, word):
                    counts[word] += int(frequency)
    return counts


def load_subtitles(language: str, alphabet: str) -> Counter[str]:
    """Добавляет частоты разговорной лексики из списка субтитров."""
    source = download(f"{SUBTITLE_LISTS}/{language}/{language}_50k.txt")
    counts: Counter[str] = Counter()
    for line in source.read_text(encoding="utf-8").splitlines():
        word, frequency = line.rsplit(" ", 1)
        if re.fullmatch(alphabet, word):
            counts[word] += int(frequency)
    return counts


def main() -> None:
    """Записывает по одному UTF-8 словарю на язык в порядке убывания частоты."""
    output = ROOT / "plugin" / "dictionaries"
    output.mkdir(parents=True, exist_ok=True)
    for language, (alphabet, corpora) in CORPORA.items():
        scores: defaultdict[str, float] = defaultdict(float)
        sources = [load_counts(corpus, alphabet) for corpus in corpora]
        if language in ("ru", "en"):
            sources.append(load_subtitles(language, alphabet))
        for counts in sources:
            total = counts.total()
            # Приводим частоты к одному масштабу, чтобы объём корпуса не определял его вклад.
            for word, count in counts.items():
                scores[word] += count / total
        words = sorted(scores, key=lambda word: (-scores[word], word))[:MAX_WORDS]
        (output / f"{language}.txt").write_text("\n".join(words) + "\n", encoding="utf-8", newline="\n")
        print(f"{language}: {len(words):,}")


if __name__ == "__main__":
    main()
