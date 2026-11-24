"""Обучает один офлайн-предиктор TilType AI и экспортирует его веса.

Запуск для каждого языка независим. Контрольная выборка сохраняется
для внешнего сравнения, обучение использует только разрешённую часть.
"""

import argparse
from math import ceil
from pathlib import Path
from time import perf_counter

import torch

from neural_model import LanguageModel, export_model
from training_data import ALPHABETS, ROOT, TRAINING_BUDGETS, prepare

SEED = 2_201
BATCH_SIZE = 384


def train_epochs(model: LanguageModel, rows: torch.Tensor, language: str, epochs: int, rate: float,
                 *, cosine_decay: bool = False) -> None:
    """Обучает или дообучает модель с новым оптимизатором и фиксированным перемешиванием."""
    optimizer = torch.optim.AdamW(model.parameters(), lr=rate)
    schedule = None
    if cosine_decay:
        steps = epochs * ceil(len(rows) / BATCH_SIZE)
        schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=steps, eta_min=0.00025)
    generator = torch.Generator().manual_seed(SEED)
    for epoch in range(epochs):
        started = perf_counter()
        loss_total = 0.0
        for batch in torch.randperm(len(rows), generator=generator).split(BATCH_SIZE):
            sample = rows[batch].long()
            optimizer.zero_grad(set_to_none=True)
            loss = model(sample[:, :-1], sample[:, -1])
            loss.backward()
            optimizer.step()
            if schedule is not None:
                schedule.step()
            loss_total += float(loss.detach()) * len(batch)
        print(f"{language} epoch {epoch + 1}: {loss_total / len(rows):.4f} loss, {perf_counter() - started:.1f}s", flush=True)


def main() -> None:
    """Обучает модель по аргументам командной строки."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=ALPHABETS)
    parser.add_argument("--preset", choices=TRAINING_BUDGETS, default="expanded")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--cosine-decay", action="store_true", help="Gradually reduce the learning rate during training")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--output", type=Path, default=ROOT / "tiltype-ai" / "plugin" / "models")
    args = parser.parse_args()
    if args.epochs < 1 or args.threads < 1:
        parser.error("epochs and threads must be positive")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(SEED)
    words, rows = prepare(args.language, SEED, TRAINING_BUDGETS[args.preset])
    print(f"{args.language}: {len(words)} words; {len(rows)} training positions", flush=True)
    model = LanguageModel(len(words))
    train_epochs(model, rows, args.language, args.epochs, 0.002, cosine_decay=args.cosine_decay)
    export_model(model, words, args.output, args.language)


if __name__ == "__main__":
    main()
