"""Реализует компактную авторегрессионную модель для обучения и стенда TilType.

GRU хранит состояние контекста между подсловами. Во время генерации
поиск учитывает вероятность всей фразы и возвращает законченные слова.
"""

from dataclasses import dataclass
from math import log

import torch
from subword_data import (
    CONTEXT_TOKENS,
    DOCUMENT_HISTORY_TOKENS,
    END,
    LANGUAGE_MARKERS,
    PAD,
    SPECIAL_TOKENS,
    WORD_BOUNDARY,
    token_id,
)
from tokenizers import Tokenizer
from torch import nn

EMBEDDING_SIZE = 128
HIDDEN_SIZE = 192
BEAM_WIDTH = 4
MAX_NEW_TOKENS = 16
MAX_SUGGESTIONS = 3
PHRASE_WORDS = 3
MIN_WORD_END_LOG_PROBABILITY = log(0.08)
MIN_EXTENSION_LOG_PROBABILITY = log(0.10)


class SubwordModel(nn.Module):
    """Оценивает вероятность следующего подслова по всему префиксу."""

    def __init__(self, vocabulary_size: int, padding: int, hidden_size: int = HIDDEN_SIZE) -> None:
        super().__init__()
        self.embedding = nn.Embedding(vocabulary_size, EMBEDDING_SIZE, padding_idx=padding)
        self.recurrent = nn.GRU(EMBEDDING_SIZE, hidden_size, batch_first=True)
        self.output = nn.AdaptiveLogSoftmaxWithLoss(hidden_size, vocabulary_size, [512, 2_048])

    def forward(self, inputs: torch.Tensor, targets: torch.Tensor, padding: int) -> torch.Tensor:
        """Считает среднюю потерю только по реальным токенам последовательностей."""
        features, _ = self.recurrent(self.embedding(inputs))
        valid = targets != padding
        return self.output(features[valid], targets[valid]).loss


@dataclass(frozen=True)
class Beam:
    """Один путь генерации с накопленной логарифмической вероятностью."""

    tokens: tuple[int, ...]
    score: float
    word_count: int
    state: torch.Tensor
    logits: torch.Tensor


class PhrasePredictor:
    """Генерирует и упорядочивает короткие продолжения без словаря ответов."""

    def __init__(self, model: SubwordModel, tokenizer: Tokenizer) -> None:
        self.model = model.eval()
        self.tokenizer = tokenizer
        self.padding = token_id(tokenizer, PAD)
        self.end = token_id(tokenizer, END)
        self.special = [token_id(tokenizer, token) for token in SPECIAL_TOKENS if token != END]
        self.word_starts = torch.tensor([
            (tokenizer.id_to_token(index) or "").startswith(WORD_BOUNDARY)
            for index in range(tokenizer.get_vocab_size())
        ])
        self.word_ends = self.word_starts.clone()
        self.word_ends[self.end] = True

    def next_tokens(self, tokens: torch.Tensor, state: torch.Tensor | None = None) -> tuple[torch.Tensor, torch.Tensor]:
        """Выдаёт состояние GRU и оценки подслов после пакета префиксов."""
        features, next_state = self.model.recurrent(self.model.embedding(tokens), state)
        return next_state, self.model.output.log_prob(features[:, -1])

    @staticmethod
    def rank_completions(completed: dict[str, float]) -> list[str]:
        """Ранжирует первые слова и добавляет только уверенные продолжения."""
        first_scores = {word: score for word, score in completed.items() if " " not in word}
        leaders = sorted(first_scores, key=first_scores.__getitem__, reverse=True)[:MAX_SUGGESTIONS]
        extensions = {first: (MIN_EXTENSION_LOG_PROBABILITY, first) for first in leaders}
        for phrase, score in completed.items():
            words = phrase.split()
            first = words[0]
            if len(words) < 2 or first not in extensions:
                continue
            conditional_score = (score - first_scores[first]) / (len(words) - 1)
            best_score, best_phrase = extensions[first]
            if conditional_score > best_score or (conditional_score == best_score and len(phrase) > len(best_phrase)):
                extensions[first] = conditional_score, phrase
        return [extensions[first][1] for first in leaders]

    @torch.inference_mode()
    def suggest(self, prefix: str, language: str, history: tuple[str, ...] = (), *, constraint=None) -> list[str]:
        """Возвращает до трёх продолжений по префиксу и необязательной истории."""
        encoding = self.tokenizer.encode(prefix)
        actual = encoding.ids[-CONTEXT_TOKENS:]
        start = token_id(self.tokenizer, LANGUAGE_MARKERS[language])
        previous = [token for sentence in self.tokenizer.encode_batch(list(history))
                    for token in (*sentence.ids, self.end)]
        state, logits = self.next_tokens(torch.tensor([[start, *previous[-DOCUMENT_HISTORY_TOKENS:], *actual]]))
        beams = [Beam((), 0.0, 0, state, logits[0])]
        complete: dict[str, float] = {}
        for _ in range(MAX_NEW_TOKENS):
            proposed: list[tuple[float, Beam, int, int]] = []
            for beam in beams:
                scores = beam.logits.clone()
                scores[self.special] = -torch.inf
                if beam.tokens:
                    end_probability = float(torch.logsumexp(scores[self.word_ends], dim=0))
                    if end_probability >= MIN_WORD_END_LOG_PROBABILITY:
                        phrase = self.tokenizer.decode(list(beam.tokens)).strip()
                        if phrase and (constraint is None or constraint.accepts(phrase)):
                            score = beam.score + end_probability
                            complete[phrase] = max(complete.get(phrase, -float("inf")), score)
                    if beam.word_count == PHRASE_WORDS:
                        scores[self.word_starts] = -torch.inf
                else:
                    scores[~self.word_starts] = -torch.inf
                scores[self.end] = -torch.inf
                if constraint is not None:
                    constraint.restrict(scores, beam.tokens)
                values, indices = scores.topk(BEAM_WIDTH)
                for value, token in zip(values.tolist(), indices.tolist(), strict=True):
                    if value != -float("inf"):
                        word_count = beam.word_count + int(self.word_starts[token])
                        proposed.append((beam.score + value, beam, token, word_count))
            if not proposed:
                break
            proposal = sorted(proposed, key=lambda item: item[0], reverse=True)[:BEAM_WIDTH]
            state, logits = self.next_tokens(
                torch.tensor([[token] for _, _, token, _ in proposal]),
                torch.cat([beam.state for _, beam, _, _ in proposal], dim=1),
            )
            beams = [
                Beam((*beam.tokens, token), score, word_count, state[:, index:index + 1], logits[index])
                for index, (score, beam, token, word_count) in enumerate(proposal)
            ]
        return self.rank_completions(complete)
