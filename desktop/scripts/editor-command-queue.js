/**
 * Выполняет команды Office API по одной в фоновом плагине TilType.
 * SDK использует общий обработчик ответа, поэтому чтение контекста и правки
 * должны дождаться предыдущего результата.
 */
"use strict";

/**
 * Сохраняет область данных каждой команды на момент постановки в очередь.
 * @param {EditorPlugin} plugin Фоновый плагин с методом callCommand.
 * @param {{ scope?: object }} sdk Объект SDK, передающий данные в Office API.
 */
function installEditorCommandQueue(plugin, sdk) {
  const send = plugin.callCommand.bind(plugin);
  /** @type {Array<() => void>} */
  const queue = [];
  let running = false;

  function dispatch() {
    if (running) return;
    const next = queue.shift();
    if (!next) return;
    running = true;
    next();
  }

  plugin.callCommand = (command, close, recalculate, callback) => {
    const scope = sdk.scope;
    queue.push(() => {
      const previousScope = sdk.scope;
      let answered = false;
      /** @param {unknown} result Ответ SDK или undefined при ошибке отправки. */
      function complete(result) {
        if (answered) return;
        answered = true;
        try {
          callback(result);
        } finally {
          // Перед следующей отправкой SDK должен закончить обработку текущего ответа.
          queueMicrotask(() => {
            running = false;
            dispatch();
          });
        }
      }

      sdk.scope = scope;
      try {
        send(command, close, recalculate, complete);
      } catch (error) {
        if (answered) throw error;
        console.error("TilType: unable to send editor command", error);
        complete(undefined);
      } finally {
        sdk.scope = previousScope;
      }
    });
    dispatch();
  };
}
