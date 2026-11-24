/**
 * Хранит корпусные оценки в исходном тексте и ищет их по таблице смещений.
 * Проверяет полный ключ после хеширования, поэтому коллизии сохраняют точность.
 */
"use strict";

const neuralPhraseEvidenceIndex = (() => {
  /** @param {string} text @param {number} start @param {number} end @returns {number} */
  function hash(text, start, end) {
    let value = 2166136261;
    for (let index = start; index < end; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return value >>> 0;
  }

  /**
   * Читает ресурс с ключом и значением в каждой строке. Отклоняет неверный формат.
   * @param {string} source @returns {PhraseEvidenceLookup}
   */
  function open(source) {
    if (!source.endsWith("\n")) throw new Error("Invalid phrase evidence");
    let count = 0;
    for (let end = source.indexOf("\n"); end >= 0; end = source.indexOf("\n", end + 1)) count++;
    let capacity = 1;
    while (capacity < count * 2) capacity *= 2;
    const positions = new Uint32Array(capacity);
    const mask = capacity - 1;
    for (let start = 0; start < source.length;) {
      const end = source.indexOf("\n", start);
      const split = source.indexOf("\t", start);
      if (split <= start || split >= end) throw new Error("Invalid corpus entry");
      let bin = hash(source, start, split) & mask;
      while (positions[bin]) bin = (bin + 1) & mask;
      // Ноль обозначает пустую ячейку, в том числе перед строкой с позиции 0.
      positions[bin] = start + 1;
      start = end + 1;
    }
    return key => {
      let bin = hash(key, 0, key.length) & mask;
      while (positions[bin]) {
        const start = positions[bin] - 1;
        const delimiter = start + key.length;
        if (source.charCodeAt(delimiter) === 9 && source.startsWith(key, start)) {
          const value = delimiter + 1;
          return source.slice(value, source.indexOf("\n", value));
        }
        bin = (bin + 1) & mask;
      }
      return undefined;
    };
  }

  return { open };
})();
