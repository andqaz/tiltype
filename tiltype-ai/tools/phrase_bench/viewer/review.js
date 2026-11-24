/** Показывает обезличенные курсоры стенда и экспортирует оценку первого варианта.
 * Эталон раскрывается по запросу. Пользовательские оценки остаются в браузере.
 */
const dataset=JSON.parse(document.querySelector('#dataset').textContent);
const get=id=>document.getElementById(id);
const names={plugin:'TilType',corpus:'Обучающий корпус',document:'Текущий документ'};
const genres={letter:'Контрольное письмо',article:'Статья',instruction:'Инструкция'};
const modes={space:'после пробела',typed:'после введённых букв',afterTab:'после вставки с пробелом'};
const outcomes={first:'Ожидаемая пара на первом месте.',below_first:'Пара есть среди внутренних вариантов, ниже первого места.',cut_at_merge:'Пара была в отдельном источнике и выпала при объединении.',absent:'Пары нет среди возвращённых вариантов трёх источников.'};
const storageKey='tiltype:review:'+dataset.stamp;
let ratings={};
try{ratings=JSON.parse(localStorage.getItem(storageKey)||'{}')??{};}catch(error){console.warn('Local ratings unavailable',error);}
let filtered=[],index=0;
function render(){
 const row=filtered[index];get('prev').disabled=!row||index===0;get('next').disabled=!row||index===filtered.length-1;
 get('counter').textContent=row?(index+1)+' из '+filtered.length:'Нет подходящих позиций';
 for(const id of ['first','context','meta','rating','expected','outcome','pool','sources'])get(id).replaceChildren();
 for(const id of ['answer','lists'])get(id).open=false;
 for(const id of ['yes','no'])get(id).disabled=!row;
 if(!row)return;
 get('meta').textContent=genres[row.genre]+' · '+modes[row.mode]+(row.mode==='afterTab'?(row.verified?' · предыдущее слово было в списке':' · контрольная вставка'):'');
 get('context').append(row.context);const typed=document.createElement('mark');typed.textContent=row.typed;get('context').append(typed,'▏');
 get('first').textContent=row.pool[0]??'Подсказки нет';
 get('rating').textContent=ratings[row.id]===true?'Отмечено: вставил бы':ratings[row.id]===false?'Отмечено: пропустил бы':'';
 get('expected').textContent=row.future;get('outcome').textContent=outcomes[row.status];
 for(const phrase of row.pool){const li=document.createElement('li');li.textContent=phrase+' · '+Object.keys(names).filter(s=>row.sources[s].some(x=>x.toLowerCase()===phrase)).map(s=>names[s]).join(', ');get('pool').append(li);}
 for(const [key,name] of Object.entries(names)){const p=document.createElement('p');p.textContent=name+' — '+(row.sources[key].join(' · ')||'нет вариантов');get('sources').append(p);}
}
function filter(){
 filtered=dataset.rows.filter(r=>r.lang===get('lang').value&&(!get('genre').value||r.genre===get('genre').value)&&(!get('mode').value||r.mode===get('mode').value)&&(!get('paired').value||r.paired));
 index=0;render();
}
function rate(value){
 const row=filtered[index];if(!row)return;
 ratings[row.id]=value;render();
 try{localStorage.setItem(storageKey,JSON.stringify(ratings));}catch(error){get('rating').textContent+=' · сохраните оценки кнопкой скачивания';}
}
for(const id of ['lang','genre','mode','paired'])get(id).addEventListener('change',filter);
get('next').onclick=()=>{index++;render();};get('prev').onclick=()=>{index--;render();};
get('yes').onclick=()=>rate(true);get('no').onclick=()=>rate(false);
get('export').onclick=()=>{
 const blob=new Blob([JSON.stringify({panel:dataset.stamp,ratings},null,2)],{type:'application/json'});
 const url=URL.createObjectURL(blob);const link=document.createElement('a');
 link.href=url;link.download='tiltype-phrase-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
};
filter();
