"""Обучает собственную компактную модель продолжения TilType Phrases.

Хранит токенизатор и веса отдельно от стабильных пакетов. Можно обучать
на CPU или CUDA. Генерация на стенде всегда проверяется на CPU.
"""

import argparse
import random
from collections.abc import Iterator
from pathlib import Path
from time import perf_counter

import torch
from subword_data import (
    PAD,
    SEED,
    sample_corpora,
    token_id,
    tokenize_sentences,
    train_tokenizer,
)
from subword_model import SubwordModel
from tokenizers import Tokenizer
from torch.nn.utils import clip_grad_norm_
from torch.nn.utils.rnn import pad_sequence

BATCH_SIZE = 128
LENGTH_BUCKET_BATCHES = 32
LEARNING_RATE = 0.002


def batches(rows: list[torch.Tensor], rng: random.Random) -> Iterator[list[torch.Tensor]]:
    """Объединяет близкие длины, сохраняя случайный порядок пакетов."""
    rng.shuffle(rows)
    bucket_size = BATCH_SIZE * LENGTH_BUCKET_BATCHES
    for start in range(0, len(rows), bucket_size):
        ordered = sorted(rows[start:start + bucket_size], key=len)
        group = [ordered[offset:offset + BATCH_SIZE] for offset in range(0, len(ordered), BATCH_SIZE)]
        rng.shuffle(group)
        yield from group


def train_epoch(model: SubwordModel, optimizer: torch.optim.Optimizer, rows: list[torch.Tensor],
                padding: int, device: str, rng: random.Random) -> float:
    """Выполняет проход по корпусу и возвращает среднюю потерю на подслово."""
    total = 0.0
    tokens = 0
    for index, samples in enumerate(batches(rows, rng), 1):
        values = pad_sequence(samples, batch_first=True, padding_value=padding).to(device, non_blocking=True)
        count = sum(len(sample) - 1 for sample in samples)
        optimizer.zero_grad(set_to_none=True)
        loss = model(values[:, :-1], values[:, 1:], padding)
        loss.backward()
        clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        total += float(loss.detach()) * count
        tokens += count
        if index % 250 == 0:
            print(f"{index:,} batches, {tokens:,} subword targets, loss {total / tokens:.4f}", flush=True)
    return total / tokens


def main() -> None:
    """Готовит данные, обучает модель и сохраняет проверяемый снимок весов."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dialogues", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sentences-per-language", type=int, default=100_000)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--resume-from", type=Path, help="Load a previous model and its tokenizer")
    parser.add_argument("--learning-rate", type=float, default=LEARNING_RATE)
    args = parser.parse_args()
    if min(args.sentences_per_language, args.epochs, args.threads) < 1:
        parser.error("Training volume, epochs and threads must be positive")
    if args.device == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA is unavailable in this PyTorch environment")
    if not 0 < args.learning_rate < 1:
        parser.error("Learning rate must be between zero and one")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(SEED)
    corpora = sample_corpora(args.dialogues, args.sentences_per_language)
    tokenizer = (Tokenizer.from_file(str(args.resume_from / "tokenizer.json")) if args.resume_from
                 else train_tokenizer(corpora))
    args.output.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(args.output / "tokenizer.json"))
    rows = [torch.tensor(ids, dtype=torch.long) for language, texts in corpora.items()
            for ids in tokenize_sentences(tokenizer, texts, language)]
    padding = token_id(tokenizer, PAD)
    model = SubwordModel(tokenizer.get_vocab_size(), padding).to(args.device)
    if args.resume_from:
        weights = torch.load(args.resume_from / "model.pt", weights_only=True, map_location=args.device)
        model.load_state_dict(weights)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    rng = random.Random(SEED)
    print(f"{len(rows):,} sequences, {sum(len(row) - 1 for row in rows):,} subword targets", flush=True)
    for index in range(1, args.epochs + 1):
        started = perf_counter()
        loss = train_epoch(model, optimizer, rows, padding, args.device, rng)
        temporary = args.output / "model.tmp"
        torch.save(model.state_dict(), temporary)
        temporary.replace(args.output / "model.pt")
        print(f"epoch {index}: loss {loss:.4f}, {perf_counter() - started:.1f}s", flush=True)


if __name__ == "__main__":
    main()
