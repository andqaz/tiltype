/**
 * Оценивает перенос корпусной фразы на первое место в официальном тексте.
 * Сопоставляет вероятность текущего лидера, корпусную опору и повторы в документе.
 */
"use strict";

/** @typedef {{ count: number, prior: number, likelihood: number }} PurposePhraseEvidence */

const neuralPurposePromotion = (() => {
  const MIN_FORMAL = 0.98;
  const MIN_CONFIDENCE = 0.60;
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const SENTENCE_END = /\n+|(?<=[.!?…])\s+/u;
  const GAP = /^\s+$/u;
  /** @type {Record<NeuralLanguage, number[]>} */
  const weights = {
    ru: [1.5171364544214843, 0.2138500216159458, -0.31730529279741493, -0.8057134061499879, -1.2194448472668509, 0.042744238850689065, -1.2001024764992998, 0.3914291296838918, 0.1775791080679458, 0.0543541443472083, 0.4704607189412604, -0.04997180261367506],
    kk: [0.7023601103601042, -0.05341265232720591, -0.030077331784035773, -0.11281596802704051, -0.19160216311094314, -0.6419156266855919, -0.7068452483962686, 0.1565850968819869, 0.20999774920919292, -0.12468443468371916, 0.2530339695766601, -0.5570023715816312],
    en: [0.1260295673766981, 1.0213905186029695, 0.012926586756709262, -0.4351562386618473, -0.23726135313425267, -0.44690367649141927, -1.6012873516126782, 0.9141574722111053, -0.10723304639185875, 0.9131841354517953, -1.031445858796269, -0.016029730649411673],
  };

  /**
   * Выбирает порядок уже составленного списка. Набор вариантов остаётся прежним.
   * @param {string[]} options @param {string} raw @param {string} key @param {number} formal
   * @param {NeuralLanguage} language @param {PurposePhraseEvidence} evidence @param {RankedNeuralWord[]} ranked
   * @returns {string[]}
   */
  function rank(options, raw, key, formal, language, { count, prior, likelihood }, ranked) {
    if (formal < MIN_FORMAL) return options;
    const candidate = options.at(-1);
    const [first, second] = candidate.split(" ");
    const leader = options[0].toLowerCase().split(" ")[0];
    /** @param {string} word */
    const neural = word => ranked.find(item => item.word.toLowerCase() === word)?.probability ?? 0;
    let copies = 0;
    let anchorMatches = 0;
    let mentions = 0;
    const recent = raw.toLowerCase().replaceAll("’", "'").split(SENTENCE_END).slice(-12);
    for (const sentence of recent) {
      const words = [...sentence.matchAll(WORD)];
      /** @param {number} index */
      const contiguous = index => index > 0 && GAP.test(sentence.slice(
        words[index - 1].index + words[index - 1][0].length, words[index].index));
      for (const [index, word] of words.entries()) {
        if (word[0] === first) mentions++;
        if (word[0] !== first || words[index + 1]?.[0] !== second || !contiguous(index + 1)) continue;
        copies++;
        if (contiguous(index) && contiguous(index - 1) &&
            words[index - 2][0] + " " + words[index - 1][0] === key) anchorMatches++;
      }
    }
    const features = [1, prior, Math.log1p(count), neural(first), neural(leader),
      Number(first === leader), Number(options[0].includes(" ")), likelihood, likelihood - prior,
      Math.log1p(copies), Math.log1p(anchorMatches), Math.log1p(mentions)];
    const logit = weights[language].reduce((sum, weight, index) => sum + weight * features[index], 0);
    return 1 / (1 + Math.exp(-logit)) >= MIN_CONFIDENCE ? [candidate, ...options.slice(0, -1)] : options;
  }

  return { rank };
})();
