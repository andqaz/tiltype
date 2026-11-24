/**
 * Находит частоты в отсортированном текстовом ресурсе фраз.
 * Хранит только текст и смещения строк, разбирая найденную строку по запросу.
 */
"use strict";

/** @typedef {{ source: string, offsets: Uint32Array }} PhraseAlternativeIndex */

const neuralPhraseAlternativeIndex = (() => {
  /** @param {string} source @returns {PhraseAlternativeIndex} */
  function open(source) {
    if (!source.endsWith("\n") || !source.includes("\t")) throw new Error("Invalid phrase index");
    let count = 0;
    for (let end = source.indexOf("\n"); end >= 0; end = source.indexOf("\n", end + 1)) count += 1;
    const offsets = new Uint32Array(count + 1);
    for (let index = 1; index <= count; index += 1) offsets[index] = source.indexOf("\n", offsets[index - 1]) + 1;
    return { source, offsets };
  }

  /** @param {PhraseAlternativeIndex} index @param {string} key @returns {string | undefined} Тело строки ресурса. */
  function find({ source, offsets }, key) {
    let left = 0;
    let right = offsets.length - 1;
    while (left < right) {
      const row = Math.floor((left + right) / 2);
      const start = offsets[row];
      const end = offsets[row + 1] - 1;
      const divider = source.indexOf("\t", start);
      if (divider < start || divider >= end) return undefined;
      const term = source.slice(start, divider);
      if (term === key) return source.slice(divider + 1, end);
      if (term < key) left = row + 1;
      else right = row;
    }
    return undefined;
  }

  /** @param {PhraseAlternativeIndex} index @param {string} key @returns {Map<string, number>} */
  function lookup(index, key) {
    const record = find(index, key);
    if (!record) return new Map();
    const separated = record.indexOf("\t");
    if (separated < 0) return new Map();
    const total = Number(record.slice(0, separated));
    if (!Number.isSafeInteger(total) || total < 0) return new Map();
    return new Map(record.slice(separated + 1).split("|").map(entry => {
      const [word, count] = entry.split(",");
      return [word, Number(count) / (total || 1)];
    }));
  }

  return { open, lookup, find };
})();
