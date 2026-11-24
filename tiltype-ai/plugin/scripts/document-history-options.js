/**
 * Добавляет на свободное место фразу из предыдущих предложений.
 * Учитывает совпадение конструкции, близость темы и конкурирующие окончания.
 */
"use strict";

/** @typedef {{ text: string, connected: boolean }} HistoryOptionTerm */
/** @typedef {{ count: number, width: number, topic: number, recent: number, aligned: number }} HistoryCompletionEvidence */

const neuralDocumentHistoryOptions = (() => {
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const BOUNDARY = /\n+|(?<=[.!?…])\s+/u;
  const GAP = /^\s+$/u;
  const HISTORY_LIMIT = 16;
  const OPTION_LIMIT = 3;
  const MAX_ALIGNMENT = 6;
  const CANDIDATE_LIMIT = 10;
  /** @type {Record<NeuralLanguage, { threshold: number, weights: number[] }>} */
  const settings = {
    ru: { threshold: 0.3, weights: [-2.3765751242629345, -0.6017449415818021, 0.20449960060943215, -0.8213000704018513, 0.0555979366912442, 0.4660944320437378, -0.050899272447330446, 0.04775400624430672, 0.06762827884444948, 1.341420990908381] },
    kk: { threshold: 0.18, weights: [-2.5775628215899626, -0.5618629193065962, 0.5519663567712888, -0.6404543441471583, -0.06735386034222708, 0.2344641911802845, 0.3634573015521677, 0.24105010039389418, -0.0006768144953184568, 0.8279235778409789] },
    en: { threshold: 0.45, weights: [-3.128001247355979, -0.7218447687532691, 0.19168304022864166, -0.41000282559746126, 0.6844530248148174, 0.5805961356523623, -0.04794874614691754, 0.1576861377596341, 0.27791784604225395, 1.2903954340076642] },
  };
  /** @type {{ source: string, entries: HistoryOptionTerm[][] } | undefined} */
  let cached;

  /** @param {string} raw @returns {HistoryOptionTerm[][]} */
  function paragraphs(raw) {
    if (cached?.source === raw) return cached.entries;
    const entries = raw.toLowerCase().replaceAll("’", "'").split(BOUNDARY).slice(-HISTORY_LIMIT).reverse().map(sentence => {
      const words = [...sentence.matchAll(WORD)];
      return words.map((word, index) => ({ text: word[0], connected: index > 0 &&
        GAP.test(sentence.slice(words[index - 1].index + words[index - 1][0].length, word.index)) }));
    });
    cached = { source: raw, entries };
    return entries;
  }

  /** @param {PhraseEvidenceLookup} evidence @param {string[]} context @param {string} word */
  function support(evidence, context, word) {
    for (const width of [3, 2, 1]) {
      if (width > context.length) continue;
      const data = evidence("~" + context.slice(-width).join(" "));
      if (!data) continue;
      const value = data.split("|").find(pair => pair.split(",")[0] === word);
      if (value) return Number(value.split(",")[1]) / 100 * width / 3;
    }
    return 0;
  }

  /**
   * Восстанавливает только смежные слова и считает случаи другого продолжения.
   * @param {string} raw @param {string} first @param {string[]} context @param {NeuralModel} model
   */
  function observe(raw, first, context, model) {
    const topics = new Set(context.slice(-10).filter(word => word.length >= 5 && (model.vocabulary.get(word) ?? Infinity) >= 130)
      .map(word => word.slice(0, 5)));
    /** @type {Map<string, HistoryCompletionEvidence>} */
    const counts = new Map();
    let alignedCount = 0;
    for (const [age, sentence] of paragraphs(raw).entries()) {
      const intersection = new Set(sentence.map(item => item.text.slice(0, 5)).filter(root => topics.has(root))).size;
      for (const [index, item] of sentence.entries()) {
        if (item.text !== first) continue;
        let width = 0;
        while (width < MAX_ALIGNMENT && sentence[index - width]?.connected && context.at(-1 - width) &&
            sentence[index - width - 1]?.text === context.at(-1 - width)) width += 1;
        const aligned = Number(width >= 2);
        alignedCount += aligned;
        const next = sentence[index + 1];
        if (!next?.connected || (!width && intersection < 2)) continue;
        const endings = sentence[index + 2]?.connected ? [next.text, next.text + " " + sentence[index + 2].text] : [next.text];
        for (const ending of endings) {
          const value = counts.get(ending) ?? { count: 0, width: 0, topic: 0, recent: 0, aligned: 0 };
          value.count += 1;
          value.width = Math.max(value.width, width);
          value.topic = Math.max(value.topic, intersection / (1 + age * 0.16));
          value.recent = Math.max(value.recent, 1 / (1 + age * 0.25));
          value.aligned += aligned;
          counts.set(ending, value);
        }
      }
    }
    return { counts, alignedCount };
  }

  /**
   * Добавляет самый уверенный новый вариант, сохраняя все показанные подсказки.
   * @param {string[]} options @param {string} raw @param {string[]} context
   * @param {NeuralLanguage} language @param {NeuralModel} model @returns {string[]}
   */
  function append(options, raw, context, language, model) {
    const [first] = options;
    if (!first || first.includes(" ") || options.length >= OPTION_LIMIT || !raw) return options;
    const lower = first.toLowerCase();
    const { counts, alignedCount } = observe(raw, lower, context, model);
    const candidates = [...counts].sort((left, right) => right[1].width - left[1].width || right[1].count - left[1].count)
      .slice(0, CANDIDATE_LIMIT);
    const prefix = [...context, lower];
    const { threshold, weights } = settings[language];
    let best;
    let confidence = threshold;
    for (const [ending, evidence] of candidates) {
      const choice = first + " " + ending;
      if (options.includes(choice)) continue;
      const features = [1, Number(ending.includes(" ")),
        Math.log1p(25 * support(model.phraseEvidence, prefix, ending.split(" ")[0])),
        context.length / 24, Math.log1p(evidence.count), evidence.width, evidence.topic, evidence.recent,
        Math.log1p(evidence.aligned), evidence.aligned / Math.max(1, alignedCount)];
      const score = weights.reduce((sum, weight, index) => sum + weight * features[index], 0);
      const probability = 1 / (1 + Math.exp(-score));
      if (probability <= confidence) continue;
      best = choice;
      confidence = probability;
    }
    return best ? [...options, best] : options;
  }

  return { append };
})();
