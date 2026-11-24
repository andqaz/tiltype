/**
 * Готовит историю документа для сопоставления параллельных фрагментов.
 * Сохраняет границы слов и использует существующий словарь модели.
 */
"use strict";

/** @typedef {{ word: string, contiguous: boolean }} PassageTerm */
/** @typedef {{ phrase: string, strength: number, occurrences: number }} PassageMatch */

const neuralDocumentPassage = (() => {
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const GAP = /^\s+$/u;
  const LOOKBACK = 8;
  const HISTORY_LIMIT = 16;
  const INFORMATIVE_RANK = 160;
  /** @type {{ source: string[], tokens: PassageTerm[][] } | undefined} */
  let prepared;

  /** @param {string} text @returns {PassageTerm[]} */
  function parse(text) {
    const normalized = text.toLowerCase().replaceAll("’", "'");
    const matches = [...normalized.matchAll(WORD)];
    return matches.map((match, index) => ({ word: match[0], contiguous: index > 0 &&
      GAP.test(normalized.slice(matches[index - 1].index + matches[index - 1][0].length, match.index)) }));
  }

  /** @param {string[]} history @returns {PassageTerm[][]} Предложения от новых к старым. */
  function prepare(history) {
    if (prepared?.source !== history) {
      prepared = { source: history, tokens: history.slice(-HISTORY_LIMIT).reverse().map(parse) };
    }
    return prepared.tokens;
  }

  /** @param {string} left @param {string} right */
  function sameForm(left, right) {
    if (left === right) return 1;
    const shortest = Math.min(left.length, right.length);
    const width = Math.max(5, Math.max(left.length, right.length) - 3);
    return shortest >= width && left.slice(0, width) === right.slice(0, width) ? 0.5 : 0;
  }

  /** @param {string} word @param {NeuralModel} model */
  function informative(word, model) {
    return word.length >= 4 && (model.vocabulary.get(word) ?? Infinity) >= INFORMATIVE_RANK;
  }

  /** @param {string[]} query @param {string[]} passage */
  function overlap(query, passage) {
    const unused = new Set(passage);
    let result = 0;
    for (const word of query) {
      if (unused.delete(word)) {
        result += 1;
        continue;
      }
      for (const other of unused) {
        if (!sameForm(word, other)) continue;
        unused.delete(other);
        result += 0.5;
        break;
      }
    }
    return result;
  }

  /** @param {string[]} query @param {string[]} queryTerms @param {PassageTerm[]} tokens
    * @param {number} index @param {number} last @param {NeuralModel} model */
  function evidence(query, queryTerms, tokens, index, last, model) {
    const prior = tokens.slice(Math.max(0, index - LOOKBACK), index).map(token => token.word);
    const second = sameForm(prior.at(-2), query.at(-2));
    const third = prior.length >= 3 ? sameForm(prior.at(-3), query.at(-3)) : 0;
    if (last === 1 && second === 1 && third === 1) return null;
    const historyTerms = prior.slice(0, -1).filter(word => informative(word, model));
    const semantic = overlap(queryTerms, historyTerms);
    if (semantic < 1 || (second + third < 0.5 && semantic < 1.5)) return null;
    return { syntax: last + 0.72 * second + 0.38 * third, semantic,
      proximity: semantic / Math.sqrt(Math.max(1, queryTerms.length * new Set(historyTerms).size)) };
  }

  /**
   * Возвращает смежные фразы из близких фрагментов и число подтверждающих предложений.
   * @param {string[]} context @param {PassageTerm[][]} history @param {NeuralModel} model @returns {PassageMatch[]}
   */
  function retrieve(context, history, model) {
    const query = context.slice(-LOOKBACK);
    if (query.length < 4 || !history.length) return [];
    const queryTerms = [...new Set(query.slice(0, -1).filter(word => informative(word, model)))];
    if (!queryTerms.length) return [];
    /** @type {Map<string, PassageMatch>} */
    const matches = new Map();
    for (const [age, tokens] of history.entries()) {
      /** @type {Map<string, number>} */
      const found = new Map();
      for (let index = 2; index < tokens.length - 1; index += 1) {
        if (!tokens[index].contiguous || !tokens[index + 1].contiguous) continue;
        const last = sameForm(tokens[index - 1].word, query.at(-1));
        if (!last) continue;
        const signal = evidence(query, queryTerms, tokens, index, last, model);
        if (!signal) continue;
        const phrase = tokens[index].word + " " + tokens[index + 1].word;
        const strength = signal.syntax + signal.semantic * 0.45 + signal.proximity - 0.04 * age;
        if (strength > (found.get(phrase) ?? 0)) found.set(phrase, strength);
      }
      for (const [phrase, strength] of found) {
        const previous = matches.get(phrase);
        matches.set(phrase, { phrase, strength: Math.max(strength, previous?.strength ?? 0),
          occurrences: (previous?.occurrences ?? 0) + 1 });
      }
    }
    return [...matches.values()].sort((left, right) => right.strength - left.strength);
  }

  return { prepare, retrieve };
})();
