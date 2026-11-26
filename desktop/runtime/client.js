/** Подключает единственный локальный генератор к редактору. Инференс идёт вне UI-потока. */
const tiltypePredictionEngine = (() => {
  let ready, worker, sequence=0, latest=0;
  const pending=new Map();
  function read(path,type) {
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open("GET",path); xhr.responseType=type;
      xhr.onload=()=> (xhr.status===0 || xhr.status===200) && xhr.response ? resolve(xhr.response) : reject(Error(path+" "+xhr.status));
      xhr.onerror=()=>reject(Error(path)); xhr.send();
    });
  }
  function request(data,transfer=[]) {
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject}); worker.postMessage({...data,id},transfer);
    });
  }
  async function load(){
    const [source,wasm,weights,tokenizer,config]=await Promise.all([
      read("runtime/worker.js","text"),read("runtime/decoder.wasm","arraybuffer"),
      read("models/writer.fp16","arraybuffer"),read("models/tokenizer.json","json"),read("models/config.json","json")]);
    const url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));
    worker=new Worker(url);
    worker.onmessage=({data})=>{
      const item=pending.get(data.id); if(!item) return;
      pending.delete(data.id); data.error ? item.reject(Error(data.error)) : item.resolve(data);
    };
    worker.onerror=e=>{
      for(const item of pending.values()) item.reject(Error(e.message));
      pending.clear(); ready=undefined;worker.terminate();
    };
    try {await request({wasm,weights,tokenizer,threshold:config.threshold},[wasm,weights]);}
    finally {URL.revokeObjectURL(url);}
  }
  function prepare(){return ready??=(load().catch(error=>{ready=undefined;throw error;}));}
  let running=Promise.resolve();
  function suggest(caret,options){
    const ticket=++latest;
    const task=running.then(async()=>{
      await prepare();
      if(ticket!==latest) return [];
      const history=options.predictionHistory && caret.history ? caret.history+"\n" : "";
      return (await request({text:history+caret.before,language:options.language,typed:caret.typed || ""})).choices;
    });
    running=task.catch(()=>{});
    return task;
  }
  return {prepare,suggest,modelOnly:true};
})();
