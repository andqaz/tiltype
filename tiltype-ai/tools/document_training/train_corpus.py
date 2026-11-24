"""Дообучает GRU двух размеров на одинаковых продолжениях из подготовленного корпуса.

Использует общий подсловный токенизатор и начальные веса TilType. Сохраняет
веса отдельно от расширения и фиксирует фактический состав обучающего прогона.
"""

import json
import random
import re
import sys
from collections import defaultdict

import torch
from prepare import BAL, OUT, ROOT, WORD, records
from tokenizers import Tokenizer
from torch.nn.utils.rnn import pad_sequence

sys.path.insert(0, str(ROOT / "tiltype-ai/tools"))
from subword_data import (
    CONTEXT_TOKENS,
    DOCUMENT_HISTORY_TOKENS,
    END,
    LANGUAGE_MARKERS,
    PAD,
    token_id,
)
from subword_model import SubwordModel

SEED = 721939
PER_LANGUAGE = 40000
TOKENIZER = BAL.parents[1] / "subword-phrase-model-4epochs/models/tokenizer.json"


def examples(tokenizer):
    """Выбирает окна по жанрам, удерживая предыдущие предложения внутри документа."""
    rng = random.Random(SEED)
    groups = defaultdict(list)
    counts = defaultdict(int)
    pad = token_id(tokenizer, PAD)
    end = token_id(tokenizer, END)
    for doc in records(OUT / "train.jsonl.gz"):
        lang = doc["language"]
        group = (lang, doc["source"])
        sentences = [
            " ".join(WORD.findall(s.lower()))
            for s in re.split(r"\n+|(?<=[.!?…])\s+", doc["text"])
        ]
        sentences = [s for s in sentences if s][:80]
        history = []
        for entry in tokenizer.encode_batch(sentences):
            ids = entry.ids
            starts = [
                i for i, token in enumerate(entry.tokens) if token.startswith("▁")
            ]
            if len(starts) >= 4:
                counts[group] += 1
                n = counts[group]
                slot = n - 1 if n <= PER_LANGUAGE else rng.randrange(n)
                if slot < PER_LANGUAGE:
                    cursor = rng.choice(starts[1:-2])
                    prefix = [
                        token_id(tokenizer, LANGUAGE_MARKERS[lang]),
                        *history,
                        *ids[max(0, cursor - CONTEXT_TOKENS) : cursor],
                    ]
                    target = (ids[cursor:] + [end])[:32]
                    pair = (
                        torch.tensor(prefix + target[:-1]),
                        torch.tensor([pad] * (len(prefix) - 1) + target),
                    )
                    if slot == len(groups[group]):
                        groups[group].append(pair)
                    else:
                        groups[group][slot] = pair
            history = (history + ids + [end])[-DOCUMENT_HISTORY_TOKENS:]
    selected = []
    sizes = {}
    for lang in ("ru", "kk", "en"):
        pools = {group: values for group, values in groups.items() if group[0] == lang}
        for pool in pools.values():
            rng.shuffle(pool)
        # Заполняем квоту равномерно по доступным источникам, без повторов.
        total = 0
        while total < PER_LANGUAGE and any(pools.values()):
            for group, pool in pools.items():
                if pool and total < PER_LANGUAGE:
                    selected.append(pool.pop())
                    key = "/".join(group)
                    sizes[key] = sizes.get(key, 0) + 1
                    total += 1
    (OUT / "sample.json").write_text(json.dumps(sizes, indent=2))
    return selected


def initial_model(size, tokenizer):
    """Переносит исходные каналы GRU и выходных матриц в модель выбранной ширины."""
    torch.manual_seed(SEED)
    model = SubwordModel(tokenizer.get_vocab_size(), token_id(tokenizer, PAD), size)
    state = torch.load(TOKENIZER.with_name("model.pt"), weights_only=True)
    target = model.state_dict()
    for key, old in state.items():
        dst = target[key]
        if old.shape == dst.shape:
            dst.copy_(old)
        elif key.startswith("recurrent."):
            for new_gate, old_gate in zip(dst.chunk(3), old.chunk(3)):
                block = new_gate[: old_gate.shape[0]]
                block.zero_()
                block[tuple(slice(0, length) for length in old_gate.shape)].copy_(
                    old_gate
                )
        else:
            dst[: old.shape[0]].zero_()
            dst[tuple(slice(0, length) for length in old.shape)].copy_(old)
    model.load_state_dict(target)
    return model


def train_epoch(rows, model, optimizer, pad):
    """Обучает одну эпоху с прежним порядком пакетов и ограничением нормы градиента."""
    order = list(rows)
    random.Random(64119).shuffle(order)
    batch_size = 64
    for offset in range(0, len(order), batch_size):
        inputs, targets = zip(*order[offset : offset + batch_size])
        optimizer.zero_grad(set_to_none=True)
        loss = model(
            pad_sequence(list(inputs), batch_first=True, padding_value=pad),
            pad_sequence(list(targets), batch_first=True, padding_value=pad),
            pad,
        )
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()


def main():
    """Обучает варианты последовательно и атомарно сохраняет готовые веса."""
    torch.set_num_threads(4)
    tok = Tokenizer.from_file(str(TOKENIZER))
    rows = examples(tok)
    for width in (192, 256):
        model = initial_model(width, tok)
        print(f"Training {width} units on {len(rows)} windows", flush=True)
        optimizer = torch.optim.AdamW(model.parameters(), lr=0.0004)
        train_epoch(rows, model, optimizer, token_id(tok, PAD))
        stage = OUT / f"gru-{width}.tmp"
        torch.save(model.state_dict(), stage)
        stage.replace(stage.with_suffix(".pt"))


if __name__ == "__main__":
    main()
