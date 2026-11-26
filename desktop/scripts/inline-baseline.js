/**
 * Измеряет базовую линию набранных букв на странице ONLYOFFICE.
 * Координаты каретки заданы в CSS-пикселях, а пиксели страницы могут иметь
 * другое разрешение. При отсутствии надёжного измерения возвращает undefined.
 */
"use strict";

/**
 * @param {HTMLCanvasElement} canvas @param {DOMRect} caret
 * @param {CanvasRenderingContext2D} metrics Контекст с текущим шрифтом подсказки.
 * @param {string} before Текст слева от курсора.
 * @param {number} fallback Базовая линия, вычисленная по каретке.
 * @returns {number | undefined} Экранная координата базовой линии.
 */
function measureInlineBaseline(canvas, caret, metrics, before, fallback) {
  const sample = /([\p{L}\p{N}]{1,4})([^\S\r\n]{0,3})$/u.exec(before);
  if (!sample) return;
  const box = canvas.getBoundingClientRect();
  const sx = canvas.width / box.width;
  const sy = canvas.height / box.height;
  if (!(sx > 0 && sy > 0)) return;
  const glyph = metrics.measureText(sample[1]);
  const right = caret.left - metrics.measureText(sample[2]).width;
  const x = Math.ceil((right - glyph.width - box.left) * sx);
  const width = Math.floor((right - box.left) * sx) - x;
  const pad = caret.height * 0.45;
  const y = Math.max(0, Math.floor((caret.top - pad - box.top) * sy));
  const height = Math.min(canvas.height - y, Math.ceil((caret.height + 2 * pad) * sy));
  if (x < 0 || x + width > canvas.width || width < 2 || height < 3 || width * height > 64000) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let data;
  try {
    data = ctx.getImageData(x, y, width, height).data;
  } catch (error) {
    if (error?.name === "SecurityError") return;
    throw error;
  }
  // Самый частый цвет в небольшом фрагменте — фон страницы, в том числе в тёмной теме.
  const colors = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
  const counts = new Map();
  let background = 0, most = 0;
  for (let i = 0; i < colors.length; i += 3) {
    const count = (counts.get(colors[i]) ?? 0) + 1;
    counts.set(colors[i], count);
    if (count > most) { most = count; background = i * 4; }
  }
  // Подбираем вертикальную полосу высотой с отпечаток букв. Соседнюю строку
  // исключаем ограничением относительно каретки; пустые строки не дают поправки.
  const rows = new Array(height).fill(0);
  const [red,green,blue,alpha] = data.subarray(background,background+4);
  for (let i = 0; i < colors.length; i++) {
    const k = 4 * i;
    const contrast = Math.max(Math.abs(data[k]-red),Math.abs(data[k+1]-green),
      Math.abs(data[k+2]-blue),Math.abs(data[k+3]-alpha));
    if (contrast >= 42) rows[Math.floor(i / width)]++;
  }
  const ascent = glyph.actualBoundingBoxAscent;
  const descent = glyph.actualBoundingBoxDescent;
  const ink = Math.max(1, Math.round((ascent + descent) * sy));
  if (ink < 2 || ink >= height) return;
  let best = -Infinity;
  let baseline;
  for (let bottom = ink - 1; bottom < height; bottom++) {
    if (!rows[bottom] || rows[bottom+1]) continue;
    const top = bottom - ink + 1;
    const measured = box.top + (y + bottom + 1) / sy - descent;
    const offset = Math.abs(measured - fallback);
    if (offset > pad || !rows.slice(top, top+Math.max(2,Math.ceil(sy))).some(Boolean)) continue;
    const score = rows.slice(top,bottom+1).reduce((a,b)=>a+b,0) - offset*0.25;
    if (score > best) { best = score; baseline = measured; }
  }
  return baseline;
}
