/**
 * Дополняет список уверенной фразой с тем же первым словом.
 * Использует корпусные частоты и историю, сохраняя первый вариант.
 */
"use strict";

const neuralPhraseAlternative = (() => {
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const SENTENCE_END = /\n+|(?<=[.!?…])\s+/u;
  const OPTION_LIMIT = 3;
  /** @type {Record<NeuralLanguage, { threshold: number, weights: number[] }>} */
  const settings = {
    ru: { threshold: 0.3, weights: [-4.641865787790225, 1.1597707759515044, 0.7223715295580594, 0, 0, 0, 0.2749314106408927, 0.7722512348705655, 0.7068499076230836, 0.4293132962982551] },
    kk: { threshold: 0.38, weights: [-3.9548821051702743, 0.753156402539742, 0.5321091132808327, 0, 0.2993208014984589, 0, 0.13834998197378548, 0.2070605251687513, 0.098793300796591, 0.17794035558761756] },
    en: { threshold: 0.6, weights: [-4.515480571209347, 1.5355844994184285, 0.026399529455035348, 0, 0.2985275192363672, 0, 1.0951513068465206, 0.9922665515974968, 0.6590082712540184, -0.3848490528423889] },
  };
  /** @type {{ raw: string, words: string[][] } | undefined} */
  let prepared;

  /** @param {string} raw @returns {string[][]} */
  function sentences(raw) {
    if (prepared?.raw !== raw) {
      const words = raw.toLowerCase().replaceAll("’", "'").split(SENTENCE_END).slice(-12).reverse()
        .map(sentence => sentence.match(WORD) ?? []);
      prepared = { raw, words };
    }
    return prepared.words;
  }

  /** @param {string[][]} history @param {string} first @param {string} second @param {string} last @param {Set<string>} topics */
  function evidence(history, first, second, last, topics) {
    let exact = 0;
    let mentioned = 0;
    let relevant = 0;
    let matched = 0;
    for (const [age, words] of history.entries()) {
      let found = false;
      let phrase = false;
      let anchored = false;
      for (const [index, word] of words.entries()) {
        if (word !== second) continue;
        found = true;
        if (words[index - 1] !== first) continue;
        phrase = true;
        if (words[index - 2] === last) anchored = true;
      }
      if (!found) continue;
      const nearby = new Set(words.map(word => word.slice(0, 5)).filter(word => topics.has(word))).size;
      mentioned += 1 / (1 + age * 0.4);
      exact += Number(phrase);
      matched += Number(anchored);
      relevant = Math.max(relevant, nearby / (1 + age * 0.35));
    }
    return [Math.log1p(mentioned), Math.log1p(exact), Math.log1p(matched), relevant];
  }

  /**
   * Добавляет фразу в свободное место при достаточном подтверждении.
   * @param {string[]} options @param {string[]} local @param {string} raw
   * @param {string[]} context @param {NeuralLanguage} language @param {NeuralModel} model @returns {string[]}
   */
  function append(options, local, raw, context, language, model) {
    const [first] = options;
    const index = model.alternativePriors;
    if (!index || !raw || !first || first.includes(" ") || options.length >= OPTION_LIMIT) return options;
    const lower = first.toLowerCase();
    const last = context.at(-1);
    const specific = neuralPhraseAlternativeIndex.lookup(index, last + " " + lower);
    const general = neuralPhraseAlternativeIndex.lookup(index, lower);
    const candidates = new Set([...specific.keys(), ...general.keys()]);
    if (!candidates.size) return options;
    const history = sentences(raw);
    const topics = new Set(context.slice(-8).filter(word => word.length >= 5 && (model.vocabulary.get(word) ?? Infinity) >= 120)
      .map(word => word.slice(0, 5)));
    const { threshold, weights } = settings[language];
    let best;
    let confidence = threshold;
    for (const word of candidates) {
      const second = word.toLowerCase();
      const text = first + " " + word;
      const features = [1, Math.log1p(30 * (specific.get(second) ?? 0)), Math.log1p(20 * (general.get(second) ?? 0)),
        0, Number(local.includes(text)), 0, ...evidence(history, lower, second, last, topics)];
      const score = weights.reduce((sum, weight, column) => sum + weight * features[column], 0);
      const probability = 1 / (1 + Math.exp(-score));
      if (probability <= confidence) continue;
      best = text;
      confidence = probability;
    }
    return best ? [...options, best] : options;
  }

  return { append };
})();
