"""Дообучает языковые модели на длинных контекстах для вставки фраз.

При расширении окна начальные веса последних слов сохраняются. Новые позиции
учатся на тех же предложениях и не меняют формат выходного словаря.
"""

import argparse
from pathlib import Path

import torch
from neural_model import LanguageModel, export_model, restore_model
from sentence_data import SENTENCE_CONTEXT_SIZE, dialogue_sentences, training_sentences
from torch import nn
from train import SEED, train_epochs
from training_data import ALPHABETS, encode_runs

POSITION_LIMIT = 1_600_000
DIALOGUE_POSITION_LIMIT = 1_200_000


@torch.no_grad()
def expand_context(model: LanguageModel) -> None:
    """Добавляет позиции слева с нулевым начальным вкладом в прогноз."""
    current = model.context
    width = SENTENCE_CONTEXT_SIZE * model.embedding.embedding_dim
    if current.in_features >= width:
        return
    expanded = nn.Linear(width, current.out_features)
    expanded.weight.zero_()
    expanded.weight[:, -current.in_features:].copy_(current.weight)
    expanded.bias.copy_(current.bias)
    model.context = expanded


def main() -> None:
    """Обучает один язык и экспортирует int8-матрицы в заданную папку."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=ALPHABETS)
    parser.add_argument("package", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--dialogues", type=Path, help="Directory prepared by import_dialogues.py")
    args = parser.parse_args()
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(SEED)
    words, model = restore_model(args.package, args.language)
    expand_context(model)
    rows = encode_runs(training_sentences(args.language), words, SEED, POSITION_LIMIT, SENTENCE_CONTEXT_SIZE)
    if args.dialogues:
        dialogue_rows = encode_runs(
            dialogue_sentences(args.language, args.dialogues), words, SEED,
            DIALOGUE_POSITION_LIMIT, SENTENCE_CONTEXT_SIZE,
        )
        print(f"{args.language}: {len(dialogue_rows):,} new dialogue positions", flush=True)
        rows = torch.cat((rows, dialogue_rows))
    print(f"{args.language}: {len(rows)} training positions", flush=True)
    train_epochs(model, rows, args.language, 2, 0.00065, cosine_decay=True)
    export_model(model, words, args.output, args.language)


if __name__ == "__main__":
    main()
