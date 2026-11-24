/** Выполняет шаги подсловной GRU и адаптивного softmax на CPU в JavaScript.
 * Принимает исходные матрицы Float32 и позволяет повторно использовать
 * состояние префикса при ветвлении вариантов продолжения.
 */
const dotRows = (matrix, input, bias) => {
  const width = input.length;
  const result = new Float32Array(matrix.length / width);
  for (let row = 0; row < result.length; row++) {
    let sum = bias?.[row] ?? 0;
    for (let col = 0, start = row * width; col < width; col++) sum += matrix[start + col] * input[col];
    result[row] = sum;
  }
  return result;
};
const sigmoid = x => 1 / (1 + Math.exp(-x));
function logSoftmax(values) {
  let max = -Infinity, sum = 0;
  for (const v of values) max = Math.max(max, v);
  for (const v of values) sum += Math.exp(v-max);
  const z = max + Math.log(sum);
  return values.map(v => v-z);
}
/** Связывает модель с индексом матриц и буфером проверенного файла весов. */
function openRuntime(bytes, layout) {
  const w = Object.fromEntries(Object.entries(layout).map(([name,{offset,shape}]) =>
    [name,new Float32Array(bytes.buffer,bytes.byteOffset+offset,shape.reduce((a,b)=>a*b,1))]));
  const hiddenSize = layout["recurrent.weight_hh_l0"].shape[1];
  function step(id, state = new Float32Array(hiddenSize)) {
    const emb = w['embedding.weight'].subarray(id*128,(id+1)*128);
    const x = dotRows(w['recurrent.weight_ih_l0'],emb,w['recurrent.bias_ih_l0']);
    const h = dotRows(w['recurrent.weight_hh_l0'],state,w['recurrent.bias_hh_l0']);
    return state.map((v,i) => {
      const z = sigmoid(x[i+hiddenSize]+h[i+hiddenSize]);
      const n = Math.tanh(x[i+2*hiddenSize]+sigmoid(x[i]+h[i])*h[i+2*hiddenSize]);
      return n+z*(v-n);
    });
  }
  function scores(state) {
    const head = logSoftmax(dotRows(w['output.head.weight'],state));
    const result = new Float32Array(8192);
    result.set(head.subarray(0,512));
    for (const [i,offset] of [512,2048].entries()) {
      const projected = dotRows(w[`output.tail.${i}.0.weight`],state);
      const tail = logSoftmax(dotRows(w[`output.tail.${i}.1.weight`],projected));
      result.set(tail.map(v=>v+head[512+i]),offset);
    }
    return result;
  }
  return {step,scores};
}
module.exports = {openRuntime};
