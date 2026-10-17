(() => {
  const VERSION = "0.4.4";
  // Scripts injected before the extension was reloaded or updated keep running with a dead
  // message port. Detect that so a stale agent is replaced instead of reused.
  const connected = () => !!chrome.runtime?.id;
  if (globalThis.__slideShotsAgent?.version === VERSION && globalThis.__slideShotsAgent?.connected?.()) return;
  globalThis.__slideShotsAgent?.dispose?.();
  const MARKER = "__slideshots_frame_identify_v2__";
  const nonce = crypto.randomUUID();
  const nodes = new Map();
  const ids = new WeakMap();
  let serial = 0;
  let picker;
  let capture;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

  function idFor(element) {
    if (!ids.has(element)) { const id = `r${++serial}`; ids.set(element, id); nodes.set(id, element); }
    return ids.get(element);
  }
  function getNode(id) {
    const element = nodes.get(id);
    if (!element?.isConnected) throw new Error("選んだ領域が変わりました。もう一度クリックして選んでください。");
    return element;
  }
  function scroller(target) { return target.kind === "document" ? document.scrollingElement : getNode(target.id); }
  function label(element) {
    return (element.getAttribute("aria-label") || element.getAttribute("title") || element.querySelector("h1,h2,h3")?.textContent || "内部スクロール領域").trim().replace(/\s+/g, " ").slice(0, 65);
  }
  function scrollable(element) {
    const style = getComputedStyle(element);
    return ((/(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) ||
      (/(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)) && element.clientWidth > 25 && element.clientHeight > 25;
  }
  function parent(element) { return element.parentElement || element.getRootNode()?.host || null; }
  function viewport() {
    const root = document.documentElement;
    return { left: 0, top: 0, right: Math.min(innerWidth, root.clientWidth || innerWidth), bottom: Math.min(innerHeight, root.clientHeight || innerHeight) };
  }
  function box(element) {
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const px = (value) => Number.parseFloat(value) || 0;
    const borderLeft=px(style.borderLeftWidth),borderTop=px(style.borderTopWidth);
    // Read axis-aligned CSS scaling directly. offset sizes round fractions, while
    // resolved content-box sizes can exclude scrollbars; neither is a precise denominator.
    let cssScaleX=1,cssScaleY=1;
    const number=(value)=>value.endsWith("%")?Number.parseFloat(value)/100:Number.parseFloat(value);
    for(let node=element;node;node=parent(node)) {
      const nodeStyle=node===element?style:getComputedStyle(node);
      if(nodeStyle.transform!=="none") {
        const matrix=new DOMMatrixReadOnly(nodeStyle.transform);
        if(Math.abs(matrix.b)>.001 || Math.abs(matrix.c)>.001) throw new Error("回転している領域は撮影できません。通常の表示に戻してください。");
        cssScaleX*=Math.abs(matrix.a);cssScaleY*=Math.abs(matrix.d);
      }
      if(nodeStyle.scale && nodeStyle.scale!=="none") {
        const values=nodeStyle.scale.trim().split(/\s+/).map(number);
        cssScaleX*=Math.abs(values[0]);cssScaleY*=Math.abs(values[1]??values[0]);
      }
      const zoom=number(nodeStyle.zoom||"1");
      if(Number.isFinite(zoom) && zoom>0){cssScaleX*=zoom;cssScaleY*=zoom;}
    }
    // Fall back for geometry not represented by these CSS properties (e.g. SVG viewBox).
    const axisScale=(size,offset,cssScale)=>Number.isFinite(cssScale) && cssScale>0 &&
      Math.abs(size-offset*cssScale)<=cssScale*.51+.01?cssScale:size/(offset||size||1);
    const sx=axisScale(r.width,element.offsetWidth||0,cssScaleX);
    const sy=axisScale(r.height,element.offsetHeight||0,cssScaleY);
    // Retain a left-hand RTL scrollbar while using the actual fractional border width.
    const leftInset=element.clientLeft>Math.round(borderLeft)?element.clientLeft:borderLeft;
    const left=r.left+leftInset*sx,top=r.top+borderTop*sy;
    return { left,top,right:left+element.clientWidth*sx,bottom:top+element.clientHeight*sy,sx,sy };
  }
  function positioningMode(style) { return ["fixed", "absolute"].includes(style.position) ? style.position : null; }
  function establishesContainingBlock(style, mode) {
    return (mode === "absolute" && style.position !== "static") ||
      [style.transform, style.perspective, style.filter, style.backdropFilter, style.translate, style.rotate, style.scale].some((value) => value && value !== "none") ||
      /\b(layout|paint|strict|content)\b/.test(style.contain) ||
      /\b(transform|perspective|filter|backdrop-filter|translate|rotate|scale)\b/.test(style.willChange) ||
      style.contentVisibility === "auto";
  }
  function clipChain(element) {
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyOverflowIsViewport = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible";
    const ancestors = [];
    let mode = positioningMode(getComputedStyle(element));
    for (let ancestor = parent(element); ancestor && ancestor !== document.documentElement; ancestor = parent(ancestor)) {
      const style = getComputedStyle(ancestor);
      // Positioned descendants escape overflow between themselves and their containing block.
      if (mode && !establishesContainingBlock(style, mode)) continue;
      mode = positioningMode(style);
      // A propagated body overflow clips at the viewport, even when body's own height is zero.
      if (ancestor === document.body && bodyOverflowIsViewport) continue;
      const paintClip = /\b(paint|strict|content)\b/.test(style.contain);
      const clipX = paintClip || /(auto|scroll|hidden|clip|overlay)/.test(style.overflowX);
      const clipY = paintClip || /(auto|scroll|hidden|clip|overlay)/.test(style.overflowY);
      if (clipX || clipY) ancestors.push({ element: ancestor, style, clipX, clipY });
    }
    return { ancestors, fixedToViewport: mode === "fixed" && !establishesContainingBlock(rootStyle, "fixed") };
  }
  function visibleBox(element) {
    let result = intersect(box(element), viewport());
    for (const { element: ancestor, clipX, clipY } of clipChain(element).ancestors) {
      const rect = box(ancestor);
      if (clipX) result = { ...result, left: Math.max(result.left, rect.left), right: Math.min(result.right, rect.right) };
      if (clipY) result = { ...result, top: Math.max(result.top, rect.top), bottom: Math.min(result.bottom, rect.bottom) };
    }
    return result;
  }
  function logicalLeft(element) {
    const rtl = getComputedStyle(element).direction === "rtl";
    return rtl ? element.scrollWidth - element.clientWidth + element.scrollLeft : element.scrollLeft;
  }
  function scrollTo(element, x, y) {
    const left = getComputedStyle(element).direction === "rtl" ? x - Math.max(0, element.scrollWidth - element.clientWidth) : x;
    element.scrollTo({ left, top: y, behavior: "instant" });
  }
  function info() {
    return { nonce, url: location.href, title: document.title, viewportWidth: innerWidth, viewportHeight: innerHeight, pixelRatio: devicePixelRatio,
      iframes: [...document.querySelectorAll("iframe,frame")].map((element) => ({ id: idFor(element) })) };
  }
  function identifyChildren(runId) {
    return [...document.querySelectorAll("iframe,frame")].map((element) => {
      const id = idFor(element);
      const token = `${runId}:${id}:${crypto.randomUUID()}`;
      element.contentWindow?.postMessage({ marker: MARKER, runId, token }, "*");
      return { id, token };
    });
  }
  function validate(target) {
    if (target.nonce && target.nonce !== nonce) throw new Error("ページが再読み込みされました。撮影する領域を選び直してください。");
  }
  function measure(target) {
    validate(target);
    const element = scroller(target);
    const documentTarget = target.kind === "document";
    const rect = documentTarget ? { ...viewport(), sx: 1, sy: 1 } : box(element);
    const visible = documentTarget ? viewport() : visibleBox(element);
    return { box: rect, visible, width: Math.max(element.scrollWidth, element.clientWidth), height: Math.max(element.scrollHeight, element.clientHeight),
      scrollX: logicalLeft(element), scrollY: element.scrollTop, viewportWidth: innerWidth, viewportHeight: innerHeight, nonce };
  }

  // Only scroll existing viewports; never stretch the document or iframe.
  function reveal(element, point, inset={x:0,y:0}) {
    const chain = clipChain(element);
    for (const { element: ancestor, style, clipX, clipY } of chain.ancestors) {
      if (ancestor === document.scrollingElement) continue;
      const canScrollX = clipX && /(auto|scroll|hidden|overlay)/.test(style.overflowX);
      const canScrollY = clipY && /(auto|scroll|hidden|overlay)/.test(style.overflowY);
      if (!canScrollX && !canScrollY) continue;
      const desired = point();
      const r = box(ancestor);
      ancestor.scrollBy({ left: canScrollX ? (desired.x - r.left-inset.x) / r.sx : 0, top: canScrollY ? (desired.y - r.top-inset.y) / r.sy : 0, behavior: "instant" });
    }
    if (!chain.fixedToViewport) {
      const desired = point();
      window.scrollBy({ left: desired.x-inset.x, top: desired.y-inset.y, behavior: "instant" });
    }
    return point();
  }
  function position(target, x, y, inset={x:0,y:0}) {
    validate(target);
    const element = scroller(target);
    const insetX=Math.min(inset.x,element.clientWidth/4),insetY=Math.min(inset.y,element.clientHeight/4);
    scrollTo(element,Math.max(0,x-insetX),Math.max(0,y-insetY));
    const point = () => {
      const value = measure(target);
      return { x: value.box.left + (x - value.scrollX) * value.box.sx, y: value.box.top + (y - value.scrollY) * value.box.sy };
    };
    if (target.kind !== "document") {
      const value=measure(target);
      reveal(element,point,{x:insetX*value.box.sx,y:insetY*value.box.sy});
    }
    return point();
  }
  function revealFrame(id, point, inset={x:0,y:0}) {
    const element = getNode(id);
    return reveal(element, () => { const r = box(element); return { x: r.left + point.x * r.sx, y: r.top + point.y * r.sy }; },inset);
  }
  function frameBox(id) {
    const element = getNode(id);
    return { box: box(element), visible: visibleBox(element) };
  }
  function change(element, property, value) {
    let properties = capture.styles.get(element);
    if (!properties) capture.styles.set(element, properties = new Map());
    if (!properties.has(property)) properties.set(property, { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) });
    element.style.setProperty(property, value, "important");
  }
  function prepare(target) {
    if (capture) return true;
    stopPicker();
    const style = document.createElement("style");
    style.textContent = "*{scroll-behavior:auto!important;scroll-snap-type:none!important;overflow-anchor:none!important;caret-color:transparent!important;content-visibility:visible!important}";
    capture = { styles: new Map(), scrolls: [...document.querySelectorAll("*")].filter((e) => e.scrollLeft || e.scrollTop || e.scrollWidth>e.clientWidth || e.scrollHeight>e.clientHeight).map((element) => ({ element, x: element.scrollLeft, y: element.scrollTop })), x: scrollX, y: scrollY, style };
    if (target?.id) {
      // Document queries do not include shadow descendants. Snapshot the entire
      // target chain as well, in outer-to-inner order for scroll restoration.
      const chain = [];
      for (let element = getNode(target.id); element; element = parent(element)) chain.push(element);
      const saved = new Set(capture.scrolls.map((item) => item.element));
      for (const element of chain.reverse()) if (!saved.has(element)) capture.scrolls.push({ element, x: element.scrollLeft, y: element.scrollTop });
    }
    document.documentElement.append(style);
    return true;
  }
  function floating(target, repeat) {
    if (!capture) return true;
    const protectedElements = new Set([document.documentElement, document.body]);
    // contains() stops at shadow boundaries; parent() also follows shadow hosts.
    if (target?.kind === "scroll") for (let element = getNode(target.id); element; element = parent(element)) protectedElements.add(element);
    for (const element of document.querySelectorAll("*")) {
      if (protectedElements.has(element)) continue;
      const position = getComputedStyle(element).position;
      if (position === "sticky") {
        change(element, "position", "relative");
        change(element, "top", "auto"); change(element, "bottom", "auto");
        change(element, "left", "auto"); change(element, "right", "auto");
      }
      if (position === "fixed" && repeat) change(element, "visibility", "hidden");
    }
    return true;
  }
  async function settle(waitMs) {
    let lastMutation = performance.now();
    const observer = new MutationObserver(() => { lastMutation = performance.now(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      await delay(waitMs);
      await Promise.race([document.fonts?.ready || Promise.resolve(), delay(6000)]);
      const images = [...document.images].filter((image) => {
        const r = image.getBoundingClientRect(); return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      });
      const pending = images.filter((image) => !image.complete || (image.naturalWidth && image.decode));
      let timedOut = false;
      await Promise.race([
        Promise.all(pending.map((image) => image.decode ? image.decode().catch(() => {}) : new Promise((resolve) => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); }))),
        delay(8000).then(() => { timedOut = true; })
      ]);
      const deadline = performance.now() + 1500;
      while (performance.now() - lastMutation < 150 && performance.now() < deadline) await delay(80);
      // CSS transitions and animations change no DOM attributes, so wait for finite ones to
      // finish; otherwise a seam can capture a row mid-fade.
      const animations = (document.getAnimations?.() || []).filter((animation) => animation.effect?.getComputedTiming?.()?.iterations !== Infinity);
      if (animations.length) await Promise.race([Promise.all(animations.map((animation) => animation.finished.catch(() => {}))), delay(3000)]);
      await Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), delay(500)]);
      if (document.hidden) throw new Error("撮影するタブを表示したままお待ちください。");
      if (timedOut && images.some((image) => !image.complete)) throw new Error("画像の読み込みが終わりません。読み込み後に再度撮影してください。");
      return true;
    } finally { observer.disconnect(); }
  }
  function restoreStyles() {
    if (!capture) return true;
    for (const [element, properties] of capture.styles) for (const [name, original] of properties) {
      if (original.value) element.style.setProperty(name, original.value, original.priority); else element.style.removeProperty(name);
    }
    // Remove empty attributes added by our property edits.
    for (const element of capture.styles.keys()) if (!element.style.length) element.removeAttribute("style");
    return true;
  }
  function restoreScroll() {
    if (!capture) return true;
    for (const { element, x, y } of capture.scrolls) if (element.isConnected) element.scrollTo({ left: x, top: y, behavior: "instant" });
    window.scrollTo({ left: capture.x, top: capture.y, behavior: "instant" });
    capture.style.remove(); capture = null;
    return true;
  }

  function stopPicker() {
    if (!picker) return true;
    for (const [type, fn] of picker.events) window.removeEventListener(type, fn, true);
    clearTimeout(picker.timer); picker.host.remove(); picker = null;
    return true;
  }
  function startPicker(token, isTop) {
    stopPicker();
    const host = document.createElement("div"); host.dataset.slideshotsPicker = "";
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ":host{font:14px/1.5 system-ui;color:white}.outline{position:fixed;box-sizing:border-box;border:3px solid #008874;background:#00aa8820;border-radius:4px;pointer-events:none}.bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:90vw;width:max-content;background:#173d36;padding:10px 14px;border-radius:9px;box-shadow:0 2px 20px #0004;pointer-events:auto}button{font:inherit;padding:6px 12px;margin-left:10px;border:0;border-radius:5px;background:white;color:#173d36;cursor:pointer}";
    const outline = document.createElement("div"); outline.className = "outline"; outline.hidden = true;
    shadow.append(style, outline);
    function finish(selection) {
      stopPicker();
      if (!connected()) return;
      chrome.runtime.sendMessage({ type: selection ? "regionPicked" : "cancelPick", token, selection }).catch(() => {});
    }
    if (isTop) {
      const bar = document.createElement("div"); bar.className = "bar";
      bar.append("撮りたい内部ページの中をクリック");
      const cancel = document.createElement("button"); cancel.textContent = "キャンセル"; cancel.addEventListener("click", () => finish(null));
      bar.append(cancel); shadow.append(bar);
    }
    document.documentElement.append(host);
    function candidate(event) {
      if (event.composedPath().includes(host)) return null;
      let element = event.composedPath().find((node) => node instanceof Element);
      for (; element && element !== document.body && element !== document.documentElement; element = parent(element)) {
        if (scrollable(element)) return { kind: "scroll", id: idFor(element), nonce, label: label(element) };
        if (element.matches("iframe,frame")) return { kind: "iframe", id: idFor(element), nonce, label: element.title || "埋め込みページ" };
      }
      return !isTop ? { kind: "document", nonce, label: document.title || "埋め込みページ" } : null;
    }
    const move = (event) => {
      const selection = candidate(event); outline.hidden = !selection;
      if (!selection) return;
      const r = selection.kind === "document" ? viewport() : visibleBox(getNode(selection.id));
      Object.assign(outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${Math.max(0, r.right-r.left)}px`, height: `${Math.max(0, r.bottom-r.top)}px` });
    };
    const block = (event) => { if (!event.composedPath().includes(host)) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const click = (event) => { if(event.composedPath().includes(host)) return; const selection = candidate(event); block(event); if (event.button === 0 && selection) finish(selection); };
    const key = (event) => { if (event.key === "Escape") finish(null); };
    const events = [["pointermove",move],["pointerdown",block],["pointerup",block],["mousedown",block],["mouseup",block],["click",click],["keydown",key]];
    for (const [type, fn] of events) window.addEventListener(type, fn, true);
    picker = { host, events, timer: setTimeout(() => finish(null), 120000) };
    return true;
  }
  const identify = (event) => {
    if (!connected()) return teardown();
    if (window === parentWindow() || event.source !== parentWindow() || event.data?.marker !== MARKER || typeof event.data.token !== "string") return;
    chrome.runtime.sendMessage({ type: "frameIdentified", token: event.data.token, runId: event.data.runId }).catch(() => {});
  };
  function parentWindow() { return window.parent; }
  window.addEventListener("message", identify);
  function listener(message, _sender, respond) {
    if (message?.channel !== "slideshots-agent") return;
    (async () => {
      switch(message.op) {
        case "info": return info();
        case "identifyChildren": return identifyChildren(message.runId);
        case "startPicker": return startPicker(message.token, message.isTop);
        case "stopPicker": return stopPicker();
        case "measure": return measure(message.target);
        case "position": return position(message.target, message.x, message.y,message.inset);
        case "revealFrame": return revealFrame(message.id, message.point,message.inset);
        case "frameBox": return frameBox(message.id);
        case "prepare": return prepare(message.target);
        case "floating": return floating(message.target, message.repeat);
        case "settle": return settle(message.waitMs);
        case "restoreStyles": return restoreStyles();
        case "restoreScroll": return restoreScroll();
        default: throw new Error("不明な操作です。");
      }
    })().then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: error.message }));
    return true;
  }
  chrome.runtime.onMessage.addListener(listener);
  function teardown() {
    stopPicker();
    restoreStyles();
    restoreScroll();
    try { chrome.runtime.onMessage.removeListener(listener); } catch { /* The extension context is already gone. */ }
    window.removeEventListener("message", identify);
  }
  globalThis.__slideShotsAgent = { version: VERSION, connected, dispose: teardown };
})();
