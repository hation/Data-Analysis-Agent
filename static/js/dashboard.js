(function () {
  "use strict";
  const $=id=>document.getElementById(id);
  function showToast(msg,d=2800){const e=$("db-toast");e.textContent=msg;e.classList.add("show");clearTimeout(e._timer);e._timer=setTimeout(()=>e.classList.remove("show"),d);}
  function fmtDate(iso){if(!iso)return"";try{return new Date(iso).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).replace(/\//g,"-");}catch{return iso;}}
  const dashboardId=location.pathname.split("/dashboard/")[1];
  let dashboard=null,grid=null;
  const _urlSid=new URLSearchParams(location.search).get("sid")||"";
  let sessionId=_urlSid||sessionStorage.getItem("baa_session_id")||"",isDirty=false,isRefreshing=false,pendingRefreshResolve=null;
  if(_urlSid)sessionStorage.setItem("baa_session_id",_urlSid);
  window.addEventListener("DOMContentLoaded",async()=>{
    $("btn-back").addEventListener("click",()=>{document.referrer&&!document.referrer.includes("/dashboard/")?history.back():location.href="/";});
    $("btn-refresh").addEventListener("click",handleRefresh);
    $("btn-save-layout").addEventListener("click",handleSaveLayout);
    $("sid-cancel").addEventListener("click",()=>{ $("sid-modal").style.display="none"; pendingRefreshResolve&&(pendingRefreshResolve(null),pendingRefreshResolve=null); });
    $("sid-ok").addEventListener("click",()=>{ const val=$("sid-input").value.trim(); $("sid-modal").style.display="none"; pendingRefreshResolve&&(pendingRefreshResolve(val||null),pendingRefreshResolve=null); });
    await loadDashboard();
  });
  async function loadDashboard(){if(!dashboardId){showEmptyState("未找到看板 ID");return;}let resp;try{resp=await fetch(`/api/dashboard/${dashboardId}`);}catch(e){showEmptyState("网络错误："+e.message);return;}if(!resp.ok){showEmptyState(`看板不存在或已删除 (${resp.status})`);return;}dashboard=await resp.json();
    $("db-name").textContent=dashboard.name||dashboardId;
    document.title=`${dashboard.name||"Dashboard"} — 智析Agent`;
    const meta=[];if(dashboard.created_at)meta.push("创建于 "+fmtDate(dashboard.created_at));if(dashboard.refreshed_at)meta.push("刷新于 "+fmtDate(dashboard.refreshed_at));$("db-meta").textContent=meta.join("  ·  ");
    $("db-title-main").textContent=dashboard.name||dashboardId;
    const subParts=[];if(dashboard.created_at)subParts.push("创建于 "+fmtDate(dashboard.created_at));if(dashboard.refreshed_at)subParts.push("刷新于 "+fmtDate(dashboard.refreshed_at));
    const widgets=dashboard.widgets||[];subParts.push(`${widgets.length} 个图表`);
    $("db-title-sub").textContent=subParts.join("  ·  ");
    $("db-title-bar").style.display="block";
    if(widgets.length===0){$("empty-state").style.display="flex";return;}
    buildGrid(widgets);}

  const _hiddenWidgets=new Map();

  function buildGrid(widgets){
    const wrap=$("db-grid-wrap");wrap.style.display="block";
    const gridEl=$("grid");

    // Use fixed cell height so layout is predictable with scrolling
    const cellH=120;
    const margin=10;

    grid=GridStack.init({column:12,cellHeight:cellH,margin:margin,animate:true,float:true},gridEl);
    const items=widgets.map(w=>({id:w.id,x:w.grid?.x??0,y:w.grid?.y??0,w:w.grid?.w??6,h:w.grid?.h??4,content:buildWidgetHTML(w)}));
    grid.load(items);widgets.forEach(w=>loadWidgetChart(w));
    grid.on("dragstop resizestop",()=>setDirty(true));
    requestAnimationFrame(resizeWidgetCharts);
  }

  function buildWidgetHTML(w){
    const chartTypeBadge=(w.chart_type||"").replace(/_/g," ");
    const hideTitle=w._hidden?"显示图表":"隐藏图表";
    return `<div class="grid-stack-item-content${w._hidden?" widget-hidden":""}" data-widget-id="${esc(w.id)}">
      <div class="widget-header">
        <span class="widget-title">${esc(w.title||"图表")}</span>
        <span class="widget-badge">${esc(chartTypeBadge)}</span>
        <div class="widget-actions">
          <button class="widget-btn widget-btn-hide" title="${hideTitle}" onclick="toggleHideWidget('${esc(w.id)}')">${w._hidden?"👁️":"🙈"}</button>
          <button class="widget-btn widget-btn-expand" title="全屏查看" onclick="expandWidget('${esc(w.id)}','${esc(w.title||"图表")}','${esc(w.chart_id||"")}')" ${w.chart_id?"":"disabled"}>⛶</button>
        </div>
      </div>
      <div class="widget-body" id="wb-${esc(w.id)}">${w.error?buildErrorHTML(w.error):buildLoadingHTML()}</div>
    </div>`;}

  function buildLoadingHTML(){return `<div class="widget-loading"><span class="spin">↻</span> 加载中…</div>`;}
  function buildErrorHTML(msg){return `<div class="widget-error"><div class="widget-error-icon">⚠️</div><div class="widget-error-msg">${esc(msg)}</div></div>`;}
  function buildIframeHTML(chartId){return `<iframe class="widget-iframe" src="/api/chart/${esc(chartId)}" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>`;}
  function loadWidgetChart(w){const body=$(`wb-${w.id}`);if(!body)return;if(w.error)return;if(!w.chart_id){body.innerHTML=buildErrorHTML("图表尚未生成");return;}body.innerHTML=buildIframeHTML(w.chart_id);}
  function showEmptyState(msg){const el=$("empty-state");msg&&(el.querySelector(".db-empty-title").textContent=msg);el.style.display="flex";}
  function setDirty(val){isDirty=val;const btn=$("btn-save-layout");btn.disabled=!val;if(val){btn.classList.add("dirty");btn.textContent="💾 保存布局";}else{btn.classList.remove("dirty");btn.textContent="💾 已保存";setTimeout(()=>{btn.textContent="💾 保存布局";},1800);}}

  // ── Hide / show widget ──────────────────────────────────────────
  window.toggleHideWidget=function(widgetId){
    const w=dashboard?.widgets?.find(x=>x.id===widgetId);
    if(!w||!grid)return;
    const el=document.querySelector(`.grid-stack-item[gs-id="${widgetId}"]`);
    if(!el)return;

    if(!_hiddenWidgets.has(widgetId)){
      // Hide: save grid node position then remove from grid (frees space)
      const node=el.gridstackNode;
      _hiddenWidgets.set(widgetId,{x:node.x,y:node.y,w:node.w,h:node.h,el});
      grid.removeWidget(el,false);
      el.style.display="none";
      w._hidden=true;
      setDirty(true);
      // update button in the detached element
      const btn=el.querySelector(".widget-btn-hide");
      if(btn){btn.textContent="👁️";btn.title="显示图表";}
    } else {
      // Show: re-add to grid at saved position
      const saved=_hiddenWidgets.get(widgetId);
      el.style.display="";
      grid.addWidget(el,{x:saved.x,y:saved.y,w:saved.w,h:saved.h,id:widgetId});
      _hiddenWidgets.delete(widgetId);
      w._hidden=false;
      setDirty(true);
      const btn=el.querySelector(".widget-btn-hide");
      if(btn){btn.textContent="🙈";btn.title="隐藏图表";}
    }
  };

  // ── Fullscreen expand ──────────────────────────────────────────
  window.expandWidget=function(widgetId,title,chartId){
    if(!chartId)return;
    let fs=$("db-fullscreen");
    if(!fs){
      fs=document.createElement("div");
      fs.id="db-fullscreen";
      fs.className="db-fullscreen";
      fs.innerHTML=`<div class="db-fullscreen-header"><span class="db-fullscreen-title" id="fs-title"></span><button class="btn-fs-close" id="fs-close" title="关闭全屏">✕</button></div><div class="db-fullscreen-body" id="fs-body"></div>`;
      document.body.appendChild(fs);
      document.getElementById("fs-close").addEventListener("click",closeFullscreen);
      document.addEventListener("keydown",e=>{if(e.key==="Escape")closeFullscreen();});
    }
    document.getElementById("fs-title").textContent=title;
    document.getElementById("fs-body").innerHTML=`<iframe src="/api/chart/${esc(chartId)}" sandbox="allow-scripts allow-same-origin"></iframe>`;
    fs.style.display="flex";
    document.body.style.overflow="hidden";
  };

  function closeFullscreen(){
    const fs=$("db-fullscreen");
    if(fs){fs.style.display="none";document.getElementById("fs-body").innerHTML="";}
    document.body.style.overflow="";
  }

  async function handleSaveLayout(){if(!grid||!dashboard)return;const items=grid.getGridItems().map(el=>{const node=el.gridstackNode;return{id:el.querySelector("[data-widget-id]")?.dataset?.widgetId||"",grid:{x:node.x,y:node.y,w:node.w,h:node.h}}});const containerW=$("grid").parentElement.getBoundingClientRect().width;try{const resp=await fetch(`/api/dashboard/${dashboardId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({widgets:items,container_width:containerW})});if(!resp.ok)throw new Error(resp.statusText);setDirty(false);showToast("布局已保存 ✓");}catch(e){showToast("保存失败："+e.message);}}
  async function handleRefresh(){if(isRefreshing)return;let sid=sessionId;if(!sid){sid=await promptSessionId();if(!sid)return;sessionId=sid;sessionStorage.setItem("baa_session_id",sid);}setRefreshingUI(true);try{const resp=await fetch(`/api/dashboard/${dashboardId}/refresh`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session_id:sid})});const data=await resp.json();if(!resp.ok){if(resp.status===404||resp.status===400){showToast((data.error||"Session 无效")+" — 请重新输入 Session ID");sessionId="";sessionStorage.removeItem("baa_session_id");}else showToast("刷新失败："+(data.error||resp.statusText));return;}const resultMap={};for(const w of(data.widgets||[]))resultMap[w.id]=w;for(const w of(dashboard.widgets||[])){const body=$(`wb-${w.id}`);if(!body)continue;const res=resultMap[w.id];if(!res)continue;if(res.error){body.innerHTML=buildErrorHTML(res.error);}else if(res.chart_id){body.innerHTML=buildIframeHTML(res.chart_id);w.chart_id=res.chart_id;const expandBtn=document.querySelector(`[data-widget-id="${CSS.escape(w.id)}"] .widget-btn-expand`);if(expandBtn){expandBtn.disabled=false;expandBtn.setAttribute("onclick",`expandWidget('${esc(w.id)}','${esc(w.title||"")}','${esc(res.chart_id)}')`);}w.error=res.error||null;}w.error=res.error||null;}const now=new Date().toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).replace(/\//g,"-");const meta=[];if(dashboard.created_at)meta.push("创建于 "+fmtDate(dashboard.created_at));meta.push("刷新于 "+now);$("db-meta").textContent=meta.join("  ·  ");const errors=(data.widgets||[]).filter(w=>w.error).length;if(errors>0){showToast(`刷新完成，${errors} 个图表出错`);}else{showToast("数据已刷新 ✓");}}catch(e){showToast("网络错误："+e.message);}finally{setRefreshingUI(false);}}
  function setRefreshingUI(on){isRefreshing=on;const btn=$("btn-refresh"),icon=$("refresh-icon");btn.disabled=on;if(on){icon.className="spin";icon.textContent="↻";}else{icon.className="";icon.textContent="↻";}}
  function promptSessionId(){return new Promise(resolve=>{pendingRefreshResolve=resolve;$("sid-input").value="";$("sid-modal").style.display="flex";$("sid-input").focus();$("sid-input").onkeydown=e=>{if(e.key==="Enter")$("sid-ok").click();};});}
  function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
  function resizeWidgetCharts(){document.querySelectorAll('.grid-stack-item').forEach(item=>{const body=item.querySelector('.widget-body');if(!body)return;const iframe=body.querySelector('iframe');if(iframe){iframe.style.width='100%';iframe.style.height='100%';}});}
  grid?.on('change resized dragstop added',()=>{requestAnimationFrame(resizeWidgetCharts);});
  window.addEventListener('resize',()=>{requestAnimationFrame(resizeWidgetCharts);});
})();
