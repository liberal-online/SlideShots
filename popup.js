const $=(id)=>document.getElementById(id);
let settings={view:"general",scope:"page",waitMs:1000,verify:false,destination:"downloads",format:"png"};
let tab=null,selection=null,directoryHandle=null,running=false,busy=true;
let saves=Promise.resolve();
let helpOwner=null,helpPinned=false,helpTimer=0;
function hideHelp(force=false){
  if(helpPinned&&!force)return;
  clearTimeout(helpTimer);helpPinned=false;
  if(helpOwner)helpOwner.removeAttribute("aria-describedby");
  helpOwner=null;$("helpTooltip").hidden=true;
}
function placeHelp(){
  if(!helpOwner)return;
  const tooltip=$("helpTooltip"),anchor=helpOwner.getBoundingClientRect();
  const rightEdge=window.innerWidth-8,bottomEdge=Math.min(window.innerHeight,document.body.scrollHeight)-8;
  const left=Math.max(8,Math.min(anchor.left-8,rightEdge-tooltip.offsetWidth));
  let top=anchor.bottom+6;
  if(top+tooltip.offsetHeight>bottomEdge)top=anchor.top-tooltip.offsetHeight-6;
  tooltip.style.left=`${left}px`;tooltip.style.top=`${Math.max(8,top)}px`;
}
function showHelp(button,pin=false){
  if(helpOwner!==button){hideHelp(true);helpOwner=button;}
  const tooltip=$("helpTooltip");tooltip.textContent=button.dataset.help;
  button.setAttribute("aria-describedby","helpTooltip");tooltip.hidden=false;placeHelp();
  if(pin){
    clearTimeout(helpTimer);helpPinned=true;
    helpTimer=setTimeout(()=>{helpPinned=false;if(!button.matches(":hover"))hideHelp(true);},3500);
  }
}
document.querySelectorAll(".info-icon").forEach((button)=>{
  button.addEventListener("mouseenter",()=>showHelp(button));
  button.addEventListener("mouseleave",()=>hideHelp());
  button.addEventListener("focus",()=>showHelp(button));
  button.addEventListener("blur",()=>{if(!button.matches(":hover"))hideHelp();});
  button.addEventListener("click",()=>showHelp(button,true));
  button.addEventListener("keydown",(event)=>{if(event.key==="Escape")hideHelp(true);});
});
document.addEventListener("scroll",()=>{if(helpOwner)helpOwner.getClientRects().length?placeHelp():hideHelp(true);},true);
function notify(text=""){$("notice").textContent=text;$("notice").hidden=!text;}
async function request(message){const reply=await chrome.runtime.sendMessage(message);if(!reply?.ok)throw Error(reply?.error||"拡張機能に接続できません。");return reply;}
function save(){const value={...settings};saves=saves.catch(()=>{}).then(()=>chrome.storage.local.set({captureSettings:value}));return saves;}
function controls(){
  document.querySelectorAll("button,input,select").forEach((element)=>{element.disabled=busy||running;});
  $("generalTab").disabled=busy;$("detailsTab").disabled=busy;
  $("copyLog").disabled=busy;
  document.querySelectorAll(".info-icon").forEach((element)=>{element.disabled=false;});
  $("start").disabled=busy||running||!tab||(settings.scope==="region"&&!selection)||(settings.destination==="folder"&&!directoryHandle);
  $("start").hidden=running;$("stop").hidden=!running;$("stop").disabled=!running;
  $("pickRegion").disabled ||= !tab;
}
function render(){
  const general=settings.view==="general",region=settings.scope==="region";
  $("generalTab").setAttribute("aria-selected",String(general));$("detailsTab").setAttribute("aria-selected",String(!general));
  $("generalTab").tabIndex=general?0:-1;$("detailsTab").tabIndex=general?-1:0;
  $("generalPanel").hidden=!general;$("detailsPanel").hidden=general;
  document.querySelectorAll('[name="scope"]').forEach((input)=>{input.checked=input.value===settings.scope;});
  $("regionPanel").hidden=!region;$("pageHint").hidden=region;
  $("selection").textContent=selection?`${selection.target.kind==="document"?"埋め込みページ":"スクロール領域"}：${selection.target.label}`:"まだ範囲を選んでいません。";
  $("pickRegion").textContent=selection?"ページ上で選び直す ↗":"ページ上で範囲を選ぶ ↗";
  $("frameDocument").hidden=!selection?.target.frameId||selection.target.kind==="document";
  const captureLabel=region?"内部ページを撮影":"ページ全体を撮影";
  $("start").textContent=settings.verify?`${captureLabel}（継ぎ目検証）`:region?"選んだ内部ページを撮影":captureLabel;
  $("waitMs").value=settings.waitMs;
  $("verify").checked=settings.verify;
  document.querySelectorAll('[name="destination"]').forEach((input)=>{input.checked=input.value===settings.destination;});
  $("folderControls").hidden=settings.destination!=="folder";
  $("folderName").textContent=directoryHandle?.name||"未選択";
  $("format").value=settings.format;
  const formatLabel={png:"PNG",jpeg:"JPEG",webp:"WebP",pdf:"PDF"}[settings.format];
  $("saveSummary").textContent=`${formatLabel} · ${settings.destination==="folder"?directoryHandle?`${directoryHandle.name} / 日時` : "フォルダー未選択":"ダウンロード / SlideShots"} に保存`;
  document.querySelectorAll("[data-wait]").forEach((button)=>button.setAttribute("aria-pressed",String(Number(button.dataset.wait)===settings.waitMs)));
  if(helpOwner&&!helpOwner.getClientRects().length)hideHelp(true);
  controls();
}
async function refreshStatus(){const {captureStatus}=await chrome.storage.local.get("captureStatus");running=!!captureStatus?.running;$("status").textContent=captureStatus?.message||"準備完了";controls();}
function change(update){Object.assign(settings,update);notify();render();save().catch((e)=>notify(e.message));}
for(const [id,view] of [["generalTab","general"],["detailsTab","details"]]){
  $(id).addEventListener("click",()=>change({view}));
  $(id).addEventListener("keydown",(event)=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();const next=event.key==="ArrowLeft"||event.key==="Home"?"general":"details";
    change({view:next});$(next==="general"?"generalTab":"detailsTab").focus();
  });
}
document.querySelectorAll('[name="scope"]').forEach((input)=>input.addEventListener("change",()=>change({scope:input.value})));
document.querySelectorAll("[data-wait]").forEach((button)=>button.addEventListener("click",()=>change({waitMs:Number(button.dataset.wait)})));
$("waitMs").addEventListener("change",()=>{
  if(!$("waitMs").value||!$("waitMs").checkValidity()){notify("描画待ちは200〜10,000 msにしてください。");return;}
  change({waitMs:Number($("waitMs").value)});
});
$("verify").addEventListener("change",()=>change({verify:$("verify").checked}));
document.querySelectorAll('[name="destination"]').forEach((input)=>input.addEventListener("change",()=>change({destination:input.value})));
$("format").addEventListener("change",()=>change({format:$("format").value}));
$("chooseFolder").addEventListener("click",async()=>{
  if(typeof window.showDirectoryPicker!=="function"){notify("このブラウザではフォルダーを選べません。");return;}
  busy=true;controls();notify();
  try{
    const handle=await window.showDirectoryPicker({mode:"readwrite",startIn:directoryHandle||"downloads"});
    await directoryStore.set(handle);directoryHandle=handle;change({destination:"folder"});
  }catch(error){if(error.name!=="AbortError")notify(`フォルダーを選べませんでした: ${error.message}`);}
  finally{busy=false;controls();}
});
$("pickRegion").addEventListener("click",async()=>{
  busy=true;controls();notify();
  try{await save();await request({type:"beginPick",tabId:tab.id});window.close();}
  catch(error){notify(error.message);}finally{busy=false;controls();}
});
$("frameDocument").addEventListener("click",async()=>{
  busy=true;controls();try{const reply=await request({type:"useFrameDocument",tabId:tab.id});selection=reply.selection;render();}catch(error){notify(error.message);}finally{busy=false;controls();}
});
  async function begin(){
    busy=true;controls();notify();
    try{
      if(settings.destination==="folder"){
        if(!directoryHandle)throw Error("保存先のフォルダーを選んでください。");
        if(await directoryHandle.requestPermission({mode:"readwrite"})!=="granted")throw Error("保存先フォルダーへの書き込みを許可してください。");
      }
      const waitMs=Number($("waitMs").value);
      if(!$("waitMs").value||!$("waitMs").checkValidity()||!Number.isFinite(waitMs)||waitMs<200||waitMs>10000)throw Error("描画待ちは200〜10,000 msにしてください。");
      settings.waitMs=waitMs;
      const active=await chrome.tabs.get(tab.id);
      if(active.url!==tab.url)throw Error("ページが移動しました。拡張機能を開き直してください。");
      await save();await request({type:"startCapture",tabId:tab.id,options:{scope:settings.scope,target:selection?.target,waitMs,hideFixed:true,verify:settings.verify,destination:settings.destination,format:settings.format}});await refreshStatus();
    }catch(error){notify(error.message);}finally{busy=false;controls();}
  }
  $("start").addEventListener("click",()=>void begin());
$("stop").addEventListener("click",async()=>{try{await request({type:"stopCapture"});$("stop").disabled=true;$("status").textContent="停止して元の位置に戻しています…";}catch(error){notify(error.message);}});
async function refreshLog(){
  const {captureLog}=await chrome.storage.local.get("captureLog");
  const element=$("log");
  element.textContent=captureLog?.length?captureLog.join("\n"):"ログはまだありません。";
  element.scrollTop=element.scrollHeight;
}
$("copyLog").addEventListener("click",async()=>{
  try{await navigator.clipboard.writeText($("log").textContent);notify("ログをコピーしました。");}
  catch(error){notify("コピーできませんでした。ログの文字を選択して手動でコピーしてください。");}
});
$("clearLog").addEventListener("click",async()=>{
  try{await chrome.storage.local.remove("captureLog");await refreshLog();notify();}
  catch(error){notify(error.message);}
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==="local"&&changes.captureStatus)void refreshStatus();
  if(area==="local"&&changes.captureLog)void refreshLog();
  const value=tab&&changes[`region:${tab.id}`]?.newValue;
  if(area==="session"&&value?.pageUrl===tab.url){selection=value;render();}
});
(async()=>{
  try{
    await request({type:"getCaptureState"});
    const {captureSettings}=await chrome.storage.local.get("captureSettings");
    if(captureSettings){
      if(["general","details"].includes(captureSettings.view))settings.view=captureSettings.view;
      if(["page","region"].includes(captureSettings.scope))settings.scope=captureSettings.scope;
      if(Number.isFinite(captureSettings.waitMs)&&captureSettings.waitMs>=200&&captureSettings.waitMs<=10000)settings.waitMs=captureSettings.waitMs;
      if(typeof captureSettings.verify==="boolean")settings.verify=captureSettings.verify;
      if(["downloads","folder"].includes(captureSettings.destination))settings.destination=captureSettings.destination;
      if(["png","jpeg","webp","pdf"].includes(captureSettings.format))settings.format=captureSettings.format;
      await save();
    }
    directoryHandle=await directoryStore.get();
    const [active]=await chrome.tabs.query({active:true,currentWindow:true});
    if(active&&/^(https?:|file:)/.test(active.url||"")){
      tab=active;const key=`region:${tab.id}`;const stored=(await chrome.storage.session.get(key))[key];
      if(stored?.pageUrl===tab.url){
        const reply=await chrome.tabs.sendMessage(tab.id,{channel:"slideshots-agent",op:"measure",target:stored.target},{frameId:stored.target.frameId}).catch(()=>null);
        if(reply?.ok)selection=stored;
      }
    }else notify("撮影する Web ページを開いてください。");
    render();await refreshStatus();await refreshLog();
  }catch(error){notify(error.message);}finally{busy=false;controls();}
})();
