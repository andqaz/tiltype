/**
 * Сравнивает точные продолжения в отдельных процессах Node.js.
 * Использует известный язык документа для всех движков, измеряет полную
 * первую фразу, первый токен-слово, покрытие, задержку и память процесса.
 */
const fs = require('node:fs');
const path = require('node:path');
const [panelFile, packageDirectory, mode, condition] = process.argv.slice(2);
const out = path.dirname(panelFile);
const bal = path.join(out, '../balanced-generator');
const models = path.join(out, '../../subword-phrase-model-4epochs/models');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const words = text => text.toLowerCase().match(/\p{L}+(?:['’-]\p{L}+)*/gu) || [];

/** Загружает проверяемый движок и возвращает функцию прогноза на одном курсоре. */
async function predictor() {
  if (mode === 'phrases' || mode === 'dictionary') {
    const {openController} = require(path.join(bal, '../unified-package-audit.cjs'));
    const controller = openController(packageDirectory);
    await controller.prepare(mode);
    return row => controller.suggest({before: row.before, history: row.history, documentTopic: []},
      {language: row.lang, predictionMode: mode, predictionHistory: true});
  }
  const {openRuntime} = require('./gru-runtime.cjs');
  const {openBeam} = require(path.join(bal, 'typed-beam.cjs'));
  const {openTokenizer} = require(path.join(bal, 'typed-tokenizer.cjs'));
  const checkpoint = mode === 'seed' ? path.join(models,'model.pt') : mode === 'old' ?
    path.join(bal,'cell-balanced.pt') : path.join(out, 'gru-' + mode + '.pt');
  const runtime = openRuntime(fs.readFileSync(checkpoint), read(path.join(out, 'layout-' + mode + '.json')));
  const suggest = openBeam(runtime, openTokenizer(read(path.join(models, 'tokenizer.json'))));
  return row => {
    const history = condition === 'local' ? [] : row.history.split(/\n+|(?<=[.!?…])\s+/u)
      .filter(s => s.trim()).map(s => words(s).join(' '));
    return suggest(words(row.before).join(' '), row.lang, history, '');
  };
}

/** Вычисляет показатели только по словам справа от курсора после получения прогноза. */
async function main() {
  const rows = read(panelFile);
  const originalRead = fs.readFileSync;
  const files = new Map();
  // Учитываем только реально открытые ресурсы каждого движка, не размер общего архива.
  fs.readFileSync = function(file, ...args) {
    const data = originalRead.call(fs, file, ...args);
    if (typeof file === 'string' && (file.startsWith(packageDirectory + path.sep) ||
        /(?:gru-\d+|cell-balanced|model)\.pt$|tokenizer\.json$|layout-[\w-]+\.json$/u.test(file))) {
      files.set(file, fs.statSync(file).size);
    }
    return data;
  };
  const suggest = await predictor();
  const groups = {};
  const examples = {};
  const start = process.cpuUsage();
  for (const row of rows) {
    const mark = performance.now();
    const options = await suggest(row);
    const latency = performance.now() - mark;
    const exampleKey = row.lang + '/' + row.genre + '/' + (row.long ? 'long' : 'short');
    if (!examples[exampleKey]) examples[exampleKey] = {doc:row.doc,before:row.before,options};
    const lead = options[0]?.toLowerCase() || '';
    const first = words(row.future)[0];
    const exact = !!lead && row.future.startsWith(lead) && !/^[\p{L}'’-]/u.test(row.future.slice(lead.length));
    for (const key of [row.lang, [row.lang,row.genre,row.long?'long':'short'].join('/')]) {
      const g = groups[key] ??= {n:0,shown:0,first:0,anyFirst:0,phrase:0,saved:0,times:[]};
      g.n++; g.shown += Number(!!lead); g.first += Number(words(lead)[0] === first);
      g.anyFirst += Number(options.some(item => words(item)[0] === first));
      g.phrase += Number(exact && words(lead).length >= 2);
      g.saved += exact ? Math.max(0,Array.from(lead).length-1) : 0;
      g.times.push(latency);
    }
  }
  const cpu = process.cpuUsage(start);
  for (const g of Object.values(groups)) {
    g.p95 = g.times.sort((a,b)=>a-b)[Math.ceil(g.n*.95)-1];
    delete g.times;
  }
  fs.readFileSync = originalRead;
  const resourceBytes = [...files.values()].reduce((sum, bytes) => sum + bytes, 0);
  const result = {mode,condition,groups,examples,resourceBytes,cpuSeconds:(cpu.user+cpu.system)/1e6,peakRssKiB:process.resourceUsage().maxRSS};
  fs.writeFileSync(panelFile.replace('-cursors.json','-'+mode+'-'+condition+'.json'),JSON.stringify(result,null,2));
}
main().catch(error => { console.error(error); process.exitCode=1; });
