/**
 * Сопоставляет набранную конструкцию с похожими местами в предыдущих предложениях.
 * Разрешает вставленные слова внутри конструкции, сохраняя исходное склонение продолжения.
 */
"use strict";

/** @typedef {{ word: string, start: number, connected: boolean }} AlignedTerm */
/** @typedef {{ text: string, occurrences: number, score: number }} AlignedPhrase */

const neuralOrderedPhraseAlignment = (() => {
  const WORD = /\p{L}+(?:['’-]\p{L}+)*/gu;
  const BOUNDARY = /\n+|(?<=[.!?…])\s+/u;
  const MAX_QUERY = 9;
  const MAX_WINDOW = 13;
  const LANGUAGE = { en: /^[a-z]+(?:['-][a-z]+)*$/u, ru: /^[а-яё]+(?:['-][а-яё]+)*$/u,
    kk: /^[а-яёәғқңөұүһі]+(?:['-][а-яёәғқңөұүһі]+)*$/u };

  /** @param {string} text @returns {AlignedTerm[]} */
  function parse(text) {
    const normalized = text.toLowerCase().replaceAll("’", "'");
    const tokens = [...normalized.matchAll(WORD)];
    return tokens.map((token, index) => ({
      word: token[0], start: token.index, connected: index > 0 &&
        /^ +$/u.test(normalized.slice(tokens[index - 1].index + tokens[index - 1][0].length, token.index)),
    }));
  }

  /** @param {string} left @param {string} right */
  function match(left, right) {
    if (left === right) return 1;
    if (left.length >= 6 && right.length >= 6 && Math.abs(left.length - right.length) <= 3 &&
        left.slice(0, 5) === right.slice(0, 5)) return 0.45;
    return 0;
  }

  /** @param {string} word @param {Map<string, number>} vocabulary */
  function weight(word, vocabulary) {
    return word.length < 4 || (vocabulary.get(word) ?? Infinity) < 130 ? 0.6 : 1.25;
  }

  /** @param {AlignedTerm[]} query @param {AlignedTerm[]} passage @param {Map<string, number>} vocabulary */
  function align(query, passage, vocabulary) {
    const width = passage.length + 1;
    let prev = new Float32Array(width);
    let next = new Float32Array(width);
    for (const token of query) {
      const value = weight(token.word, vocabulary);
      for (let index = 1; index < width; index++) {
        const quality = match(token.word, passage[index - 1].word);
        next[index] = Math.max(0, prev[index] - 0.32, next[index - 1] - 0.22,
          prev[index - 1] + (quality ? quality * value : -0.6));
      }
      [prev, next] = [next, prev];
    }
    return prev[width - 1];
  }

  /**
   * @param {AlignedTerm[]} query @param {string[]} sources
   * @param {NeuralLanguage} language @param {Map<string, number>} vocabulary
   * @returns {AlignedPhrase[]}
   */
  function occurrences(query, sources, language, vocabulary) {
    const last = query.at(-1).word;
    const penultimate = query.at(-2).word;
    const meaningful = new Set(query.filter(item => weight(item.word, vocabulary) > 1)
      .map(item => item.word));
    /** @type {Map<string, AlignedPhrase>} */
    const candidates = new Map();
    const alphabet = LANGUAGE[language];
    for (const [age, sentence] of sources.entries()) {
      const terms = parse(sentence);
      const seen = new Set();
      for (let slot = 3; slot < terms.length - 1; slot++) {
        if (!terms[slot].connected || !terms[slot + 1].connected) continue;
        const anchor = match(last, terms[slot - 1].word);
        if (!anchor || !alphabet.test(terms[slot].word) || !alphabet.test(terms[slot + 1].word)) continue;
        const lookback = terms.slice(Math.max(0, slot - MAX_WINDOW), slot);
        const secondary = match(penultimate, terms[slot - 2].word);
        const overlap = [...new Set(lookback.map(item => item.word))].filter(word => meaningful.has(word)).length;
        if (!secondary && overlap < 2) continue;
        const similarity = align(query, lookback, vocabulary);
        if (similarity < 2.2) continue;
        const phrase = terms[slot].word + " " + terms[slot + 1].word;
        let tail = "";
        if (terms[slot + 2]?.connected && alphabet.test(terms[slot + 2].word)) tail = " " + terms[slot + 2].word;
        /** @type {[string, boolean][]} */
        const continuations = [[phrase, false]];
        if (tail) continuations.push([phrase + tail, true]);
        for (const [text, extra] of continuations) {
          const old = candidates.get(text) ?? { text, occurrences: 0, score: 0 };
          if (!seen.has(text)) old.occurrences++;
          seen.add(text);
          old.score = Math.max(old.score, similarity + anchor * 0.7 + secondary * 0.38 + overlap * 0.16 - age * 0.07 - Number(extra) * 0.38);
          candidates.set(text, old);
        }
      }
    }
    return [...candidates.values()].sort((a, b) => b.score + Math.log1p(b.occurrences) * 0.35 -
      a.score - Math.log1p(a.occurrences) * 0.35).slice(0, 8);
  }

  /**
   * Извлекает до восьми продолжений из текста до курсора.
   * @param {string} prefix @param {string} raw
   * @param {{ context: string[], model: NeuralModel, language: NeuralLanguage }} selected
   */
  function retrieve(prefix, raw, selected) {
    const { context, model, language } = selected;
    if (context.length < 4) return [];
    const clause = prefix.split(BOUNDARY).at(-1) ?? "";
    const active = parse(clause);
    if (active.length < 4) return [];
    const query = active.slice(-Math.min(MAX_QUERY, context.length));
    const earlierInClause = active.length > query.length + 4 ? clause.slice(0, query[0].start) : "";
    const earlier = raw.trimEnd().split(BOUNDARY).slice(-12).reverse();
    const sources = earlierInClause ? [earlierInClause, ...earlier] : earlier;
    return occurrences(query, sources, language, model.vocabulary);
  }

  return { retrieve };
})();
