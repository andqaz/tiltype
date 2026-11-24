"""Готовит текст для авторегрессионной модели продолжений TilType.

Отбирает проверяемую смесь общих предложений и диалогов по языкам.
Обучает общий Unicode-токенизатор, сохраняющий границы слов.
"""

import random
from collections.abc import Iterable
from pathlib import Path

from import_dialogues import held_out_runs
from sentence_data import dialogue_sentences, training_sentences
from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers

LANGUAGES = ("en", "ru", "kk")
WORD_BOUNDARY = "▁"
PAD, UNKNOWN, END = "<pad>", "<unk>", "<end>"
LANGUAGE_MARKERS = {language: f"<{language}>" for language in LANGUAGES}
SPECIAL_TOKENS = [PAD, UNKNOWN, END, *LANGUAGE_MARKERS.values()]
VOCABULARY_SIZE = 8_192
CONTEXT_TOKENS = 64
DOCUMENT_HISTORY_TOKENS = 72
SEED = 3_919


def reservoir(runs: Iterable[list[str]], limit: int, rng: random.Random,
              excluded: set[str]) -> list[str]:
    """Равномерно выбирает уникальные предложения в пределах одного источника."""
    sample: list[str] = []
    seen: set[str] = set()
    for run in runs:
        sentence = " ".join(run)
        if len(run) < 4 or sentence in excluded or sentence in seen:
            continue
        seen.add(sentence)
        if len(sample) < limit:
            sample.append(sentence)
        else:
            offset = rng.randrange(len(seen))
            if offset < limit:
                sample[offset] = sentence
    return sample


def sample_corpora(directory: Path, per_language: int) -> dict[str, list[str]]:
    """Отбирает фразы из обоих источников, исключая обе контрольные части."""
    rng = random.Random(SEED)
    corpora = {}
    for language in LANGUAGES:
        excluded = set(held_out_runs(language))
        dialogue = reservoir(dialogue_sentences(language, directory), per_language // 3, rng, excluded)
        excluded.update(dialogue)
        general = reservoir(training_sentences(language), per_language - len(dialogue), rng, excluded)
        corpora[language] = general + dialogue
        print(f"{language}: {len(general):,} general + {len(dialogue):,} dialogue sentences", flush=True)
    return corpora


def train_tokenizer(corpora: dict[str, list[str]]) -> Tokenizer:
    """Обучает BPE на объединённых RU, KK и EN корпусах."""
    tokenizer = Tokenizer(models.BPE(unk_token=UNKNOWN))
    # Сеттеры доступны в Tokenizers, хотя типы пакета описывают только геттеры.
    tokenizer.pre_tokenizer = pre_tokenizers.Metaspace(replacement=WORD_BOUNDARY)  # pyright: ignore[reportAttributeAccessIssue]
    tokenizer.decoder = decoders.Metaspace(replacement=WORD_BOUNDARY)  # pyright: ignore[reportAttributeAccessIssue]
    trainer = trainers.BpeTrainer(vocab_size=VOCABULARY_SIZE, min_frequency=4, special_tokens=SPECIAL_TOKENS,
                                  show_progress=False)
    tokenizer.train_from_iterator((text for texts in corpora.values() for text in texts), trainer=trainer)
    return tokenizer


def token_id(tokenizer: Tokenizer, token: str) -> int:
    """Возвращает идентификатор обязательного служебного токена."""
    identifier = tokenizer.token_to_id(token)
    if identifier is None:
        raise ValueError(f"Tokenizer has no required token {token}")
    return identifier


def tokenize_sentences(tokenizer: Tokenizer, texts: list[str], language: str) -> Iterable[list[int]]:
    """Выдаёт последовательности для обучения с меткой языка и концом фразы."""
    language_id, end_id = (token_id(tokenizer, token) for token in (LANGUAGE_MARKERS[language], END))
    for start in range(0, len(texts), 1024):
        for encoding in tokenizer.encode_batch(texts[start:start + 1024]):
            ids = encoding.ids
            while len(ids) > CONTEXT_TOKENS:
                cutoff = CONTEXT_TOKENS
                while cutoff > 0 and not encoding.tokens[(len(encoding.ids) - len(ids)) + cutoff].startswith(WORD_BOUNDARY):
                    cutoff -= 1
                cutoff = cutoff or CONTEXT_TOKENS
                yield [language_id, *ids[:cutoff]]
                ids = ids[cutoff:]
            if ids:
                yield [language_id, *ids, end_id]
