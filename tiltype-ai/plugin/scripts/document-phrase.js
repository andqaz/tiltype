/**
 * Дополняет выбранное слово, если документ подтверждает одинаковое продолжение.
 * Считает только смежные слова и учитывает неоднозначные употребления.
 */
"use strict";

const neuralDocumentPhrase = (() => {
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const GAP = /^\s+$/u;
  const SUFFIX_WORDS = 3;
  const HISTORY_LIMIT = 16;
  const MIN_REPEATS = 2;
  const MIN_SHARE = 0.8;
  /** @type {{ source: string[], records: { text: string, terms: RegExpMatchArray[] }[] } | undefined} */
  let prepared;

  /** @param {string} text */
  function matches(text) {
    return [...text.toLowerCase().replaceAll("’", "'").matchAll(WORD)];
  }

  /** @param {string} text @param {RegExpMatchArray} left @param {RegExpMatchArray | undefined} right */
  function connected(text, left, right) {
    return Boolean(right && GAP.test(text.slice(left.index + left[0].length, right.index)));
  }

  /** @param {string[]} history */
  function prepare(history) {
    if (prepared?.source !== history) {
      prepared = { source: history, records: history.slice(-HISTORY_LIMIT).map(text => ({ text, terms: matches(text) })) };
    }
    return prepared.records;
  }

  /** @param {Map<string, number>} counts @param {number} total @returns {string | undefined} */
  function verified(counts, total) {
    const [first] = [...counts].sort((left, right) => right[1] - left[1]);
    return first && first[1] >= MIN_REPEATS && first[1] >= total * MIN_SHARE ? first[0] : undefined;
  }

  /**
   * Возвращает первый вариант из двух или трёх слов при достаточной опоре на историю.
   * @param {string[]} local @param {string[]} history @param {string} prefix @returns {string[]}
   */
  function complete(local, history, prefix) {
    const first = local[0];
    if (!first || first.includes(" ") || !history.length) return local;
    const context = matches(prefix).slice(-SUFFIX_WORDS);
    if (context.length < SUFFIX_WORDS || !connected(prefix, context[0], context[1]) ||
        !connected(prefix, context[1], context[2])) return local;
    const expected = [...context.map(match => match[0]), first.toLowerCase()];
    /** @type {Map<string, number>} */
    const seconds = new Map();
    /** @type {Map<string, Map<string, number>>} */
    const thirds = new Map();
    let total = 0;
    for (const { text, terms } of prepare(history)) {
      for (let index = SUFFIX_WORDS; index < terms.length; index += 1) {
        if (terms[index][0] !== expected[SUFFIX_WORDS]) continue;
        if (!expected.every((word, offset) => {
          const position = index - SUFFIX_WORDS + offset;
          return terms[position][0] === word && (offset === 0 || connected(text, terms[position - 1], terms[position]));
        })) continue;
        total += 1;
        if (!connected(text, terms[index], terms[index + 1])) continue;
        const second = terms[index + 1][0];
        seconds.set(second, (seconds.get(second) ?? 0) + 1);
        if (!connected(text, terms[index + 1], terms[index + 2])) continue;
        const third = terms[index + 2][0];
        const endings = thirds.get(second) ?? new Map();
        endings.set(third, (endings.get(third) ?? 0) + 1);
        thirds.set(second, endings);
      }
    }
    const second = verified(seconds, total);
    if (!second) return local;
    const third = verified(thirds.get(second) ?? new Map(), seconds.get(second) ?? 0);
    return [[first, second, third].filter(Boolean).join(" "), ...local.slice(1)];
  }

  return { complete };
})();
