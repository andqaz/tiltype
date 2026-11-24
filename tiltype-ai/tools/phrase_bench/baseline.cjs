/**
 * Вызывает фразовый контроллер и словарное дополнение из проверяемого архива.
 * Читает только левую часть позиции. Для сценария после Tab дополнительно
 * проверяет, мог ли предыдущий список фраз предложить принятое продолжение.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const [directory, panelFile, output, mode='phrases', perfFile] = process.argv.slice(2);
const read = name => fs.readFileSync(path.join(directory, name));
class LocalRequest {
  open(method, name) { this.name = name; }
  overrideMimeType() {}
  send() {
    const data = read(this.name);
    this.responseText = data.toString('utf8');
    this.response = this.responseType === 'arraybuffer' ?
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : this.responseText;
    this.status = 200;
    this.onload();
  }
}
async function main() {
  const scope = vm.createContext({console, atob, ArrayBuffer, XMLHttpRequest: LocalRequest});
  const files = [...read('index.html').toString().matchAll(/src="(scripts\/[^"]+)"/gu)]
    .map(m => m[1]).filter(f => f.startsWith('scripts/ai/') ||
      /^scripts\/(?:completion|dictionaries|next-word|phrase-extension|prediction-topic|prediction-engine)\.js$/u.test(f));
  for (const f of files) vm.runInContext(read(f).toString('utf8'), scope, {filename:f});
  const {engine, completionEngine} = vm.runInContext('({engine:tiltypePredictionEngine,completionEngine:completion})', scope);
  const dictionaries = Object.fromEntries(['ru','en','kk'].map(lang =>
    [lang,completionEngine.indexDictionary(read('dictionaries/'+lang+'.txt').toString('utf8'))]));
  await engine.prepare(mode);
  const latency=[];
  const results = {};
  for (const row of JSON.parse(fs.readFileSync(panelFile,'utf8'))) {
    const options = {language:row.lang,predictionMode:mode,predictionHistory:true};
    const history = row.history.slice(-4096);
    const counts = new Map();
    for (const term of row.history.slice(0,-4096).toLowerCase().match(/\p{L}{5,25}/gu)??[])
      counts.set(term,Math.min(24,1+(counts.get(term)??0)));
    const documentTopic=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,96);
    const predict = before => engine.suggest({before:before.slice(-600),history,documentTopic},options);
    const started = performance.now();
    const choices = row.mode==='typed' ? completionEngine.suggest(row.typed,dictionaries) : await predict(row.before);
    latency.push(performance.now()-started);
    let priorOffered=null;
    if(row.mode==='afterTab'){
      const previous=row.before.trimEnd().slice(0,-row.accepted.length);
      priorOffered=previous.trim().length>0 && (await predict(previous)).some(s=>s.toLowerCase()===row.accepted.toLowerCase());
    }
    results[row.id]={choices,priorOffered};
  }
  if(perfFile){
    latency.sort((a,b)=>a-b);
    fs.writeFileSync(perfFile,JSON.stringify({p95Ms:latency[Math.ceil(latency.length*0.95)-1], peakRssKiB:process.resourceUsage().maxRSS}));
  }
  fs.writeFileSync(output,JSON.stringify(results));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
