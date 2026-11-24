/**
 * Повышает позицию фразы по тематике предыдущих предложений.
 * Переиспользует декодированные строки и часто встречающиеся векторы фраз.
 */
"use strict";

const neuralDocumentVectorRank = (() => {
  const WORD = /\p{L}+(?:['’-]\p{L}+)*/gu;
  const SENTENCE_END = /\n+|(?<=[.!?…])\s+/u;
  const SUFFIX = /\p{L}+(?:['-]\p{L}+)* +\p{L}+(?:['-]\p{L}+)* $/u;
  const THRESHOLD = 0.06;
  const WORD_CACHE_LIMIT = 2048;
  const PHRASE_CACHE_LIMIT = 256;
  /** @type {WeakMap<NeuralModel, { rows: Map<number, Float32Array>, phrases: Map<string, Float32Array> }>} */
  const modelCache = new WeakMap();
  /** @type {{ raw: string, terms: Map<string, number> } | undefined} */
  let history;

  /** @param {string} text @returns {string[]} */
  function words(text) {
    return text.toLowerCase().replaceAll("’", "'").match(WORD) ?? [];
  }

  /** @param {string} raw */
  function historyTerms(raw) {
    if (history?.raw === raw) return history.terms;
    const terms = new Map();
    const recent = raw.trimEnd().split(SENTENCE_END).slice(-7).reverse();
    for (const [age, sentence] of recent.entries()) {
      for (const word of new Set(words(sentence))) {
        if (word.length >= 4 && !terms.has(word)) terms.set(word, 0.82 ** age);
      }
    }
    history = { raw, terms };
    return terms;
  }

  /** @param {NeuralModel} model */
  function cacheFor(model) {
    let stored = modelCache.get(model);
    if (!stored) {
      stored = { rows: new Map(), phrases: new Map() };
      modelCache.set(model, stored);
    }
    return stored;
  }

  /** @template K @param {Map<K, Float32Array>} cache @param {K} key @param {Float32Array} value @param {number} limit */
  function remember(cache, key, value, limit) {
    if (cache.size >= limit) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, value);
    return value;
  }

  /**
   * Усредняет квантованные эмбеддинги с тем же округлением, что при обучении.
   * @param {Iterable<[string, number]>} terms @param {NeuralModel} model @param {Set<string>} [excluded]
   * @returns {Float32Array}
   */
  function vector(terms, model, excluded) {
    const { columns, values, scale } = model.embedding;
    const result = new Float32Array(columns);
    const { rows } = cacheFor(model);
    for (const [word, weight] of terms) {
      if (excluded?.has(word)) continue;
      const id = model.vocabulary.get(word);
      if (id === undefined) continue;
      let embedding = rows.get(id);
      if (!embedding) {
        const decoded = new Float32Array(columns);
        for (let column = 0; column < columns; column++) decoded[column] = values[id * columns + column] * scale[id];
        embedding = remember(rows, id, decoded, WORD_CACHE_LIMIT);
      }
      for (let column = 0; column < columns; column++) {
        result[column] += embedding[column] * weight;
      }
    }
    const norm = Math.hypot(...result);
    if (norm > 0) for (let column = 0; column < columns; column++) result[column] /= norm;
    return result;
  }

  /** @param {string} text @param {NeuralModel} model */
  function phraseVector(text, model) {
    const { phrases } = cacheFor(model);
    const cached = phrases.get(text);
    if (cached) return cached;
    /** @type {[string, number][]} */
    const terms = [];
    for (const [index, word] of words(text).entries()) terms.push([word, index === 0 ? 1 : 0.85]);
    return remember(phrases, text, vector(terms, model), PHRASE_CACHE_LIMIT);
  }

  /** @param {Float32Array} matrix @param {Float32Array} query */
  function transform(matrix, query) {
    const width = query.length;
    const result = new Float64Array(width);
    for (let row = 0; row < width; row++) {
      if (query[row] === 0) continue;
      const offset = row * width;
      for (let column = 0; column < width; column++) result[column] += query[row] * matrix[offset + column];
    }
    return result;
  }

  /** @param {string} prefix @param {PhraseAlternativeIndex | undefined} index */
  function inventory(prefix, index) {
    const suffix = prefix.toLowerCase().replaceAll("’", "'").match(SUFFIX)?.[0].trim().replace(/ +/gu, " ");
    const record = suffix && index && neuralPhraseAlternativeIndex.find(index, suffix);
    if (!record) return new Map();
    const separator = record.indexOf("\t");
    const total = record.slice(0, separator).split(",").reduce((sum, value) => sum + Number(value), 0);
    return new Map(record.slice(separator + 1).split("|").map(entry => {
      const [text, ...counts] = entry.split(",");
      return [text, counts.reduce((sum, value) => sum + Number(value), 0) / total];
    }));
  }

  /**
   * Переносит подтверждённую фразу на первое место, сохраняя прежние фразы.
   * @param {string[]} options @param {string} prefix @param {string} raw
   * @param {NeuralModel} model @param {PhraseAlternativeIndex | undefined} index
   * @param {Float32Array | undefined} weights @returns {string[]}
   */
  function rank(options, prefix, raw, model, index, weights) {
    if (!weights || !raw || !options.length || options[0].includes(" ")) return options;
    const priors = inventory(prefix, index);
    const alternatives = [...new Set([...options.slice(1), ...priors.keys()])]
      .filter(text => text !== options[0] && text.includes(" "));
    if (!alternatives.length) return options;
    const query = transform(weights, vector(historyTerms(raw), model, new Set(words(prefix))));
    const candidates = alternatives.map(text => {
      const position = options.indexOf(text);
      return { text, prior: position >= 0 ? 0.8 - 0.19 * position : 0.55 * (priors.get(text) ?? 0) };
    });
    // Оценки обеих нормированных фраз ограничены длиной преобразованного вектора.
    const possibleBonus = 0.9 * Math.hypot(...query) + 0.000001;
    if (candidates.every(candidate => candidate.prior + possibleBonus <= 0.8 + THRESHOLD)) return options;
    /** @param {string} text @param {number} prior */
    const score = (text, prior) => {
      const phrase = phraseVector(text, model);
      let sum = 0;
      for (let column = 0; column < phrase.length; column++) sum += query[column] * phrase[column];
      return prior + 0.45 * sum;
    };
    let criterion = score(options[0], 0.8) + THRESHOLD;
    let chosen;
    for (const { text, prior } of candidates) {
      const value = score(text, prior);
      if (value <= criterion) continue;
      criterion = value;
      chosen = text;
    }
    if (!chosen) return options;
    const remaining = options.filter(text => text !== chosen);
    if (remaining.length < 3 || !remaining[2].includes(" ")) return [chosen, ...remaining.slice(0, 2)];
    return remaining[1].includes(" ") ? options : [chosen, remaining[0], remaining[2]];
  }

  /**
   * Сравнивает локальный вектор фразы с взвешенной тематикой документа.
   * @param {Iterable<[string, number]>} terms @param {NeuralModel} model
   * @returns {(phrase: string) => number}
   */
  function topicAffinity(terms, model) {
    const query = vector(terms, model);
    return phrase => {
      const candidate = phraseVector(phrase, model);
      let score = 0;
      for (let column = 0; column < query.length; column++) score += query[column] * candidate[column];
      return score;
    };
  }

  return { rank, topicAffinity };
})();
