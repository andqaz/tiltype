/**
 * Подбирает продолжение по истории, когда основной движок оставил список пустым.
 * Переиспользует оценки локальной модели и применяет отдельный порог показа.
 */
"use strict";

/** @typedef {{ depth: number, times: number, phrases: Map<string, number> }} AbstentionEvidence */

const neuralDocumentAbstention = (() => {
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const BOUNDARY = /\n+|(?<=[.!?…])\s+/u;
  const GAP = /^\s+$/u;
  const MAX_HISTORY = 12;
  /** @type {Record<NeuralLanguage, { threshold: number, weights: number[] }>} */
  const settings = {
    ru: { threshold: 0.25, weights: [-5.199070020955483, 0.7326285264844725, 0, -0.15558883701570977, 0.6804397260636612, 1.908565424144463, 0.6808528430225024, -0.12871402100993198] },
    kk: { threshold: 0.25, weights: [-5.640778807480852, 1.46498718364959, 0, -0.35339399031086394, 0.9520340353797431, 1.4760401817490603, 1.3235111284101753, -0.22150179093457023] },
    en: { threshold: 0.16, weights: [-5.102841166043406, 0.5961324483066276, 0, -0.7252867577438507, 0.4567654160041386, 1.1984400924603227, 1.0506943665362696, -0.08005801350292228] },
  };

  /** @param {NeuralModel} model @param {string[]} context @returns {Map<string, number>} */
  function corpusEvidence(model, context) {
    const distribution = [3, 2, 1].map(width => context.length >= width &&
      model.phraseEvidence("~" + context.slice(-width).join(" "))).find(Boolean);
    return new Map((distribution || "").split("|").filter(Boolean).map(entry => {
      const [word, percent] = entry.split(",");
      return [word, Number(percent) / 100];
    }));
  }

  /**
   * Подсчитывает повторные слова и смежные продолжения для одного или двух слов перед курсором.
   * @param {string} raw @param {string[]} context
   */
  function historyEvidence(raw, context) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    /** @type {Map<string, AbstentionEvidence>} */
    const found = new Map();
    for (const [age, sentence] of raw.toLowerCase().split(BOUNDARY).slice(-MAX_HISTORY).reverse().entries()) {
      const words = [...sentence.matchAll(WORD)];
      /** @param {number} index */
      const adjacent = index => index > 0 && index < words.length &&
        GAP.test(sentence.slice(words[index - 1].index + words[index - 1][0].length, words[index].index));
      for (const [index, token] of words.entries()) {
        const word = token[0];
        counts.set(word, (counts.get(word) ?? 0) + 1 / (1 + age * 0.25));
        if (!adjacent(index) || context.at(-1) !== words[index - 1][0]) continue;
        const depth = adjacent(index - 1) && context.at(-2) === words[index - 2]?.[0] ? 2 : 1;
        const evidence = found.get(word) ?? { depth: 0, times: 0, phrases: new Map() };
        evidence.depth = Math.max(evidence.depth, depth);
        evidence.times += 1;
        if (adjacent(index + 1) && depth > 1) {
          const second = words[index + 1][0];
          evidence.phrases.set(second, (evidence.phrases.get(second) ?? 0) + 1);
        }
        found.set(word, evidence);
      }
    }
    return { counts, found };
  }

  /**
   * Возвращает не более одной подсказки при достаточной уверенности.
   * @param {string} raw @param {string[]} context @param {NeuralLanguage} language
   * @param {NeuralModel} model @param {RankedNeuralWord[]} rankedWords @returns {string[]}
   */
  function suggest(raw, context, language, model, rankedWords) {
    if (!raw) return [];
    const probabilities = new Map(rankedWords.map(item => [item.word.toLowerCase(), item.probability]));
    const corpus = corpusEvidence(model, context);
    const { counts, found } = historyEvidence(raw, context);
    const historical = [...found].filter(([, item]) => item.depth > 1).map(([word]) => word);
    const words = new Set([...probabilities.keys(), ...corpus.keys(), ...historical]);
    const { threshold, weights } = settings[language];
    let best;
    let confidence = threshold;
    /** @param {string} text @param {number[]} features */
    function consider(text, features) {
      const score = weights.reduce((sum, weight, index) => sum + weight * features[index], 0);
      const probability = 1 / (1 + Math.exp(-score));
      if (probability <= confidence) return;
      best = text;
      confidence = probability;
    }
    for (const word of words) {
      const evidence = found.get(word);
      const features = [1, Math.log1p(70 * (probabilities.get(word) ?? 0)), Math.log1p(25 * (corpus.get(word) ?? 0)), 0,
        Math.log1p(counts.get(word) ?? 0), evidence?.depth ?? 0, Math.log1p(evidence?.times ?? 0), 0];
      const first = word === "i" ? "I" : word;
      consider(first, features);
      const [second] = [...(evidence?.phrases ?? [])].sort((left, right) => right[1] - left[1]);
      if (!second) continue;
      features[3] = 1;
      features[7] = second[1] / evidence.times;
      consider(first + " " + second[0], features);
    }
    return best ? [best] : [];
  }

  return { suggest };
})();
