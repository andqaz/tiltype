/**
 * Измеряет один движок в отдельном процессе Node.js.
 * Разделяет загрузку, качество первого слова и задержку готового прогноза.
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { performance } = require("node:perf_hooks");

const LANGUAGES = ["en", "ru", "kk"];
const WARMUP = 900;
const MEASURED_CALLS = 9_000;
const [mode, modelsPath, runtime, casesPath] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const read = (name) => readFileSync(resolve(modelsPath, name));
const readJson = (name) => JSON.parse(read(name).toString("utf8"));
const byLanguage = (load) => Object.fromEntries(LANGUAGES.map((language) => [language, load(language)]));
const mb = (bytes) => bytes / 1_000_000;

function loadDictionary() {
  const engine = runInNewContext(readFileSync(runtime, "utf8") + "\nnextWord");
  const primary = byLanguage((language) => readJson(`predict-${language}.json`));
  const fallback = byLanguage((language) => readJson(`predict-${language}-fallback.json`));
  return (text) => engine.suggest(text, "auto", primary, fallback);
}

function loadNeural() {
  const hasPhrases = ["phrases", "phrasesShort", "previousPhrases"].includes(mode);
  const engine = runInNewContext(readFileSync(runtime, "utf8") + "\nneuralEngine");
  const packed = hasPhrases && existsSync(resolve(modelsPath, "phrase-evidence-index.js"))
    ? runInNewContext(read("phrase-evidence-index.js").toString("utf8") + "\nneuralPhraseEvidenceIndex") : undefined;
  const models = byLanguage((language) => {
    const payload = read(`${language}.bin`);
    const weights = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    const evidence = packed ? packed.open(read(`${language}-phrases.txt`).toString("utf8"))
      : hasPhrases ? readJson(`${language}-phrases.json`) : undefined;
    return engine.decode(readJson(`${language}.json`), weights, evidence);
  });
  if (mode === "phrasesShort") return (text) => engine.suggestOptions(text.trimEnd().split(/ +/u).slice(-6).join(" ") + " ", models);
  if (hasPhrases) return (text) => engine.suggestOptions(text, models);
  return (text) => engine.suggest(text, models);
}

function memory() {
  global.gc();
  const used = process.memoryUsage();
  return { rssMB: mb(used.rss), heapMB: mb(used.heapUsed), arrayBuffersMB: mb(used.arrayBuffers) };
}

const emptyMemory = memory();
const loadStart = performance.now();
const suggest = mode === "dictionary" ? loadDictionary() : loadNeural();
const loadMs = performance.now() - loadStart;
const loadedMemory = memory();

const quality = byLanguage((language) => {
  const predictions = createHash("sha256");
  const lists = createHash("sha256");
  let matched = 0;
  let covered = 0;
  let alternativesMatched = 0;
  let longTested = 0;
  let longMatched = 0;
  let phraseOffered = 0;
  let phraseExact = 0;
  for (const [before, expected, continuation] of cases[language]) {
    const result = suggest(before);
    const options = Array.isArray(result) ? result : result ? [result] : [];
    const guess = options[0];
    const first = guess?.split(" ")[0]?.toLowerCase();
    const correct = first === expected.toLowerCase();
    predictions.update((guess ?? "") + "\n");
    covered += Number(Boolean(guess));
    matched += Number(correct);
    if (!continuation) continue;
    lists.update(JSON.stringify(options) + "\n");
    alternativesMatched += Number(options.some(option => option.split(" ")[0].toLowerCase() === expected.toLowerCase()));
    if (before.trimEnd().split(/ +/u).length > 6) {
      longTested += 1;
      longMatched += Number(correct);
    }
    if (guess?.includes(" ")) {
      phraseOffered += 1;
      const words = guess.toLowerCase().split(" ");
      phraseExact += Number(words.every((word, index) => word === continuation[index]?.toLowerCase()));
    }
  }
  const totals = { tested: cases[language].length, matched, covered, predictionsSha256: predictions.digest("hex") };
  if (!cases[language][0][2]) return totals;
  return { ...totals, optionsSha256: lists.digest("hex"), alternativesMatched, longTested, longMatched, phraseOffered, phraseExact };
});

// Чередуем языки, чтобы порядок запусков и ветви определения языка были одинаковыми.
const contextAt = (index) => cases[LANGUAGES[index % LANGUAGES.length]][Math.floor(index / LANGUAGES.length) % cases.en.length][0];
for (let index = 0; index < WARMUP; index += 1) suggest(contextAt(index));
const steadyMemory = memory();
const latency = new Float64Array(MEASURED_CALLS);
const cpuStart = process.cpuUsage();
const elapsedStart = performance.now();
for (let index = 0; index < MEASURED_CALLS; index += 1) {
  const before = contextAt(index);
  const started = performance.now();
  suggest(before);
  latency[index] = performance.now() - started;
}
const elapsed = performance.now() - elapsedStart;
const cpu = process.cpuUsage(cpuStart);
latency.sort();
const quantile = (q) => latency[Math.ceil(q * latency.length) - 1];
process.stdout.write(JSON.stringify({
  mode, loadMs, emptyMemory, loadedMemory, steadyMemory, quality,
  peakRssMB: mb(process.resourceUsage().maxRSS * 1024),
  timings: {
    calls: MEASURED_CALLS, latencyP50Ms: quantile(0.5), latencyP95Ms: quantile(0.95),
    wallMsPer1000: elapsed / MEASURED_CALLS * 1_000,
    cpuMsPer1000: (cpu.user + cpu.system) / MEASURED_CALLS,
  },
}) + "\n");
