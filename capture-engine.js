/* Scroll, render, capture the visible pixels, and stitch them in bounded canvases. */
globalThis.captureEngine = async function captureEngine({ tabId, windowId, scan, target, options, job, agent, status, save, log }) {
  const note = (text,data) => { try{ log?.(text,data); }catch{ /* Diagnostics must never break a capture. */ } };
  const path = [];
  let frameId = target.frameId;
  const seen = new Set();
  while (frameId !== 0) {
    if (seen.has(frameId)) throw new Error("内部ページの階層を取得できません。");
    seen.add(frameId);
    const link = scan.parents.get(frameId);
    if (!link) throw new Error("内部ページに接続できません。ページを読み込み直して選び直してください。");
    path.push({ childFrameId: frameId, ...link });
    frameId = link.parentFrameId;
  }
  const frames = [...new Set([target.frameId, ...path.map((link) => link.parentFrameId)])];
  const targets = new Map([[target.frameId, target], ...path.map((link) => [link.parentFrameId, { kind: "scroll", id: link.iframeId }])]);
  const rectIntersection = (a,b) => ({ left: Math.max(a.left,b.left), top: Math.max(a.top,b.top), right: Math.min(a.right,b.right), bottom: Math.min(a.bottom,b.bottom) });
  const transform = (r,b) => ({ left:b.left+r.left*b.sx, top:b.top+r.top*b.sy, right:b.left+r.right*b.sx, bottom:b.top+r.bottom*b.sy });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
  let width = 0;
  let height = 0;
  let bandHeight = 0;
  let lastCaptureAt = 0;
  let tiles = 0;
  let firstBand = 0;
  let outputParts = 0;
  let outputHeight = 0;
  let verificationFailures = 0;
  let pdf = null;
  const bands = new Map();
  function checkStopped() {
    if (job.stop) throw new Error("撮影を停止しました。");
    if (job.interrupted) throw new Error(job.interrupted);
  }
  async function ensureActive() {
    checkStopped();
    const [active] = await chrome.tabs.query({ windowId, active: true });
    if (active?.id !== tabId || (await chrome.windows.get(windowId)).state === "minimized") throw new Error("タブが切り替わったため撮影を中止しました。対象のタブを表示したまま撮影してください。");
  }
  // Respect Chrome's captureVisibleTab rate limit (about two calls per second).
  async function shot() {
    await pause(Math.max(0,550-(Date.now()-lastCaptureAt)));
    await ensureActive();
    lastCaptureAt=Date.now();
    return chrome.tabs.captureVisibleTab(windowId,{format:"png"});
  }
  async function measured() {
    const value = await agent(tabId,target.frameId,"measure",{target});
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width < 1 || value.height < 1) throw new Error("領域の大きさを取得できません。");
    return value;
  }
  function acceptSize(value) {
    if (value.width > 24000) throw new Error("領域の横幅が大きすぎます（上限 24,000 px）。");
    const measuredWidth = Math.round(value.width);
    // Keep every tile, output canvas and reported dimension on the initial pixel width.
    if (width && measuredWidth !== width) { note("width changed",{before:width,after:measuredWidth}); throw new Error("撮影中に横幅が変わりました。ページの読み込みが落ち着いてから再度撮影してください。"); }
    width ||= measuredWidth; height = Math.round(value.height);
    if(!bandHeight) {
      if(options.format==="pdf") {
        pdf=new PdfWriter(width);
        bandHeight=Math.min(4000,Math.floor(32_000_000/width));
      } else bandHeight=Math.min(16000,Math.floor(32_000_000/width));
    }
  }
  function band(index) {
    if (index < firstBand) throw new Error("ページの配置が途中で変わりました。読み込み後に再度撮影してください。");
    if (!bands.has(index)) {
      const canvas = new OffscreenCanvas(width,Math.min(bandHeight,Math.max(1,height-index*bandHeight)));
      const context = canvas.getContext("2d", { alpha:false });
      if (!context) throw new Error("画像を作成するメモリが不足しています。");
      context.fillStyle = "white"; context.fillRect(0,0,canvas.width,canvas.height);
      bands.set(index,canvas);
    }
    let canvas = bands.get(index);
    const wantedHeight = Math.min(bandHeight,Math.max(1,height-index*bandHeight));
    if (wantedHeight > canvas.height) {
      const expanded = new OffscreenCanvas(width,wantedHeight);
      const context = expanded.getContext("2d",{alpha:false});
      context.fillStyle="white"; context.fillRect(0,0,width,wantedHeight); context.drawImage(canvas,0,0);
      canvas.width=1; canvas.height=1; bands.set(index,expanded); canvas=expanded;
    }
    return canvas;
  }
  async function flush(index, finalHeight) {
    const canvas = bands.get(index);
    if (!canvas) return;
    const actualHeight = Math.min(canvas.height,finalHeight-index*bandHeight);
    if (actualHeight <= 0) return;
    let image = canvas;
    if (actualHeight !== canvas.height) {
      image = new OffscreenCanvas(width,actualHeight);
      image.getContext("2d",{alpha:false}).drawImage(canvas,0,0);
    }
    if(pdf) {
      await pdf.addBand(image,actualHeight);
      outputHeight+=actualHeight;
    } else {
      const formats={png:{type:"image/png",extension:"png"},jpeg:{type:"image/jpeg",extension:"jpg",quality:.92},webp:{type:"image/webp",extension:"webp",quality:.92}};
      const format=formats[options.format||"png"];
      if(!format) throw new Error("画像形式を確認してください。");
      const blob = await image.convertToBlob({type:format.type,quality:format.quality});
      if(blob.type && blob.type!==format.type) throw new Error("この画像形式には対応していません。");
      const split = index>0 || finalHeight>bandHeight;
      await save(blob,split ? `part-${String(index+1).padStart(3,"0")}.${format.extension}` : `capture.${format.extension}`);
      outputParts++; outputHeight+=actualHeight;
    }
    image.width=1; image.height=1; canvas.width=1; canvas.height=1;
    bands.delete(index); firstBand=index+1;
  }
  function sourceRange(start,end,limit) {
    let first=Math.max(0,Math.min(limit-1,Math.round(start)));
    let last=Math.min(limit,Math.round(end));
    // If rounding collapses a sub-pixel strip, sample its painted pixel instead of
    // the adjacent pixel beyond the viewport's edge.
    if(last<=first) {
      first=Math.max(0,Math.min(limit-1,Math.floor(start)));
      last=Math.min(limit,Math.max(first+1,Math.ceil(end)));
    }
    return {first,length:Math.max(1,last-first)};
  }
  function draw(bitmap, tile, x, y, tw, th, pixelRatio) {
    const scaleX = tile.sx*pixelRatio;
    const scaleY = tile.sy*pixelRatio;
    const originX = tile.point.x*pixelRatio;
    const originY = tile.point.y*pixelRatio;
    for(let start=y;start<y+th;) {
      const index=Math.floor(start/bandHeight);
      const end=Math.min(y+th,(index+1)*bandHeight);
      // Sample whole device pixels so seams between tiles stay crisp instead of blending
      // fractional rows on scaled regions (CSS scale / Windows display scaling).
      const right=tile.visible.right*pixelRatio,bottom=tile.visible.bottom*pixelRatio;
      const sourceX=sourceRange(Math.min(originX,right-.000001),Math.min(originX+tw*scaleX,right),bitmap.width);
      const sourceY=sourceRange(Math.min(originY+(start-y)*scaleY,bottom-.000001),Math.min(originY+(end-y)*scaleY,bottom),bitmap.height);
      band(index).getContext("2d").drawImage(bitmap,sourceX.first,sourceY.first,sourceX.length,sourceY.length,x,start-index*bandHeight,tw,end-start);
      start=end;
    }
  }
  async function locate(x,y) {
    const inset={x:x>0?16:0,y:y>0?16:0};
    let point=await agent(tabId,target.frameId,"position",{target,x,y,inset});
    for(const link of path) point=await agent(tabId,link.parentFrameId,"revealFrame",{id:link.iframeId,point,inset});
    await Promise.all(frames.map((id)=>agent(tabId,id,"settle",{waitMs:options.waitMs})));
    checkStopped();
    const value=await measured(); acceptSize(value);
    let visible=value.visible;
    point={x:value.box.left+(x-value.scrollX)*value.box.sx,y:value.box.top+(y-value.scrollY)*value.box.sy};
    let sx=value.box.sx,sy=value.box.sy;
    const chain=[];
    for(const link of path) {
      const parent=await agent(tabId,link.parentFrameId,"frameBox",{id:link.iframeId});
      point={x:parent.box.left+point.x*parent.box.sx,y:parent.box.top+point.y*parent.box.sy};
      visible=rectIntersection(transform(visible,parent.box),parent.visible);
      sx*=parent.box.sx; sy*=parent.box.sy;
      chain.push({frameId:link.parentFrameId,iframeId:link.iframeId,box:parent.box,visible:parent.visible});
    }
    // Require one content pixel on each axis, measured before the CSS/iframe scale.
    // A visible content pixel can be less than one screen pixel at any tile boundary.
    const availableWidth=(visible.right-point.x)/sx;
    const availableHeight=(visible.bottom-point.y)/sy;
    const validScale=Number.isFinite(sx) && sx>0 && Number.isFinite(sy) && sy>0;
    const top=await agent(tabId,0,"info");
    const pixelRatio=Number.isFinite(top.pixelRatio)&&top.pixelRatio>0?top.pixelRatio:1;
    // Browsers quantize scroll offsets to device pixels. At the document end the
    // visible part can fall short by a fraction of one device pixel after scaling.
    const toleranceX=Math.max(.01,.5/(pixelRatio*sx)),toleranceY=Math.max(.01,.5/(pixelRatio*sy));
    const fitsX=availableWidth+.01>=Math.min(1,width-x) || width-x<=availableWidth+toleranceX;
    const fitsY=availableHeight+.01>=Math.min(1,height-y) || height-y<=availableHeight+toleranceY;
    if(!validScale || point.x < visible.left-.5 || point.y < visible.top-.5 || availableWidth<=0 || availableHeight<=0 || !fitsX || !fitsY) {
      note("hidden detail",{x,y,point,visible,sx,sy,measure:{box:value.box,visible:value.visible,scrollX:value.scrollX,scrollY:value.scrollY,width:value.width,height:value.height},parents:chain});
      throw new Error("対象の一部が別の枠で隠れています。枠が見える位置に移動して選び直してください。");
    }
    note(`tile ${x},${y} point ${point.x.toFixed(1)},${point.y.toFixed(1)} visible ${visible.left.toFixed(1)},${visible.top.toFixed(1)} ${visible.right.toFixed(1)},${visible.bottom.toFixed(1)} s ${sx.toFixed(3)},${sy.toFixed(3)}`);
    return {point,visible,sx,sy,viewportWidth:top.viewportWidth,toleranceX,toleranceY};
  }
  function tileExtent(remaining,available,tolerance) {
    if(remaining<=available+tolerance) return remaining;
    // Leave an overlapping strip at an unfinished edge; the next tile captures it
    // from inside the viewport, beyond borders, fades and clipped edge pixels.
    const overlap=remaining>available+.01?Math.min(16,available/4):0;
    return Math.min(remaining,Math.max(1,Math.floor(available-overlap+.01)));
  }
  try {
    await ensureActive();
    for(const id of frames) await agent(tabId,id,"prepare",{target:targets.get(id)});
    for(const id of frames) await agent(tabId,id,"floating",{target:targets.get(id),repeat:id!==target.frameId || target.kind!=="document"});
    acceptSize(await measured());
    let y=0;
    while(y<height) {
      let x=0,rowHeight=Infinity;
      while(x<width) {
        await ensureActive();
        if(++tiles>1200) throw new Error("ページが長すぎるか、追加読み込みが続いています。撮影範囲を小さくして再度撮影してください。");
        if(options.hideFixed && (x>0 || y>0)) for(const id of frames) await agent(tabId,id,"floating",{target:targets.get(id),repeat:true});
        await status(`撮影中… ${Math.min(y,height).toLocaleString()} / ${height.toLocaleString()} px\nこのタブを操作せず、表示したままお待ちください。`);
        const tile=await locate(x,y);
        const tw=tileExtent(width-x,(tile.visible.right-tile.point.x)/tile.sx,tile.toleranceX);
        const th=tileExtent(height-y,(tile.visible.bottom-tile.point.y)/tile.sy,tile.toleranceY);
        if(tw<1 || th<1) throw new Error("表示できる範囲が小さすぎます。ブラウザのウィンドウを広げてください。");
        // Matching screenshots are treated as stable. If retries are exhausted, keep
        // the latest screenshot and log the failure without stopping the capture.
        let data;
        if(options.verify){
          let previous=await shot();
          for(let attempt=1;;attempt++){
            data=await shot();
            if(data===previous) break;
            note(`verify retry ${x},${y} #${attempt}`);
            if(attempt>=5){
              verificationFailures++;
              note(`verify unstable ${x},${y} 検証失敗: 5回の比較で画像が一致しませんでした。最新の画像で撮影を続行します。`);
              break;
            }
            previous=data;
          }
        } else data=await shot();
        await ensureActive();
        const bitmap=await createImageBitmap(await (await fetch(data)).blob());
        try { draw(bitmap,tile,x,y,tw,th,bitmap.width/tile.viewportWidth); } finally { bitmap.close(); }
        rowHeight=Math.min(rowHeight,th); x+=tw;
      }
      y+=rowHeight;
      acceptSize(await measured());
      for(const index of [...bands.keys()].sort((a,b)=>a-b)) if((index+1)*bandHeight<=y && y<height) await flush(index,height);
    }
    checkStopped();
    for(const index of [...bands.keys()].sort((a,b)=>a-b)) await flush(index,height);
    if(pdf) {
      await status("PDFを作成しています…");
      await save(await pdf.finish(),"capture.pdf");
      outputParts=1;
    }
    return {width,height,parts:outputParts,tiles,outputHeight,...(pdf?{pages:pdf.pages.length}:{})};
  } finally {
    // Keep a summary at the end even if per-tile warnings fell out of the bounded log.
    if(verificationFailures) note(`検証失敗: 合計 ${verificationFailures} タイル。描画の一致を確認できなかったタイルは最新の画像を採用して続行しました。`);
    for(const canvas of bands.values()) {canvas.width=1;canvas.height=1;}
    // Restore all geometry first, then original scroll offsets from the outer frame inward.
    await Promise.allSettled(frames.map((id)=>agent(tabId,id,"restoreStyles")));
    for(const id of [...frames].reverse()) await agent(tabId,id,"restoreScroll").catch(()=>{});
  }
};
