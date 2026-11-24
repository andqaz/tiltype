"""Дообучает опубликованные веса TilType AI на Tatoeba и KazNERD.

Читает пакет предыдущей сборки, использует прежний словарь выходных классов
и записывает новые веса отдельно от исходного пакета.
"""

import argparse
import re
from pathlib import Path

import torch

from neural_model import export_model, restore_model
from train import SEED, train_epochs
from training_data import ALPHABETS, encode_runs
from build_predictions import previous_ending_runs as domain_runs

POSITION_LIMIT = 1_200_000
EPOCHS = 2
LEARNING_RATE = 0.00035


def main() -> None:
    """Дообучает выбранную языковую модель на предложениях целевых корпусов."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=ALPHABETS)
    parser.add_argument("package", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--epochs", type=int, default=EPOCHS)
    parser.add_argument("--learning-rate", type=float, default=LEARNING_RATE)
    parser.add_argument("--sample-seed", type=int, default=SEED)
    args = parser.parse_args()
    if args.epochs < 1 or not 0 < args.learning_rate < 1:
        parser.error("epochs must be positive and learning rate must be between zero and one")

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(SEED)
    words, model = restore_model(args.package, args.language)
    letters = f"[{ALPHABETS[args.language]}]+"
    allowed = re.compile(rf"{letters}(?:['-]{letters})*")
    rows = encode_runs(domain_runs(args.language, allowed), words, args.sample_seed, POSITION_LIMIT)
    print(f"{args.language}: {len(rows)} training positions", flush=True)
    train_epochs(model, rows, args.language, args.epochs, args.learning_rate)
    export_model(model, words, args.output, args.language)


if __name__ == "__main__":
    main()
