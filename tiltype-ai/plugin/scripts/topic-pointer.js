/**
 * Дополняет нейронные варианты словами из предыдущих предложений.
 * Сопоставляет окончания и порядок слов с локальным контекстом.
 */
"use strict";

/** @typedef {{ profile: Record<string, [number, Record<string, number>]>, global: Record<string, number>, total: number }} TopicPointerProfile */
/** @typedef {{ output: string, first: string, affinity: number, count: number, relevance: number, exact: number, recent: number }} TopicPointerCandidate */

const neuralTopicPointer = (() => {
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const GAP = /^\s+$/u;
  const SENTENCE_END = /\n+|(?<=[.!?…])\s+/u;
  const HISTORY_LIMIT = 10;
  const CANDIDATE_LIMIT = 12;
  const MIN_CONFIDENCE = 0.14;
  /** @type {Record<NeuralLanguage, number[]>} */
  const weights = {
    ru: [-5.243707074978124, 0.6196265762446704, -0.02929386382811231, 0.3348950964409016, -0.8594229651816062, 0.9147948447738397, -0.1470204948194101, 1.8700506023537826, -0.32254136481775136],
    kk: [-4.389655839599269, 0.19299964505778866, 0.43694150791373804, 0.3283544094160813, -0.9867257158266443, 0.16403990941909227, -0.6799624255973713, 1.6730365094071156, -0.2805074405418152],
    en: [-5.724883950245078, 0.6075345765245738, 0.08115836184687192, -0.30988290953632797, -1.0927305631154065, 0.643232250560391, 0.07718359547146765, 1.8970609059381043, -0.4140798534489181],
  };
  /** @type {{ source: string, entries: { text: string, words: RegExpMatchArray[] }[] } | undefined} */
  let parsed;

  /** @param {string} raw */
  function history(raw) {
    if (parsed?.source !== raw) {
      const entries = raw.toLowerCase().replaceAll("’", "'").split(SENTENCE_END).filter(Boolean)
        .slice(-HISTORY_LIMIT).reverse().map(text => ({ text, words: [...text.matchAll(WORD)] }));
      parsed = { source: raw, entries };
    }
    return parsed.entries;
  }

  /** @param {TopicPointerProfile} data @param {string} anchor @param {string} word */
  function endingEvidence(data, anchor, word) {
    const [total, counts] = Object.hasOwn(data.profile, anchor) ? data.profile[anchor] : [0, {}];
    const suffix = word.slice(-3);
    const global = (data.global[suffix] ?? 0) / data.total;
    return Math.log1p((counts[suffix] ?? 0) / (1 + total * global));
  }

  /** @param {PhraseEvidenceLookup} evidence @param {string[]} context */
  function corpusWeights(evidence, context) {
    /** @type {Map<string, number>} */
    const scores = new Map();
    for (const width of [3, 2, 1]) {
      if (context.length < width) continue;
      const key = context.slice(-width).join(" ");
      for (const entry of evidence("~" + key)?.split("|") ?? []) {
        const [candidate, frequency] = entry.split(",");
        if (!scores.has(candidate)) scores.set(candidate, Math.log1p(Number(frequency) / 8) * width / 3);
      }
    }
    return scores;
  }

  /** @param {NeuralModel} model @param {string} word */
  function informative(model, word) {
    return word.length >= 4 && word.length <= 24 && (model.vocabulary.get(word) ?? Infinity) >= 120;
  }

  /** @param {TopicPointerCandidate} candidate */
  function strength(candidate) {
    return candidate.affinity + candidate.relevance * 0.5 + candidate.exact * 1.5 +
      Math.log1p(candidate.count) + candidate.recent * 0.25;
  }

  /**
   * Ищет смежные слова в истории, оставляя их исходные словоформы.
   * @param {string} raw @param {string[]} context @param {string} primary
   * @param {NeuralModel} model @param {TopicPointerProfile} profile @returns {TopicPointerCandidate[]}
   */
  function retrieve(raw, context, primary, model, profile) {
    const anchors = new Set(context.slice(-8, -1).filter(word => informative(model, word)).map(word => word.slice(0, 5)));
    const used = new Set(context.slice(-4));
    const last = context.at(-1);
    const previous = context.at(-2);
    /** @type {Map<string, TopicPointerCandidate>} */
    const results = new Map();
    for (const [age, { text, words }] of history(raw).entries()) {
      const shared = new Set(words.map(term => term[0].slice(0, 5)).filter(term => anchors.has(term))).size;
      const seen = new Set();
      for (let index = 1; index < words.length; index += 1) {
        const first = words[index][0];
        if (first === primary || used.has(first) || !informative(model, first)) continue;
        const prior = words[index - 1];
        if (!GAP.test(text.slice(prior.index + prior[0].length, words[index].index))) continue;
        const finalMatch = prior[0] === last;
        const penultimate = words[index - 2]?.[0] === previous;
        const affinity = endingEvidence(profile, last, first);
        if (!finalMatch && !shared && affinity < 0.45) continue;
        const next = words[index + 1];
        const outputs = next && GAP.test(text.slice(words[index].index + first.length, next.index))
          ? [first, first + " " + next[0]] : [first];
        for (const output of outputs) {
          if (seen.has(output)) continue;
          seen.add(output);
          const item = results.get(output) ?? { output, first, affinity, count: 0, relevance: 0, exact: 0, recent: 0 };
          item.count += 1;
          item.relevance = Math.max(item.relevance, shared);
          item.exact = Math.max(item.exact, finalMatch ? penultimate ? 2 : 1 : 0);
          item.recent = Math.max(item.recent, 1 / (1 + age * 0.2));
          results.set(output, item);
        }
      }
    }
    return [...results.values()].sort((left, right) => strength(right) - strength(left)).slice(0, CANDIDATE_LIMIT);
  }

  /**
   * Повышает подтверждённое историей продолжение. Сохраняет готовую целую фразу.
   * @param {string[]} options @param {string} raw @param {string[]} context
   * @param {NeuralLanguage} language @param {NeuralModel} model @returns {string[]}
   */
  function rank(options, raw, context, language, model) {
    const primary = options[0];
    const profile = model.pointerProfile;
    if (!raw || !profile || context.length < 2 || !primary || primary.includes(" ")) return options;
    const candidates = retrieve(raw, context, primary.toLowerCase(), model, profile);
    if (!candidates.length) return options;
    const baseline = new Set(options.map(option => option.split(" ")[0].toLowerCase()));
    const corpus = corpusWeights(model.phraseEvidence, context);
    const coefficients = weights[language];
    let best;
    let confidence = MIN_CONFIDENCE;
    for (const candidate of candidates) {
      const features = [1, candidate.affinity, corpus.get(candidate.first) ?? 0, Number(baseline.has(candidate.first)),
        Number(candidate.output.includes(" ")), Math.log1p(candidate.count), candidate.relevance, candidate.exact, candidate.recent];
      const score = coefficients.reduce((sum, weight, index) => sum + weight * features[index], 0);
      const probability = 1 / (1 + Math.exp(-score));
      if (probability <= confidence) continue;
      best = candidate;
      confidence = probability;
    }
    return best ? [best.output, ...options.filter(option => option.toLowerCase().split(" ")[0] !== best.first)].slice(0, 3) : options;
  }

  return { rank };
})();
