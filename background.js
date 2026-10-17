importScripts("directory-store.js","download-store.js","pdf-writer.js","capture-engine.js");
const identified = new Map();
let identifying = null;
let current = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));

/* Diagnostic trace shown in the popup's advanced log console. */
const TRACE_LIMIT = 600;
let trace = [];
function logCapture(text,data) {
  trace.push(`${new Date().toISOString().slice(11,23)} ${text}${data===undefined?"":" "+(typeof data==="string"?data:JSON.stringify(data))}`);
  if(trace.length>TRACE_LIMIT) trace.splice(0,trace.length-TRACE_LIMIT);
}
async function saveLog() {
  try{ await chrome.storage.local.set({captureLog:trace}); }catch{ /* Best-effort: storage may be full. */ }
}

async function status(message,running=true,details={}) {
  await chrome.storage.local.set({captureStatus:{running,message,updatedAt:Date.now(),...details}});
  await chrome.action.setBadgeText({text:running?"REC":""});
  if(running) await chrome.action.setBadgeBackgroundColor({color:"#087565"});
}
async function agent(tabId,frameId,op,args={}) {
  const reply = await chrome.tabs.sendMessage(tabId,{channel:"slideshots-agent",op,...args},{frameId});
  if(!reply?.ok) throw new Error(reply?.error || "内部ページとの接続が切れました。選び直してください。");
  return reply.result;
}
async function scanAll(tabId) {
  const tab=await chrome.tabs.get(tabId);
  if(!/^(https?:|file:)/.test(tab.url || "")) throw new Error("撮影する Web ページを開いてください。");
  const injected=await chrome.scripting.executeScript({target:{tabId,allFrames:true},files:["frame-agent.js"]});
  const frames=new Map();
  for(const {frameId} of injected) {
    try{ frames.set(frameId,await agent(tabId,frameId,"info")); }catch{ /* A frame may navigate while enumerating. */ }
  }
  if(!frames.has(0)) throw new Error("ページに接続できません。読み込み後に再試行してください。");
  const runId=crypto.randomUUID();
  identifying={tabId,runId}; identified.clear();
  const children=[];
  try {
    for(const frameId of frames.keys()) {
      try{ for(const child of await agent(tabId,frameId,"identifyChildren",{runId})) children.push({...child,parentFrameId:frameId}); }catch{ /* Ignore detached frames. */ }
    }
    // Replies normally arrive immediately; give process-isolated frames time to respond.
    for(let i=0;i<20 && children.some((child)=>!identified.has(child.token));i++) await sleep(50);
  } finally {identifying=null;}
  const parents=new Map(), childByElement=new Map();
  for(const child of children) {
    const frameId=identified.get(child.token);
    if(frameId===undefined || !frames.has(frameId)) continue;
    parents.set(frameId,{parentFrameId:child.parentFrameId,iframeId:child.id});
    childByElement.set(`${child.parentFrameId}:${child.id}`,frameId);
  }
  identified.clear();
  return {frames,parents,childByElement};
}
async function endPick(state) {
  if(!state) return;
  await Promise.allSettled(state.frameIds.map((frameId)=>agent(state.tabId,frameId,"stopPicker")));
  await chrome.storage.session.remove("pickState");
  if(!current) await chrome.action.setBadgeText({text:""});
}
async function waitForDownloads(ids) {
  const end=Date.now()+120000;
  while(ids.length) {
    const results=await Promise.all(ids.map((id)=>chrome.downloads.search({id})));
    if(results.some(([item])=>!item || item.state==="interrupted")) throw new Error("ダウンロードが中断されました。");
    if(results.every(([item])=>item.state==="complete")) return;
    if(Date.now()>end) throw new Error("保存完了を確認できませんでした。");
    await sleep(400);
  }
}
async function blobDataUrl(blob) {
  const bytes=new Uint8Array(await blob.arrayBuffer()),chunks=[];
  for(let offset=0;offset<bytes.length;offset+=32768) chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));
  return `data:${blob.type};base64,${btoa(chunks.join(""))}`;
}
async function ensureDownloadPage() {
  const url=chrome.runtime.getURL("download.html");
  const contexts=await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"],documentUrls:[url]});
  if(!contexts.length) await chrome.offscreen.createDocument({url:"download.html",reasons:["BLOBS"],justification:"Create a Blob URL for a large captured PDF download."});
}

async function runCapture(job) {
  const {tabId,options}=job;
  const downloads=[];
  const stamp=new Date().toISOString().replace(/[:.]/g,"-");
  let folder=options.destination==="folder"?`指定フォルダー/${stamp}`:`SlideShots/${stamp}`;
  let chosenFolder,outputDirectory,savedFiles=0,pdfKey=null;
  const savedCount=()=>options.destination==="folder"?savedFiles:downloads.length;
  let finalMessage,details;
  trace=[`${new Date().toISOString()} SlideShots ${chrome.runtime.getManifest().version} 撮影開始 (tab ${tabId})`,`ua ${navigator.userAgent}`,`options ${JSON.stringify(options)}`];
  try {
    if(options.destination==="folder"){
      chosenFolder=await directoryStore.get();
      if(!chosenFolder)throw new Error("保存先のフォルダーを選び直してください。");
      if(await chosenFolder.queryPermission({mode:"readwrite"})!=="granted")throw new Error("保存先フォルダーへの書き込みを許可してください。");
      folder=`${chosenFolder.name}/${stamp}`;
    }
    const tab=await chrome.tabs.get(tabId);
    job.windowId=tab.windowId;
    const scan=await scanAll(tabId);
    logCapture("frames",[...scan.frames].map(([id,frame])=>({id,url:frame.url,viewportWidth:frame.viewportWidth,viewportHeight:frame.viewportHeight})));
    logCapture("parents",[...scan.parents]);
    const target=options.scope==="page" ? {kind:"document",frameId:0,nonce:scan.frames.get(0).nonce} : options.target;
    if(!target || !scan.frames.has(target.frameId) || target.nonce!==scan.frames.get(target.frameId).nonce) throw new Error("内部ページをもう一度クリックして選んでください。");
    logCapture("target",target);
    const save=async(blob,name)=>{
      const filename=`${options.scope==="page"?"page":"region"}-${name}`;
      if(chosenFolder){
        outputDirectory ||= await chosenFolder.getDirectoryHandle(stamp,{create:true});
        const file=await outputDirectory.getFileHandle(filename,{create:true});
        const writer=await file.createWritable();
        try{await writer.write(blob);await writer.close();}catch(error){await writer.abort().catch(()=>{});throw error;}
        savedFiles++;
      }else if(options.format==="pdf"){
        pdfKey=crypto.randomUUID();
        await downloadStore.put(pdfKey,blob);
        await ensureDownloadPage();
        const reply=await chrome.runtime.sendMessage({type:"makePdfUrl",key:pdfKey});
        if(!reply?.ok||!reply.url)throw new Error(reply?.error||"PDFのダウンロードを開始できません。");
        downloads.push(await chrome.downloads.download({url:reply.url,filename:`${folder}/${filename}`,saveAs:false,conflictAction:"uniquify"}));
      }else downloads.push(await chrome.downloads.download({url:await blobDataUrl(blob),filename:`${folder}/${filename}`,saveAs:false,conflictAction:"uniquify"}));
    };
    const dimensions=await captureEngine({tabId,windowId:tab.windowId,scan,target,options,job,agent,status,log:logCapture,save});
    await status("保存を確認しています…");
    await waitForDownloads(downloads);
    finalMessage=`保存しました。${dimensions.width.toLocaleString()} × ${dimensions.height.toLocaleString()} px`+(options.format==="pdf"?`（PDF 1ファイル・${dimensions.pages}ページ）`:savedCount()>1?`\n長い画像を ${savedCount()} 枚に分割して全範囲を保存しました。`:`（${options.format.toUpperCase()} 1枚）`);
    details={outcome:"completed",saved:savedCount(),folder,...dimensions};
  } catch(error) {
    finalMessage=error.message+(savedCount()&&options.format!=="pdf"?`\n途中まで保存した画像: ${savedCount()} 枚。全範囲の撮影は完了していません。`:"");
    details={outcome:job.stop?"stopped":"failed",saved:options.format==="pdf"?0:savedCount(),folder};
    logCapture("error",error.message);
    logCapture("error stack",error.stack || "");
  } finally {
    if(pdfKey){
      await chrome.runtime.sendMessage({type:"revokePdfUrl",key:pdfKey}).catch(()=>{});
      await downloadStore.remove(pdfKey).catch(()=>{});
      await chrome.offscreen.closeDocument().catch(()=>{});
    }
    logCapture("end",details);
    await saveLog();
    current=null;
    await status(finalMessage,false,details);
  }
}

async function control(message) {
  if(message.type==="getCaptureState") {
    const {captureStatus}=await chrome.storage.local.get("captureStatus");
    if(captureStatus?.running && !current) await status("前回の撮影が中断されました。ページを再読み込みしてから撮影してください。",false,{outcome:"failed"});
    return {};
  }
  if(message.type==="stopCapture") {if(current) current.stop=true;return {};}
  if(message.type==="beginPick") {
    if(current) throw new Error("撮影が終わってから選んでください。");
    await endPick((await chrome.storage.session.get("pickState")).pickState);
    const scan=await scanAll(message.tabId);
    const state={tabId:message.tabId,pageUrl:(await chrome.tabs.get(message.tabId)).url,frameIds:[...scan.frames.keys()],token:crypto.randomUUID(),children:[...scan.childByElement],frames:[...scan.frames]};
    await chrome.storage.session.set({pickState:state});
    const results=await Promise.allSettled(state.frameIds.map((frameId)=>agent(state.tabId,frameId,"startPicker",{token:state.token,isTop:frameId===0})));
    if(results[state.frameIds.indexOf(0)]?.status!=="fulfilled") {await endPick(state);throw new Error("範囲の選択を開始できません。");}
    await chrome.action.setBadgeText({text:"選択"});
    return {};
  }
  if(message.type==="useFrameDocument") {
    const key=`region:${message.tabId}`;
    const selection=(await chrome.storage.session.get(key))[key];
    if(!selection?.target?.frameId) throw new Error("埋め込みページの中を選んでください。");
    const info=await agent(message.tabId,selection.target.frameId,"info");
    selection.target={kind:"document",frameId:selection.target.frameId,nonce:info.nonce,label:info.title || "埋め込みページ"};
    await chrome.storage.session.set({[key]:selection}); return {selection};
  }
  if(message.type==="startCapture") {
    if(current) throw new Error("撮影が進行中です。");
    const options=message.options || {};
    if(!Number.isInteger(message.tabId) || !["page","region"].includes(options.scope) || !Number.isFinite(options.waitMs) || options.waitMs<200 || options.waitMs>10000) throw new Error("撮影対象と描画待ち時間を確認してください。");
    if(options.scope==="region" && (!options.target || !["scroll","document"].includes(options.target.kind) || !Number.isInteger(options.target.frameId) || (options.target.kind==="document" && options.target.frameId===0))) throw new Error("内部ページをクリックして選んでください。");
    options.verify=!!options.verify;
    options.destination ||= "downloads";
    options.format ||= "png";
    if(!["downloads","folder"].includes(options.destination)||!["png","jpeg","webp","pdf"].includes(options.format))throw new Error("保存先と保存形式を確認してください。");
    delete options.fastShot;
    current={tabId:message.tabId,options,stop:false};
    try {
      await endPick((await chrome.storage.session.get("pickState")).pickState);
      await status("撮影を準備しています…");
      void runCapture(current);
    }catch(error){current=null;throw error;}
    return {};
  }
  throw new Error("不明な操作です。");
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(["makePdfUrl","revokePdfUrl"].includes(message?.type))return;
  if(message?.type==="frameIdentified") {
    if(identifying && sender.tab?.id===identifying.tabId && message.runId===identifying.runId && typeof message.token==="string" && message.token.startsWith(`${identifying.runId}:`) && message.token.length<200) identified.set(message.token,sender.frameId);
    return;
  }
  if(message?.type==="regionPicked" || message?.type==="cancelPick") {
    (async()=>{
      const {pickState}=await chrome.storage.session.get("pickState");
      if(!pickState || sender.tab?.id!==pickState.tabId || message.token!==pickState.token || !pickState.frameIds.includes(sender.frameId)) return;
      if(message.type==="regionPicked") {
        let target={...message.selection,frameId:sender.frameId};
        if(target.kind==="iframe") {
          const child=new Map(pickState.children).get(`${sender.frameId}:${target.id}`);
          const info=new Map(pickState.frames).get(child);
          if(!info) throw new Error("この埋め込みページにはアクセスできません。");
          target={kind:"document",frameId:child,nonce:info.nonce,label:info.title || target.label};
        }
        if(!["scroll","document"].includes(target.kind) || typeof target.nonce!=="string") throw new Error("選択した領域を確認できません。");
        await agent(pickState.tabId,target.frameId,"measure",{target});
        await chrome.storage.session.set({[`region:${pickState.tabId}`]:{pageUrl:pickState.pageUrl,target}});
      }
      await endPick(pickState);
      if(typeof chrome.action.openPopup==="function") await chrome.action.openPopup().catch(()=>{});
    })().then(()=>respond({ok:true}),async(error)=>{
      await endPick((await chrome.storage.session.get("pickState")).pickState);
      await status(error.message,false,{outcome:"failed"});
      respond({ok:false,error:error.message});
    }); return true;
  }
  if(!sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  control(message).then((result)=>respond({ok:true,...result}),(error)=>respond({ok:false,error:error.message})); return true;
});
async function clearPick(tabId) {const {pickState}=await chrome.storage.session.get("pickState");if(pickState?.tabId===tabId) await endPick(pickState);}
chrome.tabs.onRemoved.addListener((tabId)=>{void chrome.storage.session.remove(`region:${tabId}`);void clearPick(tabId);});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==="loading") void clearPick(tabId);});
chrome.tabs.onActivated.addListener(({tabId,windowId})=>{
  if(current?.windowId===windowId && current.tabId!==tabId) current.interrupted="タブが切り替わったため撮影を中止しました。対象のタブを表示したまま撮影してください。";
});
