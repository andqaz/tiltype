"""Объединяет варианты регистра следующего слова для словаря TilType.

Контекст уже приведён к нижнему регистру сборщиком. Модуль объединяет
только идентификаторы продолжений и сохраняет засвидетельствованные формы.
"""

from collections import Counter, defaultdict


def following_word_forms(
    grams: Counter[int], words: list[str], token_mask: int
) -> tuple[list[int], dict[str, str]]:
    """Готовит соответствие идентификаторов и наиболее частое написание слова."""
    by_word = {word: index for index, word in enumerate(words)}
    normalized = [by_word[word.lower()] for word in words]
    forms: defaultdict[str, Counter[str]] = defaultdict(Counter)
    for gram, count in grams.items():
        word = words[gram & token_mask]
        forms[word.lower()][word] += count
    display = {
        key: min(variants, key=lambda word: (-variants[word], word != key, word))
        for key, variants in forms.items()
    }
    return normalized, display


def pool_following_words(grams: Counter[int], normalized: list[int], token_mask: int) -> Counter[int]:
    """Суммирует частоты продолжений, различавшихся только регистром."""
    pooled: Counter[int] = Counter()
    for gram, count in grams.items():
        normalized_word = normalized[gram & token_mask]
        pooled[(gram & ~token_mask) | normalized_word] += count
    return pooled
