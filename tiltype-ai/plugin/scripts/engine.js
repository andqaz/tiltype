/**
 * Выполняет локальный нейронный прогноз на процессоре через JavaScript.
 * Использует только поставляемые int8-веса и словарь выходных классов.
 */
"use strict";

/** @typedef {{ rows: number, columns: number, start: number, scale: number, bias: number | null }} MatrixSpec */
/** @typedef {{ start: number, projection: MatrixSpec, classifier: MatrixSpec }} TailSpec */
/** @typedef {{ contextSize: number, unknownBuckets: number, words: string[], shortlist: number, embedding: MatrixSpec, context: MatrixSpec, head: MatrixSpec, tails: TailSpec[] }} ModelSpec */
/** @typedef {{ rows: number, columns: number, values: Int8Array, scale: Float32Array, bias: Float32Array | null }} QuantizedMatrix */
/** @typedef {(key: string) => string | undefined} PhraseEvidenceLookup */
/** @typedef {{ words: string[], vocabulary: Map<string, number>, phraseEvidence: PhraseEvidenceLookup, pointerProfile?: TopicPointerProfile, alternativePriors?: PhraseAlternativeIndex, purposeProfile?: NeuralPurposeProfile, topics?: NeuralTopicTables, documentVector?: Float32Array, shortlist: number, contextSize: number, unknownBuckets: number, embedding: QuantizedMatrix, context: QuantizedMatrix, head: QuantizedMatrix, input: Float32Array, hidden: Float32Array, activeHidden: Uint16Array, headLogits: Float32Array, tails: { start: number, projection: QuantizedMatrix, classifier: QuantizedMatrix, projected: Float32Array, logits: Float32Array }[] }} NeuralModel */
/** @typedef {"en" | "ru" | "kk"} NeuralLanguage */
/** @typedef {Partial<Record<NeuralLanguage, NeuralModel>>} NeuralModels */
/** @typedef {{ word: string, probability: number }} RankedNeuralWord */

const neuralEngine = (() => {
  const LANGUAGES = /** @type {const} */ (["en", "ru", "kk"]);
  const CONTEXT = /(?:^|[^\p{L}\p{N}'-])((?:\p{L}+(?:['-]\p{L}+)* +){0,5}\p{L}+(?:['-]\p{L}+)*) $/u;
  const LATIN = /^[a-z]+(?:['-][a-z]+)*$/;
  const CYRILLIC = /^[а-яёәғқңөұүһі]+(?:['-][а-яёәғқңөұүһі]+)*$/;
  const KAZAKH_LETTERS = /[әғқңөұүһі]/;
  const LAST_CONTEXT_CHARS = 150;
  const SENTENCE_CHARS = 600;
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const SENTENCE_BOUNDARY = /[.!?…\r\n]/u;
  const MAX_OPTIONS = 3;
  const DOCUMENT_WORDS = 6;
  const MIN_WORD_CONFIDENCE = 0.045;
  const MIN_CORPUS_WORD_CONFIDENCE = 0.17;
  const CORPUS_WORD_WEIGHT = 0.35;
  const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  /**
   * Читает упакованные матрицы и создаёт индекс слов для одной модели.
   * @param {ModelSpec} descriptor Метаданные экспорта.
   * @param {ArrayBuffer} weights Бинарные веса.
   * @param {Record<string, string> | PhraseEvidenceLookup} [phraseEvidence] Подтверждённые корпусом фразы.
   * @returns {NeuralModel} Модель, готовая к вычислениям.
   */
  function decode(descriptor, weights, phraseEvidence = {}) {
    const view = new DataView(weights);
    /** @param {number} start @param {number} length */
    function floats(start, length) {
      if (LITTLE_ENDIAN && start % Float32Array.BYTES_PER_ELEMENT === 0) {
        return new Float32Array(weights, start, length);
      }
      // Старые или тестовые веса могут размещать шкалы по невыровненным адресам.
      return Float32Array.from({ length }, (_, index) => view.getFloat32(start + index * 4, true));
    }
    /** @param {MatrixSpec} spec */
    const matrix = ({ rows, columns, start, scale, bias }) => ({
      rows, columns,
      values: new Int8Array(weights, start, rows * columns),
      scale: floats(scale, rows),
      bias: bias === null ? null : floats(bias, rows),
    });
    const vocabulary = new Map();
    for (let index = 0; index < descriptor.words.length; index += 1) {
      vocabulary.set(descriptor.words[index], index + 1);
    }
    return {
      words: descriptor.words,
      vocabulary,
      phraseEvidence: typeof phraseEvidence === "function" ? phraseEvidence :
        key => Object.hasOwn(phraseEvidence, key) ? phraseEvidence[key] : undefined,
      shortlist: descriptor.shortlist,
      contextSize: descriptor.contextSize,
      unknownBuckets: descriptor.unknownBuckets,
      embedding: matrix(descriptor.embedding),
      context: matrix(descriptor.context),
      head: matrix(descriptor.head),
      input: new Float32Array(descriptor.contextSize * descriptor.embedding.columns),
      hidden: new Float32Array(descriptor.context.rows),
      activeHidden: new Uint16Array(descriptor.context.rows),
      headLogits: new Float32Array(descriptor.head.rows),
      tails: descriptor.tails.map(({ start, projection, classifier }) => ({
        start, projection: matrix(projection), classifier: matrix(classifier),
        projected: new Float32Array(projection.rows),
        logits: new Float32Array(classifier.rows),
      })),
    };
  }

  /** @param {QuantizedMatrix} matrix @param {Float32Array} input @param {Float32Array} result
   * @param {number} [firstColumn] Нулевые позиции слева от фактически набранных слов.
   */
  function multiply(matrix, input, result, firstColumn = 0) {
    const { rows, columns, values, scale, bias } = matrix;
    for (let row = 0, offset = 0; row < rows; row += 1, offset += columns) {
      let sum = 0;
      // Развёртка сокращает служебные операции, сохраняя порядок сложений.
      let column = firstColumn;
      for (; column + 3 < columns; column += 4) {
        sum += input[column] * values[offset + column];
        sum += input[column + 1] * values[offset + column + 1];
        sum += input[column + 2] * values[offset + column + 2];
        sum += input[column + 3] * values[offset + column + 3];
      }
      for (; column < columns; column += 1) {
        sum += input[column] * values[offset + column];
      }
      result[row] = sum * scale[row] + (bias?.[row] ?? 0);
    }
  }

  /**
   * Умножает строку на ненулевые активации ReLU в исходном порядке.
   * @param {QuantizedMatrix} matrix
   * @param {Float32Array} input
   * @param {Uint16Array} active
   * @param {number} count
   * @param {Float32Array} result
   */
  function multiplyActive(matrix, input, active, count, result) {
    const { rows, columns, values, scale, bias } = matrix;
    for (let row = 0, offset = 0; row < rows; row += 1, offset += columns) {
      let sum = 0;
      for (let index = 0; index < count; index += 1) {
        const column = active[index];
        sum += input[column] * values[offset + column];
      }
      result[row] = sum * scale[row] + (bias?.[row] ?? 0);
    }
  }

  /**
   * Вычисляет плотный выход шириной 24, загружая входные значения один раз.
   * Сохраняет последовательность сложений универсального умножения.
   * @param {QuantizedMatrix} matrix
   * @param {Float32Array} input
   * @param {Float32Array} result
   */
  function multiplyTail24(matrix, input, result) {
    const { rows, values, scale, bias } = matrix;
    const x0 = input[0];
    const x1 = input[1];
    const x2 = input[2];
    const x3 = input[3];
    const x4 = input[4];
    const x5 = input[5];
    const x6 = input[6];
    const x7 = input[7];
    const x8 = input[8];
    const x9 = input[9];
    const x10 = input[10];
    const x11 = input[11];
    const x12 = input[12];
    const x13 = input[13];
    const x14 = input[14];
    const x15 = input[15];
    const x16 = input[16];
    const x17 = input[17];
    const x18 = input[18];
    const x19 = input[19];
    const x20 = input[20];
    const x21 = input[21];
    const x22 = input[22];
    const x23 = input[23];
    for (let row = 0, offset = 0; row < rows; row += 1, offset += 24) {
      let sum = 0;
      sum += x0 * values[offset + 0];
      sum += x1 * values[offset + 1];
      sum += x2 * values[offset + 2];
      sum += x3 * values[offset + 3];
      sum += x4 * values[offset + 4];
      sum += x5 * values[offset + 5];
      sum += x6 * values[offset + 6];
      sum += x7 * values[offset + 7];
      sum += x8 * values[offset + 8];
      sum += x9 * values[offset + 9];
      sum += x10 * values[offset + 10];
      sum += x11 * values[offset + 11];
      sum += x12 * values[offset + 12];
      sum += x13 * values[offset + 13];
      sum += x14 * values[offset + 14];
      sum += x15 * values[offset + 15];
      sum += x16 * values[offset + 16];
      sum += x17 * values[offset + 17];
      sum += x18 * values[offset + 18];
      sum += x19 * values[offset + 19];
      sum += x20 * values[offset + 20];
      sum += x21 * values[offset + 21];
      sum += x22 * values[offset + 22];
      sum += x23 * values[offset + 23];
      result[row] = sum * scale[row] + (bias?.[row] ?? 0);
    }
  }

  /** @param {Float32Array} logits @param {number} limit */
  function maxIndex(logits, limit) {
    let best = 0;
    for (let index = 1; index < limit; index += 1) {
      if (logits[index] > logits[best]) best = index;
    }
    return best;
  }

  /** @param {NeuralModel} model @param {string} word */
  function tokenId(model, word) {
    const known = model.vocabulary.get(word);
    if (known !== undefined) return known;
    let hash = 2166136261;
    for (const letter of word.slice(-3)) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619);
    return model.words.length + 1 + ((hash >>> 0) % model.unknownBuckets);
  }

  /** @param {NeuralModel} model @param {string[]} words */
  function forwardHead(model, words) {
    // Прогноз выполняется синхронно, поэтому буферы можно использовать повторно.
    const { input, hidden, headLogits: head } = model;
    const context = words.slice(-model.contextSize);
    const missing = model.contextSize - context.length;
    // Левые позиции пропускаются при умножении.
    for (const [index, word] of context.entries()) {
      const id = tokenId(model, word);
      const length = model.embedding.columns;
      const offset = (missing + index) * length;
      for (let i = 0; i < length; i += 1) {
        input[offset + i] = model.embedding.values[id * length + i] * model.embedding.scale[id];
      }
    }

    multiply(model.context, input, hidden, missing * model.embedding.columns);
    const active = model.activeHidden;
    let activeCount = 0;
    for (let index = 0; index < hidden.length; index += 1) {
      const value = Math.max(hidden[index], 0);
      hidden[index] = value;
      if (value > 0) active[activeCount++] = index;
    }
    multiplyActive(model.head, hidden, active, activeCount, head);
    return activeCount;
  }

  /** @param {NeuralModel} model @param {NeuralModel["tails"][number]} tail @param {number} activeCount */
  function forwardTail(model, tail, activeCount) {
    const { logits, projected } = tail;
    multiplyActive(tail.projection, model.hidden, model.activeHidden, activeCount, projected);
    if (tail.classifier.columns === 24) {
      multiplyTail24(tail.classifier, projected, logits);
    } else {
      multiply(tail.classifier, projected, logits);
    }
    return logits;
  }

  /** @param {NeuralModel} model @param {string[]} words */
  function predict(model, words) {
    const activeCount = forwardHead(model, words);
    const head = model.headLogits;
    let best = maxIndex(head, model.shortlist);
    let score = head[best];
    for (const [index, tail] of model.tails.entries()) {
      const cluster = head[model.shortlist + index];
      // Класс не может выиграть, если вероятность всей его группы уже меньше.
      if (cluster <= score) continue;
      const logits = forwardTail(model, tail, activeCount);
      const winner = maxIndex(logits, logits.length);
      const maximum = logits[winner];
      let normalizer = 0;
      // Сумма экспонент растёт, поэтому верхняя оценка кандидата только уменьшается.
      const normalizationBlock = 128;
      const cutoffMargin = 1e-6;
      for (let start = 0; start < logits.length; start += normalizationBlock) {
        const end = Math.min(start + normalizationBlock, logits.length);
        for (let position = start; position < end; position += 1) {
          normalizer += Math.exp(logits[position] - maximum);
        }
        if (end < logits.length && cluster - Math.log(normalizer) <= score - cutoffMargin) break;
      }
      const candidateScore = cluster - Math.log(normalizer);
      if (candidateScore > score) {
        score = candidateScore;
        best = tail.start + winner;
      }
    }
    const word = model.words[best];
    return word === "i" ? "I" : word;
  }

  /** @param {Float32Array} logits @param {number} maximum */
  function logSumExp(logits, maximum) {
    let sum = 0;
    for (let index = 0; index < logits.length; index += 1) sum += Math.exp(logits[index] - maximum);
    return maximum + Math.log(sum);
  }

  /**
   * Сравнивает слова из общего списка и групп в одной шкале вероятностей.
   * @param {NeuralModel} model
   * @param {string[]} context
   * @param {number} limit
   * @param {boolean} needsHiddenWords Фразе может понадобиться слово ниже порога показа.
   * @returns {RankedNeuralWord[]} Кандидаты от наиболее вероятного.
   */
  function rankWords(model, context, limit, needsHiddenWords) {
    const activeCount = forwardHead(model, context);
    const head = model.headLogits;
    const normalizer = logSumExp(head, head[maxIndex(head, head.length)]);
    /** @type {{ index: number, score: number }[]} */
    const ranked = [];
    /** @param {number} index @param {number} score */
    function consider(index, score) {
      let position = ranked.length;
      if (position === limit && score <= ranked[position - 1].score) return;
      while (position > 0 && score > ranked[position - 1].score) position -= 1;
      ranked.splice(position, 0, { index, score });
      if (ranked.length > limit) ranked.pop();
    }
    for (let index = 0; index < model.shortlist; index += 1) consider(index, head[index]);
    // Группа не может дать слову вероятность выше собственной.
    const visibleBound = needsHiddenWords ? -Infinity : normalizer + Math.log(MIN_WORD_CONFIDENCE) - 1e-6;
    for (const [group, tail] of model.tails.entries()) {
      const cluster = head[model.shortlist + group];
      if (ranked.length === limit && cluster <= ranked[limit - 1].score) continue;
      if (cluster < visibleBound) continue;
      const logits = forwardTail(model, tail, activeCount);
      const maximum = logits[maxIndex(logits, logits.length)];
      // Порядок суммирования тот же, что и при прогнозе одного слова.
      let sum = 0;
      const threshold = Math.max(visibleBound, ranked.length === limit ? ranked[limit - 1].score : -Infinity);
      const blockSize = 128;
      for (let start = 0; start < logits.length; start += blockSize) {
        const end = Math.min(start + blockSize, logits.length);
        for (let index = start; index < end; index += 1) sum += Math.exp(logits[index] - maximum);
        if (end < logits.length && cluster - Math.log(sum) <= threshold - 1e-6) break;
      }
      if (cluster - Math.log(sum) <= threshold) continue;
      const shift = maximum + Math.log(sum);
      for (let index = 0; index < logits.length; index += 1) {
        consider(tail.start + index, cluster + (logits[index] - shift));
      }
    }
    return ranked.map(({ index, score }) => ({
      word: model.words[index] === "i" ? "I" : model.words[index],
      probability: Math.exp(score - normalizer),
    }));
  }

  /** @param {string[]} words @param {NeuralModels} models @returns {"ru" | "kk"} */
  function chooseCyrillic(words, models) {
    if (KAZAKH_LETTERS.test(words.join(" "))) return "kk";
    let score = 0;
    for (const word of words) {
      const ru = models.ru?.vocabulary.get(word);
      const kk = models.kk?.vocabulary.get(word);
      if (ru !== undefined) score -= 1 / Math.log2(ru + 1);
      if (kk !== undefined) score += 1 / Math.log2(kk + 1);
    }
    return score > 0 ? "kk" : "ru";
  }

  /**
   * Возвращает первое предсказание после слова и пробела.
   * @param {string} before Видимый текст слева от курсора.
   * @param {NeuralModels} models Загруженные веса.
   * @param {NeuralLanguage | "auto"} [preferred] Режим выбора языка.
   * @returns {string | undefined} Следующее слово при поддерживаемом вводе.
   */
  function suggest(before, models, preferred = "auto") {
    if (preferred !== "auto" || Object.values(models).some(model => model.contextSize > 6)) {
      const selected = selectSentence(before, models, preferred);
      return selected ? predict(selected.model, selected.context) : undefined;
    }
    const match = CONTEXT.exec(before.slice(-LAST_CONTEXT_CHARS).toLowerCase().replaceAll("’", "'"));
    if (!match) return undefined;
    const words = match[1].split(/ +/);
    const last = words[words.length - 1];
    const latin = LATIN.test(last);
    const alphabet = latin ? LATIN : CYRILLIC;
    let start = words.length;
    while (start > 0 && alphabet.test(words[start - 1])) start -= 1;
    const context = words.slice(start);
    if (context.length === 0) return undefined;
    const language = latin ? "en" : chooseCyrillic(context, models);
    const model = models[language];
    return model ? predict(model, context) : undefined;
  }

  /**
   * @param {string} before @param {NeuralModels} models
   * @param {NeuralLanguage | "auto"} [preferred]
   * @returns {{ model: NeuralModel, language: NeuralLanguage, context: string[] } | undefined}
   */
  function selectSentence(before, models, preferred = "auto") {
    const text = before.slice(-SENTENCE_CHARS).toLowerCase().replaceAll("’", "'");
    if (!/\p{L} $/u.test(text)) return undefined;
    const clause = text.split(SENTENCE_BOUNDARY).at(-1) ?? "";
    const words = clause.match(WORD) ?? [];
    const last = words.at(-1);
    if (!last) return undefined;
    const latin = LATIN.test(last);
    const alphabet = latin ? LATIN : CYRILLIC;
    let start = words.length;
    while (start > 0 && alphabet.test(words[start - 1])) start -= 1;
    if (start === words.length) return undefined;
    const context = words.slice(start);
    if (preferred !== "auto" && (preferred === "en") !== latin) return undefined;
    const language = preferred !== "auto" ? preferred : latin ? "en" : chooseCyrillic(context.slice(-6), models);
    const model = models[language];
    return model ? { model, language, context: context.slice(-model.contextSize) } : undefined;
  }

  /**
   * Уточняет порядок однословных вариантов по ближайшему корпусному контексту.
   * @param {NeuralModel} model
   * @param {string[]} context
   * @param {{ word: string, probability: number }[]} ranked
   * @param {string[]} options
   * @returns {string[]}
   */
  function blendContext(model, context, ranked, options) {
    const support = [3, 2, 1].map(width => width <= context.length &&
      model.phraseEvidence("~" + context.slice(-width).join(" "))).find(Boolean);
    if (!support) return options;
    const scores = new Map(ranked.filter(item => item.probability >= MIN_WORD_CONFIDENCE)
      .map(item => [item.word.toLowerCase(), item.probability * (1 - CORPUS_WORD_WEIGHT)]));
    for (const pair of support.split("|")) {
      const [word, raw] = pair.split(",");
      const probability = Number(raw) / 100;
      if (probability >= MIN_CORPUS_WORD_CONFIDENCE || scores.has(word)) {
        scores.set(word, (scores.get(word) ?? 0) + probability * CORPUS_WORD_WEIGHT);
      }
    }
    return [...scores].sort((left, right) => right[1] - left[1]).slice(0, MAX_OPTIONS)
      .map(([word]) => word === "i" ? "I" : word);
  }

  /**
   * Возвращает варианты с разными первыми словами. Фраза допускается, когда
   * подтверждается обучающим корпусом и её начало входит в список модели.
   * @param {string} before
   * @param {NeuralModels} models
   * @returns {string[]}
   */
  function suggestOptions(before, models) {
    const selected = selectSentence(before, models);
    return selected ? sentenceOptions(selected).options : [];
  }

  /**
   * Возвращает варианты текущего предложения и оценки для ранжировщика документа.
   * @param {{ model: NeuralModel, context: string[] }} selected
   * @param {boolean} [documentContext] Запрашивает одним проходом полный список для истории.
   * @returns {{ options: string[], rankedWords: RankedNeuralWord[] }}
   */
  function sentenceOptions(selected, documentContext = false) {
    const { model, context } = selected;
    /** @type {{ phrase: string, confirmed: boolean }[]} */
    const phrases = [];
    let needsHiddenWords = false;
    for (const width of [3, 2]) {
      if (context.length < width) continue;
      const key = context.slice(-width).join(" ");
      const phrase = model.phraseEvidence(key);
      if (phrase === undefined) continue;
      const confirmed = model.phraseEvidence("!" + key) !== undefined;
      phrases.push({ phrase, confirmed });
      if (phrase.includes(" ") && !confirmed) {
        needsHiddenWords = true;
      } else {
        break;
      }
    }
    const rankedWords = rankWords(model, context, documentContext ? DOCUMENT_WORDS : MAX_OPTIONS,
      documentContext || needsHiddenWords);
    const ranked = documentContext ? rankedWords.slice(0, MAX_OPTIONS) : rankedWords;
    const options = ranked.filter(candidate => candidate.probability >= MIN_WORD_CONFIDENCE)
      .map(candidate => candidate.word);
    for (const { phrase, confirmed } of phrases) {
      const first = phrase.split(" ")[0];
      if (phrase.includes(" ") && !confirmed &&
          !ranked.some(candidate => candidate.word.toLowerCase() === first)) continue;
      return { options: [phrase, ...options.filter(word => word.toLowerCase() !== first)].slice(0, MAX_OPTIONS), rankedWords };
    }
    return { options: blendContext(model, context, ranked, options), rankedWords };
  }

  return { LANGUAGES, decode, suggest, suggestOptions, selectSentence, sentenceOptions, rankWords };
})();
