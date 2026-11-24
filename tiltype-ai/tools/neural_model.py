"""Задаёт компактную модель следующего слова TilType AI.

Обучение выполняется в PyTorch. Экспорт упаковывает квантизированные
матрицы для автономного движка JavaScript внутри расширения.
"""

import json
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import torch
from torch import nn

from training_data import CONTEXT_SIZE, UNKNOWN_BUCKETS

EMBEDDING_SIZE = 32
HIDDEN_SIZE = 96
CUTOFFS = (384, 1_536)


class LanguageModel(nn.Module):
    """Предсказывает следующее слово по шести предыдущим токенам."""

    def __init__(self, vocabulary_size: int, context_size: int = CONTEXT_SIZE) -> None:
        super().__init__()
        self.embedding = nn.Embedding(vocabulary_size + UNKNOWN_BUCKETS + 1, EMBEDDING_SIZE, padding_idx=0)
        self.context = nn.Linear(context_size * EMBEDDING_SIZE, HIDDEN_SIZE)
        cuts = [cut for cut in CUTOFFS if cut < vocabulary_size]
        self.output = nn.AdaptiveLogSoftmaxWithLoss(HIDDEN_SIZE, vocabulary_size, cuts, div_value=2)

    def forward(self, inputs: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        """Возвращает среднюю потерю по истинному следующему слову."""
        hidden = torch.relu(self.context(self.embedding(inputs).flatten(1)))
        return self.output(hidden, targets).loss


def export_model(model: LanguageModel, words: list[str], directory: Path, language: str) -> None:
    """Пишет словарь, форму слоёв и веса int8 с масштабом для каждой строки."""
    binary = bytearray()

    def write_matrix(weight: torch.Tensor, bias: torch.Tensor | None = None) -> dict:
        array = weight.detach().cpu().numpy()
        scale = np.maximum(np.max(np.abs(array), axis=1) / 127, 1e-9).astype("<f4")
        values = np.clip(np.rint(array / scale[:, None]), -127, 127).astype(np.int8)
        start = len(binary)
        binary.extend(values.tobytes())
        scale_offset = len(binary)
        binary.extend(scale.tobytes())
        bias_offset = None
        if bias is not None:
            bias_offset = len(binary)
            binary.extend(bias.detach().cpu().numpy().astype("<f4").tobytes())
        return {
            "rows": int(array.shape[0]), "columns": int(array.shape[1]), "start": start,
            "scale": scale_offset, "bias": bias_offset,
        }

    output = model.output
    descriptor = {
        "contextSize": model.context.in_features // model.embedding.embedding_dim,
        "unknownBuckets": UNKNOWN_BUCKETS,
        "words": words,
        "shortlist": output.shortlist_size,
        "embedding": write_matrix(model.embedding.weight),
        "context": write_matrix(model.context.weight, model.context.bias),
        "head": write_matrix(output.head.weight, output.head.bias),
        "tails": [
            {"start": output.cutoffs[index], "projection": write_matrix(tail[0].weight),
             "classifier": write_matrix(tail[1].weight)}
            for index, tail in enumerate(output.tail)
        ],
    }
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{language}.json").write_text(json.dumps(descriptor, ensure_ascii=False), encoding="utf-8")
    (directory / f"{language}.bin").write_bytes(binary)


def restore_layer(layer: nn.Embedding | nn.Linear, spec: dict[str, int | None], data: bytes) -> None:
    """Деквантует построчно int8-веса и восстанавливает смещения линейного слоя."""
    rows, columns = layer.weight.shape
    if spec["rows"] != rows or spec["columns"] != columns:
        raise ValueError("Packaged matrix does not match the training architecture")
    start, scale = spec["start"], spec["scale"]
    if start is None or scale is None:
        raise ValueError("Packaged matrix is missing weight offsets")
    values = np.frombuffer(data, dtype=np.int8, count=rows * columns, offset=start).reshape(rows, columns)
    scales = np.frombuffer(data, dtype="<f4", count=rows, offset=scale)
    layer.weight.copy_(torch.from_numpy(values * scales[:, None]))
    if isinstance(layer, nn.Linear) and layer.bias is not None:
        offset = spec["bias"]
        if offset is None:
            raise ValueError("Packaged matrix is missing its bias")
        bias = np.frombuffer(data, dtype="<f4", count=rows, offset=offset).copy()
        layer.bias.copy_(torch.from_numpy(bias))


@torch.no_grad()
def restore_model(package: Path, language: str) -> tuple[list[str], LanguageModel]:
    """Восстанавливает обучаемые веса и исходный словарь языка из .plugin."""
    with ZipFile(package) as archive:
        descriptor = json.loads(archive.read(f"models/{language}.json"))
        data = archive.read(f"models/{language}.bin")
    words = descriptor["words"]
    model = LanguageModel(len(words), descriptor["contextSize"])
    for name, layer in (("embedding", model.embedding), ("context", model.context), ("head", model.output.head)):
        restore_layer(layer, descriptor[name], data)
    for tail, spec in zip(model.output.tail, descriptor["tails"], strict=True):
        restore_layer(tail[0], spec["projection"], data)
        restore_layer(tail[1], spec["classifier"], data)
    return words, model
