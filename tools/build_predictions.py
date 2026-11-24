"""Обучает локальный прогноз по Leipzig Corpora Collection, Tatoeba и KazNERD.

Считает продолжения для контекстов от одного до шести слов, оставляет
устойчивые варианты и записывает словари, которые загружает плагин.
"""

import argparse
import bz2
import json
import re
import tarfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from itertools import chain
from pathlib import Path
from zlib import crc32

from build_dictionaries import CORPORA, DOWNLOADS, ROOT, download
from prediction_case import following_word_forms, pool_following_words
from prediction_previous_ending import previous_ending_predictions
from prediction_starts import count_starts, select_starts

TATOEBA = "https://downloads.tatoeba.org/exports/per_language"
KAZNERD = "https://raw.githubusercontent.com/IS2AI/KazNERD/bd4333d0f5952b9fafb2ef2ac2fefa0ad3c0333f/KazNERD"
KAZAKH_START_CORPUS = "kaz_wikipedia_2014_300K"
KAZAKH_EXTRA_CORPUS = "kaz_wikipedia_2010_100K"
WIKIPEDIA_CORPORA = {
    "en": "eng_wikipedia_2016_300K",
    "ru": "rus_wikipedia_2021_300K",
    "kk": KAZAKH_START_CORPUS,
}
ADDITIONAL_CONTEXT_CORPORA = {
    "en": "eng_news_2024_100K",
    "ru": "rus_news_2024_100K",
    "kk": "kaz_wikipedia_2021_100K",
}
LANGUAGES = {"en": "eng", "ru": "rus", "kk": "kaz"}
ALPHABETS = {"en": "a-z", "ru": "а-яё", "kk": "а-яёәғқңөұүһі"}
WORD = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*")
MAX_WORD_LENGTH = 32
HOLDOUT_PERIOD = 16
# Плотные целочисленные ключи сокращают память при подсчёте миллионов сочетаний.
TOKEN_BITS = 21
TOKEN_MASK = (1 << TOKEN_BITS) - 1
# Длина контекста, минимальная частота продолжения, доля и верхний предел записей.
ORDERS = (
    (1, 3, 0.15, 35_000),
    (2, 3, 0.22, 100_000),
    (3, 3, 0.32, 100_000),
    (4, 3, 0.40, 150_000),
    (5, 3, 0.44, 150_000),
    (6, 3, 0.48, 120_000),
)
# Для длинных сочетаний слабое продолжение должно встречаться чаще случайного.
BACKOFF_SHARE = {1: 0, 2: 0.08, 3: 0.14, 4: 0.20, 5: 0.25, 6: 0.30}
BACKOFF_LIMIT = {2: 120_000, 3: 120_000, 4: 80_000, 5: 65_000, 6: 50_000}
SKIP_ORDERS = ((1, 6, 0.27, 100_000), (2, 7, 0.29, 75_000))
CONTEXT_ENDING_LENGTH = 3
ENDING_CONTEXT = ("+", 2, 5, 0.26, 125_000)
ANCHORED_CONTEXT = ("?", 3, 5, 0.40, 120_000)
SUFFIX_LENGTHS = (2, 3, 4)
COMMON_PHRASES = {
    "en": {
        "as soon as": "possible",
        "for more information": "please",
        "i look forward": "to",
        "i would like": "to",
        "nice to": "meet",
        "please let me": "know",
        "please see the": "attached",
        "see you": "soon",
        "thank": "you",
        "thank you": "for",
    },
    "ru": {
        "благодарю вас за": "помощь",
        "в соответствии с": "требованиями",
        "довожу до вашего": "сведения",
        "доброе": "утро",
        "добрый": "день",
        "на основании вышеизложенного": "прошу",
        "обращаю ваше внимание": "на",
        "по итогам совещания": "принято",
        "просим вас предоставить": "документы",
        "с днем": "рождения",
        "с днём": "рождения",
    },
    "kk": {
        "алдын ала": "рақмет",
        "көп": "рақмет",
        "назар аударғаныңызға": "рақмет",
        "осы мәселе бойынша": "ұсыныс",
        "осыған байланысты": "сізден",
        "сізге зор": "денсаулық",
        "туған": "күніңізбен",
        "қайырлы": "таң",
        "қазақстан республикасының еңбек": "кодексі",
        "қосымша ақпарат алу": "үшін",
    },
}


def corpus_sentences(language: str) -> Iterator[str]:
    """Читает предложения из лицензированных исходных архивов для выбранного языка."""
    for corpus in CORPORA[language][1]:
        yield from leipzig_sentences(corpus)


def leipzig_sentences(corpus: str) -> Iterator[str]:
    """Последовательно читает таблицу предложений одного корпуса Leipzig."""
    archive_path = download(f"{DOWNLOADS}/{corpus}.tar.gz")
    filename = f"{corpus}-sentences.txt"
    with tarfile.open(archive_path, "r|gz") as archive:
        for entry in archive:
            if entry.name not in (filename, f"{corpus}/{filename}"):
                continue
            sentences = archive.extractfile(entry)
            if sentences is None:
                raise ValueError(f"Unable to read sentences in {archive_path}")
            with sentences:
                for raw in sentences:
                    yield raw.decode("utf-8").partition("\t")[2].strip()
            return
    raise ValueError(f"Missing sentences in {archive_path}")


def tatoeba_sentences(language: str) -> Iterator[str]:
    """Читает учебные и разговорные примеры из языкового экспорта Tatoeba."""
    code = LANGUAGES[language]
    source = download(f"{TATOEBA}/{code}/{code}_sentences.tsv.bz2")
    with bz2.open(source, "rt", encoding="utf-8") as sentences:
        for line in sentences:
            _, row_code, sentence = line.rstrip("\r\n").split("\t", 2)
            if row_code == code:
                yield sentence.strip()


def kaznerd_sentences() -> Iterator[str]:
    """Восстанавливает предложения из токенов теленовостей, пропуская метки сущностей."""
    for split in ("train", "valid", "test"):
        source = download(f"{KAZNERD}/IOB2_{split}.txt")
        with source.open(encoding="utf-8") as lines:
            words: list[str] = []
            for line in lines:
                fields = line.split()
                if fields:
                    words.append(fields[0])
                elif words:
                    yield " ".join(words)
                    words.clear()
            if words:
                yield " ".join(words)


def sentence_id(sentence: str) -> int:
    """Назначает стабильный идентификатор для дедупликации и отложенной выборки."""
    return crc32(" ".join(sentence.casefold().split()).encode("utf-8"))


def word_runs(sentence: str, allowed: re.Pattern[str]) -> Iterator[list[str]]:
    """Разбивает предложение по знакам и смене алфавита, сохраняя составные слова."""
    run: list[str] = []
    end = 0
    for match in WORD.finditer(sentence):
        word = match.group().replace("’", "'")
        if run and not sentence[end:match.start()].isspace():
            yield run
            run = []
        end = match.end()
        if len(word) <= MAX_WORD_LENGTH and allowed.fullmatch(word.lower()):
            run.append(word)
        elif run:
            yield run
            run = []
    if run:
        yield run


def count_grams(
    language: str, allowed: re.Pattern[str], *, wikipedia: str | None = None
) -> tuple[tuple[Counter[int], ...], dict[int, Counter[int]], Counter[int], list[str], dict[str, str], int]:
    """Считает базовую модель либо только последовательные сочетания с Википедией."""
    grams: tuple[Counter[int], ...] = tuple(Counter() for _ in ORDERS)
    skipped: dict[int, Counter[int]] = {gap: Counter() for gap, *_ in SKIP_ORDERS}
    extra: Counter[int] = Counter()
    pair_mask = (1 << (2 * TOKEN_BITS)) - 1
    history_mask = (1 << (len(grams) * TOKEN_BITS)) - 1
    windows = tuple(zip(((1 << ((order + 1) * TOKEN_BITS)) - 1 for order, *_ in ORDERS), grams))
    words = [""]
    ids: dict[str, int] = {}
    seen: set[int] = set()
    starts: defaultdict[str, Counter[str]] = defaultdict(Counter)

    def token(word: str) -> int:
        index = ids.get(word)
        if index is None:
            index = len(words)
            if index > TOKEN_MASK:
                raise ValueError("Prediction vocabulary exceeds token capacity")
            ids[word] = index
            words.append(word)
        return index

    sources: list[Iterable[str]] = [corpus_sentences(language)]
    if wikipedia:
        sources.append(leipzig_sentences(wikipedia))
    sources.append(tatoeba_sentences(language))
    if language == "kk":
        sources.append(kaznerd_sentences())
    for source in sources:
        for sentence in source:
            ident = sentence_id(sentence)
            if ident % HOLDOUT_PERIOD == 0 or ident in seen:
                continue
            seen.add(ident)
            for run in word_runs(sentence, allowed):
                if not wikipedia:
                    count_starts(run, starts)
                history = 0
                for index, word in enumerate(run):
                    shifted = history << TOKEN_BITS
                    continuation = shifted | token(word)
                    active_windows = windows[1:index] if wikipedia else windows[:index]
                    for mask, counter in active_windows:
                        counter[continuation & mask] += 1
                    if wikipedia:
                        history = (shifted | token(word.lower())) & history_mask
                        continue
                    for gap, counter in skipped.items():
                        if index < gap + 2:
                            break
                        # Правое слово остаётся у курсора, левое отстоит на заданный пропуск.
                        left = (history >> ((gap + 1) * TOKEN_BITS)) & TOKEN_MASK
                        right = history & TOKEN_MASK
                        key = (left << (2 * TOKEN_BITS)) | (right << TOKEN_BITS) | (continuation & TOKEN_MASK)
                        counter[key] += 1
                    if language == "kk" and index >= 2:
                        last_word = words[history & TOKEN_MASK]
                        if len(last_word) > CONTEXT_ENDING_LENGTH:
                            previous = (history >> TOKEN_BITS) & TOKEN_MASK
                            ending = token(last_word[-CONTEXT_ENDING_LENGTH:])
                            key = (previous << (2 * TOKEN_BITS)) | (ending << TOKEN_BITS) | (continuation & TOKEN_MASK)
                            extra[key] += 1
                    elif language != "kk" and index >= 4:
                        anchor = (history >> (3 * TOKEN_BITS)) & TOKEN_MASK
                        key = (anchor << (3 * TOKEN_BITS)) | ((history & pair_mask) << TOKEN_BITS) | (continuation & TOKEN_MASK)
                        extra[key] += 1
                    history = (shifted | token(word.lower())) & history_mask
    if wikipedia:
        return grams, skipped, extra, words, {}, len(seen)
    initial = select_starts(starts)
    for key, word in select_starts(starts, expanded=True).items():
        initial.setdefault(key, word)
    if language == "kk":
        for sentence in leipzig_sentences(KAZAKH_START_CORPUS):
            ident = sentence_id(sentence)
            if ident % HOLDOUT_PERIOD == 0 or ident in seen:
                continue
            seen.add(ident)
            for run in word_runs(sentence, allowed):
                count_starts(run, starts)
        for key, word in select_starts(starts, expanded=True).items():
            initial.setdefault(key, word)
    return grams, skipped, extra, words, initial, len(seen)


def select_predictions(grams: Counter[int], words: list[str], order: int, minimum: int,
                       share: float, limit: int) -> tuple[dict[str, str], dict[str, str], dict[str, str], str]:
    """Разделяет уверенные прогнозы, редкие сочетания и прогнозы по окончаниям."""
    totals: Counter[int] = Counter()
    best: dict[int, tuple[int, int]] = {}
    continuation_counts: Counter[str] = Counter()
    while grams:
        gram, count = grams.popitem()
        context = gram >> TOKEN_BITS
        totals[context] += count
        word = gram & TOKEN_MASK
        if order == 1 and words[word].islower():
            continuation_counts[words[word]] += count
        if count < (2 if order == 1 else minimum):
            continue
        best_count, best_word = best.get(context, (0, 0))
        if count > best_count or (count == best_count and words[word] < words[best_word]):
            best[context] = (count, word)

    candidates: list[tuple[int, float, str, str]] = []
    backoff: list[tuple[int, float, str, str]] = []
    suffix_votes: dict[str, Counter[str]] = {}
    for context, (count, word) in best.items():
        confidence = count / totals[context]
        precise = count >= minimum and confidence >= share
        if not precise and confidence < BACKOFF_SHARE[order]:
            continue
        key_words = []
        for _ in range(order):
            key_words.append(words[context & TOKEN_MASK])
            context >>= TOKEN_BITS
        key = " ".join(reversed(key_words))
        entry = (count, confidence, key, words[word])
        if precise:
            candidates.append(entry)
        else:
            backoff.append(entry)
        if order == 1 and count >= minimum and len(key) >= 4:
            # Учитываем разные словоформы, чтобы одно частое слово не определяло окончание.
            for length in SUFFIX_LENGTHS:
                if len(key) > length:
                    votes = suffix_votes.setdefault(key[-length:], Counter())
                    votes[words[word]] += min(count, 10)
    candidates.sort(key=lambda item: (-item[0], -item[1], item[2]))
    precise_predictions = {key: word for _, _, key, word in candidates[:limit]}
    backoff.extend(candidates[limit:])
    if order in BACKOFF_LIMIT:
        backoff.sort(key=lambda item: (-item[0], -item[1], item[2]))
        backoff = backoff[:BACKOFF_LIMIT[order]]
    relaxed = {key: word for _, _, key, word in backoff}
    suffixes = {suffix: min(votes, key=lambda word: (-votes[word], word)) for suffix, votes in suffix_votes.items()
                if votes.total() >= 12}
    default_word = min(continuation_counts, key=lambda word: (-continuation_counts[word], word), default="")
    return precise_predictions, relaxed, suffixes, default_word


def add_wikipedia_phrases(
    language: str, allowed: re.Pattern[str], predictions: dict[str, str], relaxed: dict[str, str],
    *, corpus: str | None = None,
) -> None:
    """Добавляет отсутствующие фразы из модели с расширенным набором корпусов."""
    grams, _, _, words, _, _ = count_grams(language, allowed, wikipedia=corpus or WIKIPEDIA_CORPORA[language])
    for order_data, settings in zip(grams[1:], ORDERS[1:]):
        phrases, reserve, _, _ = select_predictions(order_data, words, *settings)
        for phrase, word in phrases.items():
            if phrase not in relaxed:
                predictions.setdefault(phrase, word)
        if language != "kk":
            for phrase, word in reserve.items():
                if phrase not in predictions:
                    relaxed.setdefault(phrase, word)


def previous_ending_runs(language: str, allowed: re.Pattern[str]) -> Iterator[list[str]]:
    """Возвращает фрагменты Tatoeba и KazNERD без дубликатов и отложенных предложений."""
    sentences = tatoeba_sentences(language)
    if language == "kk":
        sentences = chain(sentences, kaznerd_sentences())
    seen: set[int] = set()
    for sentence in sentences:
        identifier = sentence_id(sentence)
        if identifier % HOLDOUT_PERIOD == 0 or identifier in seen:
            continue
        seen.add(identifier)
        yield from word_runs(sentence.lower(), allowed)


def train(language: str, directory: Path) -> None:
    """Обучает модель языка и пишет её в формат, читаемый фоновым плагином."""
    letters = f"[{ALPHABETS[language]}]+"
    allowed = re.compile(rf"{letters}(?:['-]{letters})*")
    grams, skipped, extra, words, starts, sentence_count = count_grams(language, allowed)
    normalized, display = following_word_forms(grams[0], words, TOKEN_MASK)
    predictions: dict[str, str] = {}
    additional: dict[str, str] = {}
    relaxed: dict[str, str] = {}
    suffixes: dict[str, str] = {}
    default_word = ""
    for order_data, settings in zip(grams, ORDERS):
        pooled = pool_following_words(order_data, normalized, TOKEN_MASK)
        order_predictions, order_backoff, order_suffixes, order_default = select_predictions(order_data, words, *settings)
        pooled_predictions, _, _, _ = select_predictions(pooled, words, *settings)
        predictions.update(order_predictions)
        additional.update(pooled_predictions)
        relaxed.update(order_backoff)
        if order_suffixes:
            suffixes = order_suffixes
            default_word = order_default
        print(f"{language}, context {settings[0]}: {len(order_predictions):,}", flush=True)
    predictions.update(starts)
    for phrase, word in COMMON_PHRASES[language].items():
        predictions[phrase] = word
        initial_key = "^" + phrase
        if initial_key in starts:
            predictions[initial_key] = word
    if not default_word:
        raise ValueError(f"Missing default prediction for {language}")
    # Объединение регистра добавляет новые варианты, сохраняя ранее выбранные продолжения.
    for key, word in additional.items():
        if key not in predictions and key not in relaxed:
            predictions[key] = display.get(word, word)
    for key in predictions:
        relaxed.pop(key, None)
    for gap, minimum, share, limit in SKIP_ORDERS:
        skip_predictions, _, _, _ = select_predictions(skipped[gap], words, 2, minimum, share, limit)
        relaxed.update(("~" * gap + phrase, word) for phrase, word in skip_predictions.items())
    marker, order, minimum, share, limit = ENDING_CONTEXT if language == "kk" else ANCHORED_CONTEXT
    extra_predictions, _, _, _ = select_predictions(extra, words, order, minimum, share, limit)
    relaxed.update((marker + phrase, word) for phrase, word in extra_predictions.items())
    add_wikipedia_phrases(language, allowed, predictions, relaxed)
    if language == "kk":
        add_wikipedia_phrases(language, allowed, predictions, relaxed, corpus=KAZAKH_EXTRA_CORPUS)
    add_wikipedia_phrases(language, allowed, predictions, relaxed, corpus=ADDITIONAL_CONTEXT_CORPORA[language])
    relaxed.update(previous_ending_predictions(previous_ending_runs(language, allowed)))
    models = {
        f"predict-{language}.json": predictions,
        f"predict-{language}-fallback.json": {"contexts": relaxed, "suffixes": suffixes, "defaultWord": default_word},
    }
    for name, data in models.items():
        (directory / name).write_text(
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n"
        )
    print(f"{language}: {len(predictions):,} precise, {len(relaxed):,} fallback, "
          f"{len(suffixes):,} suffixes from {sentence_count:,} sentences", flush=True)


def main() -> None:
    """Строит модели всех языков или одного языка по аргументу командной строки."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=LANGUAGES)
    parser.add_argument("--output", type=Path, default=ROOT / "plugin" / "dictionaries")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for language in (args.language,) if args.language else LANGUAGES:
        train(language, args.output)


if __name__ == "__main__":
    main()
