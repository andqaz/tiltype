/**
 * Управляет жизненным циклом панели в существующем iframe фонового плагина.
 * При доступном родительском окне использует границы жеста выделения,
 * иначе оставляет размещение у курсора редактору. Все правки идут через Office API.
 */
"use strict";

/** @typedef {{key:string,bold?:boolean,italic?:boolean,underline?:boolean,highlight?:string,color?:string,font?:string,size?:number,align?:string,paint?:string}} FormatState */

/** @param {EditorPlugin} plugin @param {{scope?:object}} sdk @param {()=>void} clearSuggestions */
function installFormatToolbar(plugin, sdk, clearSuggestions) {
  const ui = createFormatControls(getSettingsLanguage(plugin.info.lang), apply, loadFonts, resizeFonts);
  let baseTop = 0;
  const events = new AbortController();
  const listener = {capture:true, signal:events.signal};
  let enabled = false, revision = 0, timer = 0, poll = 0, busy = false, checking = false;
  /** @type {FormatState | null} */
  let state = null;
  /** @type {{key:string, paint:string}|null} */
  let brush = null;
  let dismissedKey = "";
  /** @type {{x:number,y:number,bottom:number}|null} */
  let anchor = null;
  const frame = /** @type {HTMLElement | null} */ (window.frameElement);
  const host = frame?.ownerDocument;
  const hostWindow = host?.defaultView;
  const editor = hostWindow && (Reflect.get(hostWindow, "editor") || Reflect.get(hostWindow, "Asc")?.editor);
  let drag = false, originX = 0, originY = 0;

  /** @param {(names:string[])=>void} receive */
  function loadFonts(receive) {
    plugin.executeMethod("GetFontList", [], rows => {
      const names = new Set();
      for (const row of Array.isArray(rows) ? rows : []) {
        const name = typeof row === "string" ? row : row?.m_wsFontName;
        if (typeof name === "string" && name.trim()) names.add(name.trim());
      }
      receive([...names].sort((a,b)=>a.localeCompare(b)));
    });
  }
  /** @param {boolean} open */
  function resizeFonts(open) {
    if (!open) {
      ui.bar.classList.remove("font-menu-above");
      if (frame) frame.style.removeProperty("clip-path");
    }
    if (!state) return;
    if (frame && host) {
      if (open) baseTop = frame.offsetTop;
      const roomBelow = Math.max(0, host.documentElement.clientHeight - baseTop - 66);
      const above = open && roomBelow < 198 && baseTop > roomBelow;
      const extra = open ? Math.min(198, above ? baseTop : roomBelow) : 0;
      frame.style.height = (66 + extra) + "px";
      frame.style.top = (above ? baseTop - extra : baseTop) + "px";
      ui.bar.classList.toggle("font-menu-above", above);
      if (open) {
        // Прозрачная область расширенного iframe не должна перехватывать мышь.
        const menu = ui.bar.querySelector(".format-font-menu")?.getBoundingClientRect();
        if (menu) {
          const l = menu.left + "px", r = menu.right + "px";
          const seam = (above ? extra : 66) + "px";
          frame.style.clipPath = above
            ? `polygon(${l} 0,${r} 0,${r} ${seam},100% ${seam},100% 100%,0 100%,0 ${seam},${l} ${seam})`
            : `polygon(0 0,100% 0,100% ${seam},${r} ${seam},${r} 100%,${l} 100%,${l} ${seam},0 ${seam})`;
        }
      }
    } else {
      plugin.executeMethod("ShowInputHelper",[plugin.guid,364,open ? 264 : 66,open],()=>{
        if (open && state) /** @type {HTMLInputElement|null} */ (ui.bar.querySelector('input[data-action="font"][aria-expanded="true"]'))?.focus();
      });
    }
  }
  function hide() {
    revision++;
    clearTimeout(timer);
    if (!state) return;
    state = null;
    ui.closeMenus();
    if (frame) frame.style.removeProperty("border-radius");
    ui.bar.hidden = true;
    document.body.classList.remove("tiltype-formatting");
    plugin.executeMethod("UnShowInputHelper",[plugin.guid, false]);
  }
  /** @param {string} action @param {unknown} value @param {string} key @param {(result:FormatState|null)=>void} done */
  function command(action, value, key, done) {
    sdk.scope = {...sdk.scope, tiltypeFormat:{action,value,key}};
    plugin.callCommand(formatSelection,false,!["read","copy"].includes(action), result => {
      if (!result || typeof result !== "object" || !("key" in result) || typeof result.key !== "string") {
        done(null);
        return;
      }
      const snapshot = /** @type {FormatState} */ (result);
      if (!snapshot.font && action !== "copy") {
        // Для унаследованного шрифта читаем вычисленное значение редактора.
        snapshot.font = editor?.get_TextProps?.()?.get_TextPr?.()?.get_FontFamily?.()?.get_Name?.();
      }
      done(snapshot);
    });
  }
  /** @param {FormatState} next */
  function show(next) {
    if (!state) clearSuggestions();
    else if (state.key !== next.key) ui.closeMenus();
    state = next;
    const theme = plugin.theme;
    if (theme) {
      ui.bar.style.colorScheme = theme.type === "dark" ? "dark" : "light";
      for (const name of ["background-normal","text-normal","highlight-button-hover","highlight-button-pressed","border-control-focus"]) {
        if (theme[name]) ui.bar.style.setProperty("--" + name, theme[name]);
      }
      ui.bar.style.setProperty("--border-regular", theme["border-control"] || (theme.type === "dark" ? "#666" : "#d4d4d4"));
    }
    ui.update(next, !!brush);
    ui.bar.hidden = false;
    document.body.classList.add("tiltype-formatting");
    const width = Math.min(364, host?.documentElement.clientWidth || 364);
    const height = 66;
    const stamp = revision;
    plugin.executeMethod("ShowInputHelper", [plugin.guid,width,height,false], () => {
      if (!frame || !host || stamp !== revision || !state) return;
      frame.style.borderRadius = "7px";
      // Desktop 10 возвращает углы выделения в координатах холста документа.
      // Для выделения с клавиатуры позиции указателя может вообще не быть.
      const points = editor?.asc_GetSelectionBounds?.();
      const canvas = host.getElementById("id_viewer")?.getBoundingClientRect();
      let placement = anchor;
      if (canvas && Array.isArray(points) && points.length === 4 &&
          points.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) &&
          points.some(p => p[1] !== points[0][1])) {
        placement = {x:canvas.left + points[0][0], y:canvas.top + Math.min(...points.map(p => p[1])),
          bottom:canvas.top + Math.max(...points.map(p => p[1]))};
      }
      if (!placement) return;
      const x = Math.max(0,Math.min(placement.x,host.documentElement.clientWidth - width));
      const y = placement.y >= (canvas?.top || 0) + height + 8 ? placement.y - height - 8 : placement.bottom + 8;
      frame.style.left = x + "px";
      frame.style.top = Math.max(0, Math.min(y,host.documentElement.clientHeight-height)) + "px";
    });
  }
  /** @param {string} action @param {string} [value] */
  function apply(action, value) {
    if (!enabled || !state || busy) return;
    if (action === "copy" && brush) { brush = null; ui.update(state,false); return; }
    const stamp = ++revision;
    busy = true;
    command(action,value,state.key,result => {
      busy = false;
      if (stamp !== revision || !enabled) return;
      if (!result || !state) { hide(); return; }
      if (action === "copy" && result.paint) {
        brush = {key:result.key,paint:result.paint};
        ui.update(state,true);
      } else { state = result; ui.update(state,false); }
    });
  }
  function inspect() {
    if (!enabled || busy || drag || document.hidden) return;
    const stamp = revision;
    command("read",null,"",result => {
      if (!enabled || busy || stamp !== revision) return;
      if (!result) { dismissedKey = ""; hide(); return; }
      if (result.key === dismissedKey) return;
      dismissedKey = "";
      if (brush && brush.key !== result.key) {
        const paint = brush.paint;
        brush = null;
        show(result);
        apply("paint",paint);
      } else if (state?.key !== result.key) show(result);
      else { state = result; ui.update(result, !!brush); }
    });
  }
  function schedule() {
    if (!enabled) return;
    revision++;
    clearTimeout(timer);
    timer = window.setTimeout(inspect,65);
  }
  // В изолированном iframe редактор не передаёт обычное окончание перетаскивания.
  // Дешёвый запрос типа выделения позволяет обнаружить его без чтения документа при наборе.
  function checkSelection() {
    if (checking || busy || !enabled || document.hidden || drag) return;
    checking = true;
    const stamp = revision;
    plugin.executeMethod("GetSelectionType",[],type => {
      checking = false;
      if (stamp !== revision || !enabled || busy) return;
      if (type === "text") { if (!state || !host && !document.hasFocus()) inspect(); }
      else { dismissedKey = ""; if (state) hide(); }
    });
  }
  host?.addEventListener("pointerdown",event => {
    if (!enabled || event.button !== 0) return;
    dismissedKey = ""; drag = true; originX = event.clientX; originY = event.clientY;
    // Не вызываем UnShowInputHelper во время жеста: SDK возвращает фокус
    // редактору и может изменить начальную точку обратного выделения.
    revision++; clearTimeout(timer); anchor = null;
  },listener);
  host?.addEventListener("pointerup",event => {
    if (!drag) return;
    drag = false;
    anchor = {x:Math.min(originX,event.clientX),y:Math.min(originY,event.clientY),bottom:Math.max(originY,event.clientY)};
    schedule();
  },listener);
  host?.addEventListener("pointercancel",() => {drag=false;hide();},listener);
  host?.addEventListener("keyup",event => {if (event.shiftKey || event.key === "Shift" || (event.ctrlKey && event.key.toLowerCase()==="a")) {anchor=null;schedule();}},listener);
  host?.addEventListener("wheel",() => {anchor=null;hide();},listener);
  plugin.attachEditorEvent("onClick",schedule);
  ui.bar.addEventListener("keydown",event => {
    if (event.key === "Escape") {dismissedKey=state?.key || "";brush=null;hide();}
    event.stopPropagation();
  });
  return {
    get visible() { return !!state; },
    /** @param {boolean} on */
    configure(on) {
      enabled=on; dismissedKey=""; brush=null; drag=false; hide(); clearInterval(poll);
      if (enabled) poll=window.setInterval(checkSelection,host ? 1000 : 420);
    },
    dismiss() { if (state) dismissedKey=state.key; brush=null; hide(); },
    close() { enabled=false; brush=null; hide(); clearInterval(poll); events.abort(); ui.bar.remove(); }
  };
}

