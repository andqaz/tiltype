/**
 * Ранжирует двухсловное продолжение с учётом признаков уже написанного текста.
 * Использует локальные профили трёх типов документов и сохраняет текущие варианты.
 */
"use strict";

/** @typedef {Record<string, [number[], [string, number[], number][]]>} NeuralPurposePhrases */
/** @typedef {{ lexicon: PhraseAlternativeIndex, documents: number[], totalDocuments: number, phrases: NeuralPurposePhrases, thirdWords?: Record<string, string>, inventory?: PhraseAlternativeIndex }} NeuralPurposeProfile */

const neuralDocumentPurpose = (() => {
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const SUFFIX = /\p{L}+(?:['-]\p{L}+)* +\p{L}+(?:['-]\p{L}+)* $/u;
  const SENTENCE_END = /\n+|(?<=[.!?…])\s+/u;
  const MIN_SCORE = 0.4;
  const MAX_LAST_CONFIDENCE = 0.12;
  const MIN_INVENTORY_SCORE = 0.15;
  const MIN_INVENTORY_REPLACEMENT_SCORE = 0.25;
  const MAX_INVENTORY_LAST_CONFIDENCE = 0.10;
  const INVENTORY_BACKOFF = 8;
  const MAX_OPTIONS = 3;
  const HISTORY_LIMIT = 10;
  const BACKOFF_WEIGHT = 6;

  /** @param {string} text @returns {string} */
  function normalized(text) {
    return text.toLowerCase().replaceAll("’", "'");
  }

  /**
   * Открывает профили фраз и текстовый индекс частот. Отклоняет неполный ресурс.
   * @param {string} text @returns {NeuralPurposeProfile}
   */
  function open(text) {
    /** @type {{ lexicon: string, documents: number[], phrases: NeuralPurposePhrases, thirdWords?: Record<string, string> }} */
    const data = JSON.parse(text);
    if (!data?.phrases || typeof data.lexicon !== "string" || !Array.isArray(data.documents) ||
        data.documents.length !== 3 || data.documents.some(count => !Number.isSafeInteger(count) || count < 1)) {
      throw new Error("Invalid document purpose profile");
    }
    return { lexicon: neuralPhraseAlternativeIndex.open(data.lexicon), documents: data.documents,
      totalDocuments: data.documents.reduce((sum, count) => sum + count, 0), phrases: data.phrases,
      thirdWords: data.thirdWords };
  }

  /** @param {string} raw @param {NeuralPurposeProfile} profile @returns {number[]} */
  function classify(raw, { lexicon, documents, totalDocuments }) {
    const support = [0, 0, 0];
    const seen = new Set();
    let count = 0;
    const recent = normalized(raw).split(SENTENCE_END).slice(-HISTORY_LIMIT).reverse();
    for (const [age, sentence] of recent.entries()) {
      const decay = 0.87 ** age;
      for (const word of sentence.match(WORD) ?? []) {
        if (word.length < 4) continue;
        const root = word.slice(0, Math.max(4, Math.min(7, word.length - 1)));
        if (seen.has(root)) continue;
        seen.add(root);
        const record = neuralPhraseAlternativeIndex.find(lexicon, root);
        if (!record) continue;
        const frequencies = record.split(",").map(Number);
        const prior = frequencies.reduce((sum, frequency) => sum + frequency, 0) / totalDocuments;
        count += decay;
        for (let domain = 0; domain < support.length; domain++) {
          const likelihood = (frequencies[domain] + 24 * prior) / (documents[domain] + 24);
          support[domain] += Math.log(likelihood / prior) * decay;
        }
      }
    }
    // Рост объёма истории сам по себе не должен превращать оценку жанра в уверенность.
    const temperature = Math.max(2, 0.82 * Math.sqrt(count));
    const values = support.map(value => value / temperature);
    const maximum = Math.max(...values);
    const exp = values.map(value => Math.exp(value - maximum));
    const total = exp.reduce((sum, value) => sum + value, 0);
    return exp.map(value => value / total);
  }

  /**
   * Добавляет подтверждённую фразу. В полном списке заменяет слабое третье слово.
   * @param {string[]} options @param {string} prefix @param {string | undefined} raw
   * @param {NeuralPurposeProfile | undefined} profile @param {RankedNeuralWord[]} [rankedWords]
   * @returns {string[]}
   */
  function rank(options, prefix, raw, profile, rankedWords) {
    if (!profile || !raw || options.length > MAX_OPTIONS) return options;
    const full = options.length === MAX_OPTIONS;
    if (full) {
      const last = options.at(-1);
      if (!rankedWords || last.includes(" ")) return options;
      const confidence = rankedWords.find(item => item.word.toLowerCase() === last.toLowerCase())?.probability ?? 0;
      if (confidence > MAX_LAST_CONFIDENCE) return options;
    }
    const suffix = normalized(prefix).match(SUFFIX)?.[0].trim().replace(/ +/gu, " ");
    const entry = suffix && profile.phrases[suffix];
    if (!entry) return options;
    const [totals, candidates] = entry;
    const mixture = classify(raw, profile);
    const total = totals.reduce((sum, count) => sum + count, 0);
    let phrase;
    let best = MIN_SCORE;
    for (const [candidate, counts, documents] of candidates) {
      if (options.includes(candidate)) continue;
      const prior = counts.reduce((sum, count) => sum + count, 0) / total;
      const probability = mixture.reduce((sum, weight, domain) =>
        sum + weight * (counts[domain] + BACKOFF_WEIGHT * prior) / (totals[domain] + BACKOFF_WEIGHT), 0);
      const score = probability * (1 - 1 / (documents + 1));
      if (score < best || (phrase && score === best)) continue;
      phrase = candidate;
      best = score;
    }
    if (!phrase) return options;
    if (full) return [...options.slice(0, -1), phrase];
    const ranked = [phrase, ...options];
    if (options.length === 0 || ranked.length >= MAX_OPTIONS) return ranked;
    const third = profile.thirdWords?.[suffix + " " + phrase];
    const extended = third && phrase + " " + third;
    if (extended && !ranked.includes(extended)) ranked.push(extended);
    return ranked;
  }

  /**
   * Дополняет список корпусной фразой или заменяет слабый третий вариант.
   * @param {string[]} options @param {string} prefix @param {string | undefined} raw
   * @param {NeuralPurposeProfile | undefined} profile @param {RankedNeuralWord[]} [rankedWords]
   * @param {NeuralLanguage} [language] Язык для проверки перестановки готовых вариантов.
   * @returns {string[]}
   */
  function expand(options, prefix, raw, profile, rankedWords, language) {
    if (!profile?.inventory || !raw || !options.length || options.length > MAX_OPTIONS) return options;
    const full = options.length === MAX_OPTIONS;
    const last = options.at(-1);
    if (full && (!rankedWords || last.includes(" "))) return options;
    const suffix = normalized(prefix).match(SUFFIX)?.[0].trim().replace(/ +/gu, " ");
    const record = suffix && neuralPhraseAlternativeIndex.find(profile.inventory, suffix);
    if (!record) return options;
    if (full) {
      const word = last.toLowerCase();
      const confidence = rankedWords.find(item => item.word.toLowerCase() === word)?.probability ?? 0;
      if (confidence > MAX_INVENTORY_LAST_CONFIDENCE) return options;
    }
    const divider = record.indexOf("\t");
    if (divider < 0) return options;
    const totals = record.slice(0, divider).split(",").map(Number);
    const total = totals.reduce((sum, count) => sum + count, 0);
    const mixture = classify(raw, profile);
    let best = full ? MIN_INVENTORY_REPLACEMENT_SCORE : MIN_INVENTORY_SCORE;
    let phrase;
    /** @type {PurposePhraseEvidence | undefined} */
    let evidence;
    for (const entry of record.slice(divider + 1).split("|")) {
      const [candidate, ...frequencies] = entry.split(",");
      if (options.includes(candidate)) continue;
      const counts = frequencies.map(Number);
      const count = counts.reduce((sum, value) => sum + value, 0);
      const prior = count / total;
      const probability = mixture.reduce((sum, share, genre) =>
        sum + share * (counts[genre] + INVENTORY_BACKOFF * prior) / (totals[genre] + INVENTORY_BACKOFF), 0);
      const score = probability * (count / (count + 2));
      if (score <= best) continue;
      best = score;
      phrase = candidate;
      evidence = { count, prior, likelihood: probability };
    }
    if (!phrase) return options;
    const expanded = full ? [...options.slice(0, -1), phrase] : [...options, phrase];
    return language && rankedWords && evidence
      ? neuralPurposePromotion.rank(expanded, raw, suffix, mixture[1], language, evidence, rankedWords) : expanded;
  }

  return { open, rank, expand };
})();
