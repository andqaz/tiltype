/** Кодирует текст в подслова общего BPE и восстанавливает исходные байты UTF-8. */
class WriterTokenizer {
  constructor(model) {
    const bytes = [...Array(256).keys()];
    let extra = 256;
    this.alphabet = bytes.map(i => String.fromCodePoint(
      (i >= 33 && i <= 126 || i >= 161 && i <= 172 || i >= 174) ? i : extra++));
    this.inverse = new Map(this.alphabet.map((c, i) => [c, i]));
    this.vocab = model.vocab;
    this.tokens = Object.keys(this.vocab).sort((a,b) => this.vocab[a]-this.vocab[b]);
    this.rank = new Map(model.merges.map((pair,i) => [Array.isArray(pair) ? pair.join(" ") : pair,i]));
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }
  /** Разбивает текст по правилам ByteLevel и применяет слияния в порядке обучения. */
  encode(text) {
    const chunks = text.match(/'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu) || [];
    return chunks.flatMap(chunk => {
      let pieces = Array.from(this.encoder.encode(chunk), b => this.alphabet[b]);
      while (pieces.length > 1) {
        let best = Infinity, index = -1;
        for (let i=1;i<pieces.length;i++) {
          const rank = this.rank.get(pieces[i-1]+" "+pieces[i]);
          if (rank < best) { best=rank; index=i; }
        }
        if (index<0) break;
        pieces.splice(index-1,2,pieces[index-1]+pieces[index]);
      }
      return pieces.map(p => this.vocab[p]);
    });
  }
  /** Декодирует последовательность токенов, включая части одного символа. */
  decode(ids) {
    return this.decoder.decode(Uint8Array.from([...ids.map(i=>this.tokens[i]).join("")], c=>this.inverse.get(c)));
  }
}

/**
 * Дополняет одно слово при пустом фразовом прогнозе. Общий Transformer оценивает
 * варианты в контексте документа. Возврат последнего подслова позволяет выбрать
 * как слитный токен с окончанием, так и окончание из нескольких токенов.
 */
function completeWord(text, preferred, typed) {
  if (!/^\p{L}{2,}$/u.test(typed)) return [];
  const selected = ["ru","kk","en"].indexOf(preferred);
  let lang = selected >= 0 ? selected : language(text + typed);
  if (lang < 0) lang = language(text.trimEnd());
  if (lang < 0) return [];

  const ids = tokenizer.encode(text + typed);
  const last = ids.pop();
  if (last === undefined) return [];
  const required = tokenizer.tokens[last];
  const root = [1,...ids].slice(reserveContext ? -120 : -126);
  const complete = new Map();
  let states = [{ids:[], score:0}];
  for (let depth=0; depth<7 && states.length; depth++) {
    const next = [];
    for (const state of states) {
      forward([3+lang,...[...root,...state.ids].slice(-127)]);
      let peak = -Infinity;
      for (let i=2;i<logits.length;i++) {
        if (i===2 || i>=6) peak=Math.max(peak,logits[i]);
      }
      let mass=0, stopMass=0;
      const best=[];
      for (let i=2;i<logits.length;i++) {
        if(i>=3 && i<6) continue;
        const probability=Math.exp(logits[i]-peak);
        mass+=probability;
        if(depth && wordBoundary[i]) { stopMass+=probability; continue; }
        if(i===2 || (!depth && !tokenizer.tokens[i].startsWith(required))) continue;
        if(best.length===4 && logits[i]<=logits[best[3]]) continue;
        best.push(i);
        best.sort((a,b)=>logits[b]-logits[a]);
        if(best.length>4) best.pop();
      }
      if(depth && stopMass>0) {
        const tail=state.ids.map(i=>tokenizer.tokens[i]).join("").slice(required.length);
        const suffix=tokenizer.decoder.decode(Uint8Array.from(tail,c=>tokenizer.inverse.get(c)));
        if(/^\p{L}+$/u.test(suffix) &&
           (lang===2 ? /^[a-z]+$/i : /^\p{Script=Cyrillic}+$/u).test(suffix)) {
          const word=typed+suffix;
          const score=state.score+Math.log(stopMass/mass);
          complete.set(word,Math.max(complete.get(word)??-Infinity,score));
        }
      }
      for(const id of best) {
        const score=state.score+logits[id]-peak-Math.log(mass);
        next.push({ids:[...state.ids,id],score});
      }
    }
    states=next.sort((a,b)=>b.score-a.score).slice(0,4);
    const leader=Math.max(-Infinity,...complete.values());
    if(states.every(s=>s.score<leader)) break;
  }
  return [...complete.keys()].sort((a,b)=>complete.get(b)-complete.get(a)).slice(0,3);
}

/** Выбирает продолжения из уже введённого текста и фильтрует вставку по Tab.
 * Работает в Worker. Использует только префикс документа в текущей ревизии.
 */
function priorCompletion(history, before, typed, phraseDepth = 3) {
  const tokens = s => [...s.matchAll(/[\p{L}\p{M}\d]+(?:[-’'][\p{L}\p{M}\d]+)*/gu)];
  const query = tokens(before.split(/[.!?…\n]/u).pop()).slice(-5).map(m=>m[0].toLowerCase());
  const partial = typed.toLowerCase();
  const candidates = new Map();
  let bestSpan = "", bestDepth = 1;
  for (const line of history.split(/[\r\n]+/u)) {
    const items = tokens(line);
    for (let i=0; i<items.length; i++) {
      const item=items[i], word=item[0];
      if (!word.toLowerCase().startsWith(partial)) continue;
      let depth=0;
      while (depth<query.length && i>depth && items[i-depth-1][0].toLowerCase()===query[query.length-depth-1]) {
        const previous=items[i-depth-1], next=items[i-depth];
        if (/[.!?…]/u.test(line.slice(previous.index+previous[0].length,next.index))) break;
        depth++;
      }
      if (depth>=bestDepth && depth>=2) {
        // Последнее равноценное утверждение учитывает исправления в документе.
        const tail=line.slice(item.index).match(/^[^.!?…;:\n]{1,120}[.!?…]?/u)?.[0] || "";
        const parts=tokens(tail);
        if (parts.length) {
          bestDepth=depth;
          bestSpan=(parts.length>5 ? tail.slice(0,parts[4].index+parts[4][0].length) : tail).trim();
        }
      }
      if (partial.length>=3 && word.length>=partial.length) {
        const key=word.toLowerCase();
        const old=candidates.get(key);
        candidates.set(key,{word,count:(old?.count||0)+1,depth:Math.max(old?.depth||0,depth)});
      }
    }
  }
  if (bestSpan) {
    if (/[—:]\s*$/u.test(before)) return bestSpan;
    if (bestDepth < phraseDepth) return tokens(bestSpan)[0][0];
    return bestDepth < 4 ? bestSpan.replace(/[.!?…]+$/u,"") : bestSpan;
  }
  const ranked=[...candidates.values()].sort((a,b)=>b.depth-a.depth || b.count-a.count);
  const first=ranked[0];
  if (!first || first.word.length<partial.length+2) return "";
  const next=ranked[1];
  if (!next || first.depth>next.depth || first.count>=3*next.count) return first.word;
  return "";
}

/** Формирует список по фактически добавляемому суффиксу, сохраняя порядок. */
function compactChoices(neural, history, before, typed) {
  const prior=priorCompletion(history,before,typed);
  const choices=[prior,...neural];
  return [...new Set(choices.filter(s=>s && s.toLowerCase().startsWith(typed.toLowerCase()) &&
    Array.from(s.slice(typed.length).trimEnd()).length>=2))].slice(0,3);
}

/** Рабочий поток локального Transformer. Веса загружаются один раз на документ. */
let engine, tokenizer, logits, snippet, cutoff;
let cached = [];
let reserveContext = false;
const words = /\p{L}+(?:[-’']\p{L}+)*/gu;
const stop = /[.!?…]+[»”"') ]*/u;
function guess(ids) {
  const tail=ids.slice(-8);
  snippet.set(tail);
  engine.detect(tail.length);
  const values=Array.from(logits.slice(0,3));
  const max=Math.max(...values);
  return [values.indexOf(max), 1/values.reduce((s,v)=>s+Math.exp(v-max),0)];
}
function language(text) {
  let terms=(text.split(/[.!?…\n]/u).pop().match(words)||[]).slice(-4);
  if (!terms.length) return -1;
  const ascii=w=>/^[\x00-\x7f]+$/.test(w);
  const last=terms[terms.length-1];
  while (terms.some(w=>ascii(w)!==ascii(last))) terms.shift();
  const single=guess(tokenizer.encode(" "+last));
  const pred=(!ascii(last) && single[1]>=.94) ? single : guess(tokenizer.encode(" "+terms.join(" ")));
  return pred[1]<.80 || terms.length===1 && single[1]<.94 && !ascii(last) && !/[әғқңөұүһі]/iu.test(last) ? -1 : pred[0];
}
function forward(row) {
  let pos=0;
  while(pos < row.length-1 && row[pos]===cached[pos]) pos++;
  for (;pos<row.length;pos++) engine.step(row[pos], pos, Number(pos===row.length-1));
  cached=row;
}
function candidate(text,preferred,typed,excluded) {
  const lang=["ru","kk","en"].indexOf(preferred);
  const active=lang<0 ? language(text+typed) : lang;
  if(active<0) return [];
  const partial=typed.toLowerCase();
  const allowed=partial ? first.map((possible,i)=>{
    if(!possible) return false;
    const candidate=initialPieces[i];
    return candidate.length>0 && (partial.startsWith(candidate)||candidate.startsWith(partial));
  }) : first;
  // Оставляем место для генерации, чтобы сдвиг окна на каждом подслове
  // не сбрасывал весь KV-кэш длинного префикса.
  const prefix=[1,...tokenizer.encode(text.trimEnd())];
  const input=reserveContext ? prefix.slice(-96) : prefix, generated=[];
  let ended=false, confident;
  for(let step=0;step<32;step++) {
    forward([3+active,...input.slice(-127)]);
    let best=-Infinity, id=2;
    for(let i=0;i<logits.length;i++){
      if(i<2 || (i>=3 && i<6) || (!step && (!allowed[i] || excluded.has(i)))) continue;
      if(logits[i]>best){best=logits[i];id=i;}
    }
    if(!step) {
      if(!Number.isFinite(best)) return [];
      excluded.add(id);
    }
    let sum=0;
    for(let i=2;i<logits.length;i++) if((i===2||i>=6) && (step||allowed[i])) sum+=Math.exp(logits[i]-best);
    const token=tokenizer.decode([id]), prefix=tokenizer.decode(generated);
    // Запоминаем последнюю уверенную границу, не запуская генератор повторно.
    if(step && confident===undefined && tokenizer.tokens[id].startsWith("Ġ") &&
       1/sum<.30 && /\p{L}/u.test(prefix)) confident=prefix.trim();
    if(id===2 || step && ((tokenizer.tokens[id].startsWith("Ġ") && 1/sum<cutoff && /\p{L}/u.test(prefix)) ||
                           (/^[.!?…]+[»”"')]*$/u.test(token) && 1/sum<.65))){ended=true;break;}
    generated.push(id);input.push(id);
    if(/[.!?…\n]/u.test(tokenizer.decode(generated))){ended=true;break;}
  }
  let value=tokenizer.decode(generated);
  if(!value.startsWith(" ")) return [];
  value=value.trimStart().split("\n")[0];
  const terminal=stop.exec(value);
  if(terminal) value=value.slice(0,terminal.index+terminal[0].length);
  else if(!ended) value=value.slice(0,Math.max(0,value.lastIndexOf(" ")));
  const terms=[...value.matchAll(words)];
  if(!terms.length || (active===2 ? /\p{Script=Cyrillic}/u : /[a-z]/i).test(terms[0][0])) return [];
  if(terms.length>12) value=value.slice(0,terms[12].index);
  if(confident && value.startsWith(confident) && confident.length<value.trim().length) {
    if(terms.length>=3 && (confident.match(words)||[]).length<3) {
      if(terms.length>3) value=value.slice(0,terms[2].index+terms[2][0].length).split(/[,;:]/u)[0].trimEnd();
    } else value=confident;
  }
  return value.toLowerCase().startsWith(partial) && value.trim().length>partial.length ? [value.trim()] : [];
}
function suggest(text,preferred,typed="") {
  const excluded=new Set();
  const choices=candidate(text,preferred,typed,excluded);
  if(!choices.length) return typed ? completeWord(text,preferred,typed) : [];
  for(let i=0;i<2;i++) {
    const [option]=candidate(text,preferred,typed,excluded);
    if(option && !choices.includes(option)) choices.push(option);
  }
  if(typed) {
    // Пока пользователь набирает слово, однословный вариант заканчивается на букве.
    const cleaned=choices.map(option=>{
      const match=/^(\p{L}+)[\p{P}\s]*$/u.exec(option);
      return match ? match[1] : option;
    }).filter(option=>option.length>typed.length);
    return cleaned.length ? [...new Set(cleaned)] : completeWord(text,preferred,typed);
  }
  return choices;
}
let first, wordBoundary, initialPieces;
onmessage=async ({data})=>{
  try {
    if(data.wasm){
      engine=(await WebAssembly.instantiate(data.wasm,{env:{tanhf:Math.tanh,expf:Math.exp}})).instance.exports;
      const raw=new Uint16Array(data.weights);
      if(raw.length!==engine.weight_count()) throw Error("Invalid model size");
      const table=Float32Array.from({length:65536},(_,i)=>{
        const exp=i>>10&31,m=i&1023;
        return (i>>15?-1:1)*(exp===0 ? m*2**-24 : (1+m/1024)*2**(exp-15));
      });
      const memory=engine.memory.buffer;
      const weights=new Float32Array(memory,engine.weight_address(),raw.length);
      for(let i=0;i<raw.length;i++) weights[i]=table[raw[i]];
      snippet=new Uint32Array(memory,engine.snippet_address(),8);
      tokenizer=new WriterTokenizer(data.tokenizer.model);
      logits=new Float32Array(memory,engine.logits_address(),tokenizer.tokens.length);
      first=tokenizer.tokens.map((s,i)=>s.startsWith("Ġ") && /^(?:\p{L}|�|$)/u.test(tokenizer.decode([i]).trimStart()));
      initialPieces=tokenizer.tokens.map((_,i)=>tokenizer.decode([i]).trimStart().toLowerCase());
      wordBoundary=tokenizer.tokens.map((raw,i)=>i===2 || raw.startsWith("Ġ") || /^[\s\p{P}]/u.test(tokenizer.decode([i])));
      cutoff=data.threshold;
      reserveContext=data.reserveContext===true;
      postMessage({id:data.id,ready:true});
    }else {
      const typed=data.typed || "";
      const neural=suggest(data.text,data.language,typed);
      const choices=data.compact ? compactChoices(neural,data.history || "",data.before || "",typed) : neural;
      postMessage({id:data.id,choices});
    }
  } catch(error) {postMessage({id:data.id,error:String(error)});}
};



