/**
 * Проверяет, достаточно ли контекст подтверждает окончание подсказки.
 * Использует разобранную историю и готовые корпусные частоты TilType.
 */
"use strict";

/** @typedef {{ hits: Uint32Array, recent: number }} PhraseConfidenceObservation */

const neuralPhraseConfidence = (() => {
  const MAX_PREFIX = 6;
  const MAX_RECOVERED = 6;
  const MIN_CORPUS_PROBABILITY = 0.055;
  /** @type {Record<NeuralLanguage, { threshold: number, weights: number[] }>} */
  const settings = {
    ru: { threshold: 0.6, weights: [-2.5349115272817206, 0.743757513132344, 0.48792152635675795, 0.15843667786246746, -0.6115683987479128, -0.22474503816064464, 1.2366095596162474, 0.16852111208826226, -0.1000090467563032, 1.3736303538253571, -1.2390839774953848, 0.8568346070711643] },
    kk: { threshold: 0.6, weights: [-2.3706120651309512, 0.5258547492133054, 0.5783584588655662, 0.243364552573904, -0.5265119602902788, 0.000594432836381925, 1.5407605773298618, -0.524337304388852, 0.1731138736526491, 0.6495469857341685, -1.1396411003914353, 0.5319335721192109] },
    en: { threshold: 0.7, weights: [-2.944203913749342, 0.8080060703708823, 0.689750670657203, 0.41370256807915334, -0.7365374110375407, -0.04893863295337067, 0.7066181511195757, -0.1323109770551385, 0.29662909436256085, 1.4139836166772484, -0.6697304268030748, 0.3336539411665246] },
  };

  /** @param {PhraseEvidenceLookup} evidence @param {string[]} context @returns {Map<string, number>} */
  function corpusProbabilities(evidence, context) {
    /** @type {Map<string, number>} */
    const words = new Map();
    for (const width of [3, 2, 1]) {
      if (context.length < width) continue;
      const key = context.slice(-width).join(" ");
      for (const entry of evidence("~" + key)?.split("|") ?? []) {
        const [word, percent] = entry.split(",");
        const probability = Number(percent) / 100;
        if (word && probability > 0) words.set(word, Math.max(words.get(word) ?? 0, probability * width / 3));
      }
      const phrase = evidence(key);
      if (phrase) {
        const first = phrase.split(" ")[0];
        const confidence = evidence("!" + key) !== undefined ? 0.72 : 0.48;
        words.set(first, Math.max(words.get(first) ?? 0, confidence * width / 3));
      }
      if (words.size >= 3) break;
    }
    return new Map([...words].sort((left, right) => right[1] - left[1]).slice(0, 4));
  }

  /**
   * Считает наблюдения для каждой длины совпадающего префикса. Конец фразы
   * засчитывается в общее число наблюдений и уменьшает долю продолжения.
   * @param {PassageTerm[][]} history @param {string[]} context @param {string} first
   */
  function observations(history, context, first) {
    /** @type {Map<string, PhraseConfidenceObservation>} */
    const endings = new Map();
    const opportunities = new Uint32Array(MAX_PREFIX + 1);
    for (const [age, words] of history.entries()) {
      for (const [index, token] of words.entries()) {
        if (token.word !== first) continue;
        let width = 0;
        while (width < MAX_PREFIX && context.at(-width - 1) && words[index - width]?.contiguous &&
            words[index - width - 1]?.word === context.at(-width - 1)) width += 1;
        for (let length = 0; length <= width; length += 1) opportunities[length] += 1;
        if (!words[index + 1]?.contiguous) continue;
        const second = words[index + 1].word;
        const variants = words[index + 2]?.contiguous ? [second, second + " " + words[index + 2].word] : [second];
        for (const text of variants) {
          const signs = endings.get(text) ?? { hits: new Uint32Array(MAX_PREFIX + 1), recent: 0 };
          for (let length = 0; length <= width; length += 1) signs.hits[length] += 1;
          signs.recent = Math.max(signs.recent, 1 / (1 + age * 0.35));
          endings.set(text, signs);
        }
      }
    }
    return { endings, opportunities };
  }

  /**
   * Меняет только окончание первого варианта, оставляя его первое слово и другие варианты.
   * @param {string[]} options @param {string[]} local @param {string[]} history
   * @param {string[]} context @param {NeuralLanguage} language @param {NeuralModel} model @returns {string[]}
   */
  function apply(options, local, history, context, language, model) {
    const [primary] = options;
    if (!primary) return options;
    const [first, ...existing] = primary.split(" ");
    const probabilities = corpusProbabilities(model.phraseEvidence, [...context, first.toLowerCase()]);
    const prepared = neuralDocumentPassage.prepare(history);
    const { endings, opportunities } = observations(prepared, context, first.toLowerCase());
    const recovered = [...endings].filter(([, item]) => item.hits[2] > 0 || item.hits[1] >= 2)
      .sort((left, right) => right[1].hits[2] - left[1].hits[2] || right[1].hits[1] - left[1].hits[1])
      .slice(0, MAX_RECOVERED).map(([text]) => text);
    const alternatives = new Set(existing.length ? [existing.join(" ")] : []);
    for (const [word, probability] of probabilities) {
      if (probability >= MIN_CORPUS_PROBABILITY) alternatives.add(word === "i" ? "I" : word);
    }
    for (const phrase of recovered) alternatives.add(phrase);
    if (!alternatives.size) return options;

    const { threshold, weights } = settings[language];
    let answer = first;
    let best = -Infinity;
    for (const ending of alternatives) {
      const normalized = ending.toLowerCase();
      const [second, third] = normalized.split(" ");
      const output = first + " " + ending;
      const evidence = endings.get(normalized);
      const hits = evidence?.hits;
      let width = MAX_PREFIX;
      while (width >= 0 && !hits?.[width]) width -= 1;
      const count = width >= 0 ? hits[width] : 0;
      const competing = width >= 0 ? opportunities[width] : 0;
      const features = [
        1, Math.log1p(25 * (probabilities.get(second) ?? 0)), Number(output === primary), Number(local.includes(output)),
        Number(Boolean(third)), Math.min(1, context.length / 20), Math.log1p(hits?.[0] ?? 0), Math.log1p(hits?.[2] ?? 0),
        Math.max(0, width), competing ? count / competing : 0, Math.log1p(competing - count), evidence?.recent ?? 0,
      ];
      const score = weights.reduce((sum, weight, index) => sum + weight * features[index], 0);
      const probability = 1 / (1 + Math.exp(-score));
      if (probability < threshold || probability <= best) continue;
      answer = output;
      best = probability;
    }
    return answer === primary ? options : [answer, ...options.slice(1)];
  }

  return { apply };
})();
