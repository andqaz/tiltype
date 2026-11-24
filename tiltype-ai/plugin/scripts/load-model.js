/**
 * Загружает метаданные и двоичные веса из локальной папки расширения.
 * XMLHttpRequest поддерживает файловые ресурсы в Desktop Editors.
 */
"use strict";

/**
 * Загружает одну нейронную модель. Отклоняет Promise при ошибке ресурса.
 * @param {NeuralLanguage} language Язык модели.
 * @param {"word" | "phrases" | "gru"} [variant] Профиль ресурсов единой сборки.
 * @returns {Promise<NeuralModel>} Декодированные веса.
 */
async function loadNeuralModel(language, variant) {
  /** @param {string} filename @param {"text" | "arraybuffer"} type @returns {Promise<unknown>} */
  function resource(filename, type) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      const path = `models/${variant === "word" ? "word/" : ""}${filename}`;
      request.open("GET", path);
      request.responseType = type;
      request.onload = () => {
        if ((request.status === 200 || request.status === 0) && request.response) resolve(request.response);
        else reject(new Error(`${path}: HTTP ${request.status}`));
      };
      request.onerror = () => reject(new Error(`Unable to read ${path}`));
      request.send();
    });
  }
  /** @template T @param {string} filename @param {(text: string) => T} parse @returns {Promise<T | undefined>} */
  function optional(filename, parse) {
    return resource(filename, "text").then(text => {
      if (typeof text !== "string") throw new Error(`Invalid model resource: ${filename}`);
      return parse(text);
    }).catch(error => {
      console.warn("TilType AI: optional model resource unavailable", error);
      return undefined;
    });
  }
  const [metadata, weights] = await Promise.all([resource(`${language}.json`, "text"), resource(`${language}.bin`, "arraybuffer")]);
  if (typeof metadata !== "string" || !(weights instanceof ArrayBuffer)) throw new Error("Invalid model resources");
  const descriptor = JSON.parse(metadata);
  if (descriptor.contextSize <= 6) return neuralEngine.decode(descriptor, weights);
  const [evidence, pointerProfile, alternativePriors, purposeProfile, purposeInventory, documentVector] = await Promise.all([
    resource(`${language}-phrases.txt`, "text"),
    optional(`${language}-pointer.json`, text => {
      const data = JSON.parse(text);
      if (!data?.profile || !data.global || !Number.isFinite(data.total) || data.total <= 0) {
        throw new Error("Invalid document profile");
      }
      return data;
    }),
    optional(`${language}-alternatives.txt`, neuralPhraseAlternativeIndex.open),
    optional(`${language}-purpose-profile.json`, neuralDocumentPurpose.open),
    optional(`${language}-purpose-inventory.txt`, neuralPhraseAlternativeIndex.open),
    optional(`${language}-document-vector.json`, text => {
      const data = JSON.parse(text);
      if (!Array.isArray(data) || data.length !== descriptor.embedding.columns ** 2 ||
          data.some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
        throw new Error("Invalid document vector matrix");
      }
      return Float32Array.from(data);
    }),
  ]);
  if (typeof evidence !== "string") throw new Error("Invalid phrase resource");
  const model = neuralEngine.decode(descriptor, weights, neuralPhraseEvidenceIndex.open(evidence));
  if (variant === "phrases" || variant === "gru") {
    model.topics = await optional(language + "-topics.json", text => JSON.parse(text));
  }
  model.pointerProfile = pointerProfile;
  model.alternativePriors = alternativePriors;
  model.purposeProfile = purposeProfile;
  model.documentVector = documentVector;
  if (purposeProfile) purposeProfile.inventory = purposeInventory;
  if (variant === "gru" && typeof neuralRecurrentPhraseOptions !== "undefined") {
    await optional(`${language}-recurrent.json`, text => neuralRecurrentPhraseOptions.attach(model, JSON.parse(text)));
  }
  return model;
}
