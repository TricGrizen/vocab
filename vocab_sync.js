/* ============================================================================
   灯下 · 云档同步核心 sync_core.js（星槎 2026.7，PROGRESS AI 节）
   ----------------------------------------------------------------------------
   正本在 tools/app/sync_core.js；三壳（game/universe/math）各嵌一份完全相同的
   拷贝（KY-SYNC-BEGIN/END 标记内，由 tools/app/inject_shells.py 注入与更新，
   build_app.py 校验三份与正本不漂移）。改这里 → 重跑 inject_shells.py。

   设计（PROGRESS AI 定案③）：
   · 后端 = GitHub 私仓（默认 TricGrizen/ky-sync）Contents API，一店一文件
     s/<localStorage键>.json，信封 {v,t,dev,data}。
   · 合并 = 逐条目取新/并集/取早（按店各配），绝不整档互斥覆盖；
     starred 走三方合并（shadow 基线）支持摘星不复活；PUT 带 sha 乐观锁。
   · fail-closed：无 token / 无网 / 接口错 = 静默跳过，纯本地行为分毫不变。
     铁律8复核：浏览器侧出网物理过 TUN/系统代理，页面 JS 无绕行面。
   · SIM/selftest/MEMONLY/SEEDED/coop-join 由壳适配器 blocked() 一票禁同步。
   ============================================================================ */
window.KySync=(function(){
"use strict";
var CFG_KEY="ky_sync_cfg", SHADOW_PRE="ky_sshadow_", API="https://api.github.com";
var DEF_REPO="TricGrizen/ky-sync";

/* ---------------- 小工具 ---------------- */
function nkeys(o){return o?Object.keys(o).length:0;}
function stab(x){ /* 键序无关的稳定序列化（只用于比较，不用于上载） */
  if(x===null||typeof x!=="object")return JSON.stringify(x);
  if(Array.isArray(x))return "["+x.map(stab).join(",")+"]";
  var ks=Object.keys(x).sort(),i,s="{";
  for(i=0;i<ks.length;i++){if(i)s+=",";s+=JSON.stringify(ks[i])+":"+stab(x[ks[i]]);}
  return s+"}";
}
function clone(x){return x==null?x:JSON.parse(JSON.stringify(x));}
function badKey(o,k){return !Object.prototype.hasOwnProperty.call(o,k)||k==="__proto__"||k==="constructor";} /* 原型污染守卫（E7）：非自有键/__proto__/constructor 一律跳过 */
function b64e(s){return btoa(unescape(encodeURIComponent(s)));}
function b64d(b){return decodeURIComponent(escape(atob(String(b).replace(/\s/g,""))));}
function uniqPrim(a){var s={},o=[],i;for(i=0;i<a.length;i++){var k=typeof a[i]+"·"+a[i];if(!s[k]){s[k]=1;o.push(a[i]);}}return o;}
function uniqJson(a){var s={},o=[],i;for(i=0;i<a.length;i++){var k=stab(a[i]);if(!s[k]){s[k]=1;o.push(a[i]);}}return o;}
function mArr(l,r,capN){ /* 追加型日志并集：内容去重 → 按 t 升序（平票按 stab 字典序定序，防两端乒乓 E8）→ 截尾限额 */
  var m=uniqJson((l||[]).concat(r||[]));
  m.sort(function(a,b){var d=(a&&a.t||0)-(b&&b.t||0);if(d)return d;
    var sa=stab(a),sb=stab(b);return sa<sb?-1:sa>sb?1:0;});
  return (capN&&m.length>capN)?m.slice(m.length-capN):m;
}
function minDate(a,b){if(a==null)return b;if(b==null)return a;return String(a)<=String(b)?a:b;}
function pick(l,r,tl,tr){ /* 决定性择新：时间→内容字典序（防两端平票互推打乒乓） */
  if(tl>tr)return l; if(tr>tl)return r;
  return stab(l)<=stab(r)?l:r;
}

/* ---------------- 合并律（一店一函数；PROGRESS AI ③） ---------------- */
function m408(l,r,ctx){
  var lt=l.t||0, rt=r.t||0;
  var nw=pick(l,r,lt,rt), od=(nw===l)?r:l;
  var o={}; Object.keys(od).forEach(function(k){o[k]=od[k];});
  Object.keys(nw).forEach(function(k){o[k]=nw[k];});           /* 未列举字段：新档胜（前向兼容） */
  o=clone(o); o.v=1; o.t=Math.max(lt,rt);
  o.firstDay=minDate(l.firstDay,r.firstDay)||o.firstDay;
  o.done={}; o.seen={};
  [l,r].forEach(function(s){var m=s.done||{},k;for(k in m){if(badKey(m,k))continue;o.done[k]=minDate(o.done[k],m[k]);}});   /* 首过取早 */
  [l,r].forEach(function(s){var m=s.seen||{},k;for(k in m){if(badKey(m,k))continue;o.seen[k]=minDate(o.seen[k],m[k]);}});   /* 首见取早 */
  /* starred 三方合并（base=上次同步基线）：摘星是真删除，不靠并集复活 */
  var base=(ctx&&ctx.base&&ctx.base.starred)||null;
  if(base){
    var B={},L={},R={},i;
    base.forEach(function(q){B[q]=1;});(l.starred||[]).forEach(function(q){L[q]=1;});(r.starred||[]).forEach(function(q){R[q]=1;});
    var keep=[];
    uniqPrim(base.concat(l.starred||[],r.starred||[])).forEach(function(q){
      var inB=B[q],inL=L[q],inR=R[q];
      if(inB){ if(inL&&inR)keep.push(q); /* 双方仍在=留；任一方删=删 */ }
      else if(inL||inR)keep.push(q);     /* 任一方新增=加 */
    });
    o.starred=keep.sort();
  }else o.starred=uniqPrim((l.starred||[]).concat(r.starred||[])).sort();
  /* 集合一律排序：合并结果与参数顺序无关（决定性，防两端互推乒乓） */
  o.wrongs=uniqPrim((l.wrongs||[]).concat(r.wrongs||[])).sort();  /* ✗ 历史：只进不出 */
  o.heat={};
  [l,r].forEach(function(s){var m=s.heat||{},d;for(d in m){if(badKey(m,d))continue;var e=o.heat[d]=o.heat[d]||{k:0,q:0};
    e.k=Math.max(e.k,m[d]&&m[d].k||0); e.q=Math.max(e.q,m[d]&&m[d].q||0);}});
  o.time={subj:{},ch:{}};
  [l,r].forEach(function(s){var tm=s.time||{};["subj","ch"].forEach(function(g){var m=tm[g]||{},k;
    for(k in m){if(badKey(m,k))continue;o.time[g][k]=Math.max(o.time[g][k]||0,m[k]||0);}});});
  o.exam={};                                                    /* 逐卷：进度多者（字节数）胜 */
  (function(){var k,a=l.exam||{},b=r.exam||{},all={},x;
    for(k in a){if(badKey(a,k))continue;all[k]=1;}for(k in b){if(badKey(b,k))continue;all[k]=1;}
    for(k in all){if(badKey(all,k))continue;var va=a[k],vb=b[k];
      if(va==null)x=vb; else if(vb==null)x=va;
      else{var la=stab(va).length,lb=stab(vb).length;
        x=(la>lb)?va:(lb>la)?vb:pick(va,vb,lt,rt);}
      o.exam[k]=x;}})();
  o.tray=[];o.trayT={};o.pendingQ=[];                           /* loadState 本就清空的瞬态 */
  return o;
}
function wuCaseT(S,id){var c=(S.cases||{})[id],L=(S.laws||{})[id];
  var t=(L&&L.ts)||0;
  if(c&&c.hits&&c.hits.length)t=Math.max(t,c.hits[c.hits.length-1].t||0);
  if(!t&&c&&(c.seen||c.dis))t=1;
  return t;}
function mWugeng(l,r){
  var o={cases:{},laws:{},meta:{}},ids={},id;
  [l.cases,r.cases,l.laws,r.laws].forEach(function(m){var mm=m||{};for(var k in mm){if(badKey(mm,k))continue;ids[k]=1;}});
  for(id in ids){if(badKey(ids,id))continue;
    var tl=wuCaseT(l,id),tr=wuCaseT(r,id),w,lo;
    if(tl!==tr)w=(tl>tr)?l:r;
    else{ /* 平票走内容字典序（决定性，防两端互推乒乓） */
      var cw=stab([(l.cases||{})[id],(l.laws||{})[id]]),cr=stab([(r.cases||{})[id],(r.laws||{})[id]]);
      w=(cw<=cr)?l:r;
    }
    lo=(w===l)?r:l;
    if((w.cases||{})[id])o.cases[id]=clone(w.cases[id]);
    if((w.laws||{})[id])o.laws[id]=clone(w.laws[id]);
    if(!o.cases[id]&&(lo.cases||{})[id])o.cases[id]=clone(lo.cases[id]);
    if(!o.laws[id]&&(lo.laws||{})[id])o.laws[id]=clone(lo.laws[id]);
  }
  var lm=l.meta||{},rm=r.meta||{};
  var nm=pick(lm,rm,lm.last||0,rm.last||0),om=(nm===lm)?rm:lm;
  Object.keys(om).forEach(function(k){o.meta[k]=om[k];});
  Object.keys(nm).forEach(function(k){o.meta[k]=nm[k];});
  o.meta=clone(o.meta);
  o.meta.last=Math.max(lm.last||0,rm.last||0);
  ["dawn","rest","ob"].forEach(function(k){o.meta[k]=Math.max(lm[k]||0,rm[k]||0);});
  (function(){var che={},k,a=lm.che||{},b=rm.che||{};
    for(k in a){if(badKey(a,k))continue;che[k]=a[k];} for(k in b){if(badKey(b,k))continue;che[k]=(typeof b[k]==="number"&&typeof che[k]==="number")?Math.max(che[k],b[k]):(k in che?(nm===rm?b[k]:che[k]):b[k]);}
    o.meta.che=che;})();
  return o;
}
function mT(x){return (typeof x==="number"&&isFinite(x))?x:0;}
function hitsT(c){var t=0;((c&&c.hits)||[]).forEach(function(h){if(h&&mT(h.t)>t)t=mT(h.t);});
  return t||((c&&(c.seen||c.due))?1:0);}
function mathCaseT(S,id){ /* v2：末次活动=判题/阅读/微测/真题四者最晚（纯阅读也算活动，治平票字典序回滚拍位·R2） */
  var c=(S.cases||{})[id];if(!c)return 0;
  var t=hitsT(c),k;
  if(c.pos&&mT(c.pos.ts)>t)t=mT(c.pos.ts);
  var m=c.mc||{};for(k in m){if(badKey(m,k))continue;if(m[k]&&mT(m[k].t)>t)t=mT(m[k].t);}
  var d=c.dr||{};for(k in d){if(badKey(d,k))continue;if(d[k]&&mT(d[k].t)>t)t=mT(d[k].t);}
  return t;
}
function mTMap(a,b,early){ /* 微测/真题档逐键合并（R3）：双方都有按 t 对决（early=取早，否则取新）；平票 stab 定序防乒乓 */
  var o={},k;a=a||{};b=b||{};
  for(k in a){if(badKey(a,k))continue;o[k]=clone(a[k]);}
  for(k in b){if(badKey(b,k))continue;
    if(!(k in o)){o[k]=clone(b[k]);continue;}
    var x=o[k],y=b[k],tx=mT(x&&x.t),ty=mT(y&&y.t);
    if(tx!==ty)o[k]=clone(early?((tx<ty)?x:y):((tx>ty)?x:y));
    else o[k]=clone((stab(x)<=stab(y))?x:y);
  }
  return o;
}
function mPos(a,b){ /* 拍位锚按 ts 取新（R2）：阅读进度不回滚 */
  if(a==null)return b==null?null:clone(b); if(b==null)return clone(a);
  var ta=mT(a&&a.ts),tb=mT(b&&b.ts);
  if(ta>tb)return clone(a); if(tb>ta)return clone(b);
  return clone((stab(a)<=stab(b))?a:b);
}
function mLastk(a,b){ /* 应用级续学指针单键取新（R1）：{k:"",ts}=清空墓碑（壳侧 AU 起），旧 null 视 ts=0 */
  var ta=(a&&typeof a==="object")?mT(a.ts):0, tb=(b&&typeof b==="object")?mT(b.ts):0;
  if(ta>tb)return clone(a); if(tb>ta)return clone(b);
  var sa=stab(a==null?null:a),sb=stab(b==null?null:b);
  return clone((sa<=sb)?a:b);
}
function mMath(l,r){
  var o={cases:{},meta:{}},ids={},id;
  [l.cases,r.cases].forEach(function(m){var mm=m||{};for(var k in mm){if(badKey(mm,k))continue;ids[k]=1;}});
  for(id in ids){if(badKey(ids,id))continue;
    var a=(l.cases||{})[id],b=(r.cases||{})[id];
    if(!a){o.cases[id]=clone(b);continue;} if(!b){o.cases[id]=clone(a);continue;}
    /* 骨架（star 与未来新增字段前向兼容）＝末次活动新方；调度标量（due,g,seen）＝判题新方（阅读不回滚复习梯） */
    var w=pick(a,b,mathCaseT(l,id),mathCaseT(r,id));
    var c=clone(w);
    var hw=pick(a,b,hitsT(a),hitsT(b));
    c.due=hw.due; c.g=hw.g; c.seen=hw.seen;
    c.star=!!(w.star);
    c.hits=mArr(a.hits,b.hits,120);       /* 战绩流水并集（去重定序），封顶护信封（并集后必须 cap，防 1MB 界） */
    c.mc=mTMap(a.mc,b.mc,false);          /* 微测：复习覆盖语义＝取新 */
    c.rmc=mTMap(a.rmc,b.rmc,false);       /* 回看战绩（P3）：同律取新——双端重学互认，切设备不清零 */
    c.dr=mTMap(a.dr,b.dr,true);           /* 真题：一击定案做过不重判＝取早 */
    c.pos=mPos(a.pos,b.pos);
    o.cases[id]=c;
  }
  var lm=l.meta||{},rm=r.meta||{};
  var nm=pick(lm,rm,lm.last||0,rm.last||0),om=(nm===lm)?rm:lm;
  Object.keys(om).forEach(function(k){o.meta[k]=om[k];});
  Object.keys(nm).forEach(function(k){o.meta[k]=nm[k];});
  o.meta=clone(o.meta);
  o.meta.lastk=mLastk(lm.lastk,rm.lastk);
  o.meta.last=Math.max(lm.last||0,rm.last||0); o.meta.ver=1;
  return o;
}
function mWB(l,r){var o={},ids={},k;
  [l,r].forEach(function(m){var mm=m||{};for(var x in mm){if(badKey(mm,x))continue;ids[x]=1;}});
  for(k in ids){if(badKey(ids,k))continue;o[k]=mArr((l||{})[k],(r||{})[k]);}
  return o;}

/* 店册：键 → {merge, virgin, sig(比较签名·剔除易变字段), shadowPick(三方基线)} */

/* —— 铸影店合并律（build_vocab.py 注入自家拷贝；正本登记待 P4 串行） —— */
function mVocab(l,r){
  if(!l)return r; if(!r)return l;
  function mv(V,k,x){if(!x)return;var c=V[k];
    if(!c){V[k]=[x[0],x[1]];return;}
    c[0]=Math.min(c[0],x[0]);c[1]=Math.max(c[1],x[1]);}
  function act(e){var m=0;if(!e)return 0;var k;
    (e.t||[]).forEach(function(x){if(x&&x[0]>m)m=x[0];});
    for(k in e.v||{}){var v=e.v[k];if(v&&v[0]>m)m=v[0];}
    (e.lf||[]).forEach(function(d2){if(d2>m)m=d2;});
    return m*100000+(e.n||0);}
  var o=clone(l),sec,i;
  var secs=["w","f","p"];
  for(i=0;i<secs.length;i++){sec=secs[i];o[sec]=o[sec]||{};var R2=r[sec]||{};
    Object.keys(R2).forEach(function(k){if(badKey(R2,k))return;
      var a=o[sec][k],b=R2[k];
      if(!a){o[sec][k]=clone(b);return;}
      var w2=act(b)>act(a)?clone(b):clone(a);
      if(sec==="w"){var va=a.v||{},vb=b.v||{},k2;w2.v=w2.v||{};
        for(k2 in va){if(!badKey(va,k2))mv(w2.v,k2,va[k2]);}
        for(k2 in vb){if(!badKey(vb,k2))mv(w2.v,k2,vb[k2]);}}
      o[sec][k]=w2;});}
  var lt2=l.tri||{},rt2=r.tri||{};
  o.tri={cur:Math.max(lt2.cur||0,rt2.cur||0),
         pr:(((rt2.cur||0)>(lt2.cur||0)?rt2.pr:lt2.pr)||[0,0,0,0,0])};
  var lm=l.meta||{},rm=r.meta||{};
  o.meta=clone((rm.last||0)>(lm.last||0)?rm:lm);
  o.meta.last=Math.max(lm.last||0,rm.last||0);
  return o;
}
var STORES={
  "ky_vocab_v1":{
    merge:mVocab,
    virgin:function(s){return !s||!nkeys(s.w);},
    sig:function(s){if(s==null)return "null";var c=clone(s);
      if(c.meta){delete c.meta.last;delete c.meta.day;}return stab(c);}
  },

  "ky408_v1":{
    merge:m408,
    virgin:function(s){return !s||(!nkeys(s.done)&&!nkeys(s.seen)&&!nkeys(s.heat)&&!nkeys(s.time&&s.time.subj));},
    sig:function(s){if(s==null)return "null";var c=clone(s);delete c.t;c.tray=[];c.trayT={};c.pendingQ=[];delete c.cur;return stab(c);},
    shadowPick:function(s){return {starred:(s&&s.starred||[]).slice()};}
  },
  "ky_wugeng_v5":{
    merge:mWugeng,
    virgin:function(s){return !s||(!nkeys(s.cases)&&!nkeys(s.laws));},
    sig:function(s){if(s==null)return "null";var c=clone(s);if(c.meta)delete c.meta.last;return stab(c);}
  },
  "ky_mislog_v1":{merge:function(l,r){return mArr(l,r,400);},virgin:function(a){return !a||!a.length;},sig:stab},
  "ky_gleans_v1":{merge:function(l,r){return mArr(l,r,200);},virgin:function(a){return !a||!a.length;},sig:stab},
  "ky_math_v1":{
    merge:mMath,
    virgin:function(s){return !s||!nkeys(s.cases);},
    sig:function(s){if(s==null)return "null";var c=clone(s);if(c.meta)delete c.meta.last;return stab(c);}
  },
  "ky_math_wrong_v1":{merge:mWB,virgin:function(o){return !o||!nkeys(o);},sig:stab}
};

/* ---------------- 配置 ---------------- */
var cfg=null;
function loadCfg(){try{cfg=JSON.parse(localStorage.getItem(CFG_KEY)||"null");}catch(e){cfg=null;}
  if(!cfg||typeof cfg!=="object")cfg=null; return cfg;}
function saveCfg(c){cfg=c;try{localStorage.setItem(CFG_KEY,JSON.stringify(c));}catch(e){}}
function enabled(){return !!(cfg&&cfg.on&&cfg.tok&&cfg.repo);}
function seedCfg(){ /* W3b：壁纸/PWA 免键盘 token 种子——空档（无 cfg 或 tok 空）时采纳本机 window.__KY_SYNC_CFG（sync_cfg.js 桩），只在空档生效一次，⇅ 面板后续修改照常覆写 */
  try{
    loadCfg();
    if(cfg&&cfg.tok)return;                       /* 已有 token：种子不介入 */
    var s=window.__KY_SYNC_CFG;
    if(!s||typeof s!=="object"||!s.tok)return;
    saveCfg({tok:String(s.tok).trim(),
             dev:(s.dev?String(s.dev).trim():"")||"设备",
             repo:(s.repo?String(s.repo).trim():"")||DEF_REPO,
             branch:s.branch||"main",
             on:s.on!==false});                   /* 缺省开启；显式 on:false（如自测防外呼）则存而不自动同步 */
  }catch(e){}
}

/* ---------------- GitHub Contents 传输 ---------------- */
function gh(method,path,body){
  var h={"Authorization":"Bearer "+cfg.tok,"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
  var o={method:method,headers:h};
  if(body){h["Content-Type"]="application/json";o.body=JSON.stringify(body);}
  try{if(window.AbortSignal&&AbortSignal.timeout)o.signal=AbortSignal.timeout(20000);}catch(e){}
  return fetch(API+path,o).then(function(r){
    if(r.status===404)return {s:404,j:null};
    return r.json().catch(function(){return null;}).then(function(j){return {s:r.status,j:j};});
  });
}
/* —— 云仓探针（build_vocab.py 注入自家拷贝；修缮二 A） —— */
var probeP=null;                                                  /* 本轮缓存：每次 syncNow 至多探一次 */
function repoProbe(){
  if(probeP)return probeP;
  probeP=gh("GET","/repos/"+cfg.repo).then(function(r){
    if(r.s===200)return true;                                     /* 仓可见 = 真空档，照旧行为 */
    if(r.s===401)throw new Error("token 无效或过期（⇅ 重贴）");
    if(r.s===404||r.s===403)throw new Error("云仓不可见：token 失效或仓名不对（⇅ 重贴）");
    throw new Error("云仓探针 HTTP "+r.s);
  });
  return probeP;
}
function _io(fakeCfg,op,key,env,st){ /* 壳 selftest ⑱ 专用离线通道：注入 cfg 走一趟 pull/push/syncStore
                                     （不碰 A / busy；op==="sync" 只动调用方传入的内存店 st，不碰真存档；
                                      调用方 stub window.fetch，零真实出网） */
  var bak=cfg;cfg=fakeCfg;probeP=null;
  function back(){cfg=bak;probeP=null;}
  var p=(op==="sync")?syncStore(st,env||null)
       :(op==="push")?push(key,env||{v:1,t:0,dev:"selftest",gen:0,data:{}},null)
       :pull(key);
  return p.then(function(r){back();return r;},function(e){back();throw e;});
}
function fpath(key){return "/repos/"+cfg.repo+"/contents/s/"+encodeURIComponent(key)+".json";}
function pull(key){
  return gh("GET",fpath(key)+"?ref="+(cfg.branch||"main")).then(function(r){
    if(r.s===404)return repoProbe().then(function(){return {sha:null,env:null};});  /* 404 二义：探仓可见性，仓在=真空档（修缮二 A） */
    if(r.s!==200||!r.j)throw new Error("拉取失败 HTTP "+r.s);
    if(r.j.content==null)throw new Error("店文件不可解(疑>1MB)");  /* >1MB 时 GitHub 返 200 但 content=null；fail-closed 报错不当空档（E6） */
    var env;try{env=JSON.parse(b64d(r.j.content));}catch(e){throw new Error("店文件不可解(疑>1MB)");}
    return {sha:r.j.sha,env:env};
  });
}
function push(key,env,sha){
  var content=b64e(JSON.stringify(env));
  if(content.length>950000)nearLimit=true;                      /* 近 GitHub Contents 1MB 上限：照推，syncNow 末尾提示（E6） */
  var body={message:"sync "+key+" @"+(cfg.dev||"dev"),content:content,branch:cfg.branch||"main"};
  if(sha)body.sha=sha;
  return gh("PUT",fpath(key),body).then(function(r){
    if(r.s===200||r.s===201)return true;
    if(r.s===409||r.s===422)return "conflict";
    if(r.s===404)throw new Error("上推失败 HTTP 404（token 无写权或已失效——⇅ 重贴）");
    throw new Error("上推失败 HTTP "+r.s);
  });
}

/* ---------------- 同步引擎 ---------------- */
var A=null, busy=false, lastOkT=0, lastMsg="未配置", savedT=0, pollT=0, nearLimit=false;
var SGEN_PRE="ky_sgen_";                                          /* 代际 gen 键前缀（E2）：每店本地记已见代号，缺省 0 */
/* —— 翻代保险柜（build_vocab.py 注入自家拷贝；修缮三） ——
   代际权威(genAuth)是整档直采云端、跳过合并律：云端若是「置空档 + 高代」而本机有真进度，
   旧行为即无声抹平（用户手机 token 装错 + 云端置空的实况）。此处在采纳之前把本机真档单槽存底
   （每店一槽，下次翻代才覆写），⇅ 面板可一键取回。纯本地 localStorage，无出网、不改同步语义。 */
var VAULT_PRE="ky_svault_";
function vaultPut(key,gen,data){
  try{localStorage.setItem(VAULT_PRE+key,JSON.stringify({t:Date.now(),gen:gen,data:data}));}catch(e){}
}
function vaultFind(){                                             /* 取最近一槽（多店按存入时刻择新） */
  var best=null;
  try{
    for(var i=0;i<localStorage.length;i++){
      var k=localStorage.key(i);
      if(!k||k.indexOf(VAULT_PRE)!==0)continue;
      var v=null;try{v=JSON.parse(localStorage.getItem(k)||"null");}catch(e2){v=null;}
      if(!v||typeof v!=="object"||v.data===undefined||v.data===null)continue;
      v.key=k.slice(VAULT_PRE.length);
      if(!best||(v.t||0)>(best.t||0))best=v;
    }
  }catch(e){}
  return best;
}
function vaultLabel(v){
  var d=new Date(v.t||0);
  return "找回翻代前档（"+v.key+" · "+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2)
        +" "+hhmm(v.t||0)+"）";
}
function sgenGet(key){var v=parseFloat(localStorage.getItem(SGEN_PRE+key));return isFinite(v)?v:0;}
function sgenSet(key,v){try{localStorage.setItem(SGEN_PRE+key,String(v));}catch(e){}}
function setMsg(m){lastMsg=m;renderStatus();}
function hhmm(t){var d=new Date(t);return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);}
function shadowGet(key){try{return JSON.parse(localStorage.getItem(SHADOW_PRE+key)||"null");}catch(e){return null;}}
function shadowSet(key,v){try{localStorage.setItem(SHADOW_PRE+key,JSON.stringify(v));}catch(e){}}

function syncStore(st,force){ /* force="pushAll"|"pullAll"|null */
  var lib=STORES[st.key]; if(!lib)return Promise.resolve({key:st.key,what:"unknown"});
  return pull(st.key).then(function(p){
    var remote=(p.env&&p.env.data!==undefined)?p.env.data:null;
    var remoteGen=(p.env&&typeof p.env.gen==="number")?p.env.gen:0;  /* 代际（E2）：reset/推平抬 gen，云端代新即权威、跳过合并律 */
    var localGen=sgenGet(st.key);
    var local=st.get();
    var merged, what="same", envGen=localGen, genAuth=false;
    if(force==="pushAll"){merged=local;envGen=Date.now();}            /* 推平：本机为准、开新代 */
    else if(force==="pullAll"){merged=(remote!=null)?remote:local;envGen=Math.max(localGen,remoteGen);}
    else if(local==null&&remote==null)return {key:st.key,what:"empty"};
    else if(local==null){merged=remote;envGen=Math.max(localGen,remoteGen);}
    else if(remote==null){merged=local;envGen=localGen;}             /* 404/首推：沿用本地代（E2-c） */
    else if(remoteGen>localGen){                                     /* 云端代际权威：直采云端、跳过合并（E2-b） */
      if(local!=null&&!lib.virgin(local))vaultPut(st.key,localGen,local);  /* 翻代保险柜：本机真档将被整档覆盖，先存底（修缮三） */
      merged=remote;genAuth=true;envGen=remoteGen;}
    else{merged=lib.merge(local,remote,{base:shadowGet(st.key)});envGen=Math.max(localGen,remoteGen);}
    if(merged==null)return {key:st.key,what:"empty"};
    var sigM=lib.sig(merged);
    if(local==null||sigM!==lib.sig(local)){st.set(clone(merged));what="pulled";}
    if(genAuth){                                                     /* 翻代：采纳云端、清本店 shadow、记新代，不回推（E2-b） */
      if(lib.shadowPick)shadowSet(st.key,lib.shadowPick(merged));
      sgenSet(st.key,remoteGen);
      return {key:st.key,what:what};
    }
    var needPush = (remote==null) ? !(lib.virgin(merged)&&!force)
                                  : sigM!==lib.sig(remote);
    if(force==="pullAll")needPush=false;
    if(force==="pushAll"&&lib.shadowPick)shadowSet(st.key,lib.shadowPick(local));  /* 推平跳过旧 shadow 基线：先立本地 starred 为新基线（E2-a） */
    if(needPush){
      var env={v:1,t:Date.now(),dev:cfg.dev||"dev",gen:envGen,data:merged};
      var attempt=function(n,sha){
        return push(st.key,env,sha).then(function(ok){
          if(ok===true)return;
          if(n>=2)throw new Error("上推冲突未决");
          return pull(st.key).then(function(p2){
            var r2=(p2.env&&p2.env.data!==undefined)?p2.env.data:null;
            if(force!=="pushAll"&&r2!=null)env.data=lib.merge(env.data,r2,{base:shadowGet(st.key)});  /* 推平 409 重试不合并：env.data 恒=local，只刷 sha（E2-a） */
            return attempt(n+1,p2.sha);
          });
        });
      };
      return attempt(0,p.sha).then(function(){
        var fin=(what==="pulled")?"pulled":"pushed";
        var cur=st.get();
        if(lib.sig(env.data)!==lib.sig(cur)){
          /* E11：push 在途窗内壳又 save 过（cur 岔开）——把在途增量并进来再落地，绝不整档回滚现场；
             并出的档若与已推云端不一致，下轮 saved()/轮询自然再推平（最终一致） */
          var fold=(cur==null)?env.data:lib.merge(env.data,cur,{base:shadowGet(st.key)});
          st.set(clone(fold));fin="pulled";
        }
        if(lib.shadowPick)shadowSet(st.key,lib.shadowPick(env.data));
        sgenSet(st.key,envGen);                                      /* 代确立于推成功之后（推失败不抬本地代，避免旧档复活） */
        return {key:st.key,what:fin};
      });
    }
    if(lib.shadowPick)shadowSet(st.key,lib.shadowPick(merged));
    sgenSet(st.key,envGen);                                          /* 无回推路径（含首拉采纳/pullAll）也落代，避免采纳后再工作被误判翻代丢失 */
    return {key:st.key,what:what};
  });
}

function syncNow(manual,force){
  if(!A)return Promise.resolve();
  if(A.blocked&&A.blocked()){if(manual)setMsg("本页免写模式，不同步");return Promise.resolve();}
  loadCfg();
  if(!enabled()){if(manual)setMsg("未配置 token");renderStatus();return Promise.resolve();}
  if(busy){if(manual)setMsg("同步中…");return Promise.resolve();}
  busy=true;setMsg("同步中…");nearLimit=false;probeP=null;   /* 探针每轮至多一次（修缮二 A） */
  var changed=[],pushed=0,errs=[],settled=false,timer=0;
  var chain=Promise.resolve();
  A.stores.forEach(function(st){                                  /* 逐店 .catch 收集错误继续下店：一店坏（含 fetch 悬挂/坏文件）不拖垮整轮（E10） */
    chain=chain.then(function(){return syncStore(st,force);}).then(function(r){
      if(r&&r.what==="pulled")changed.push(r.key);
      if(r&&r.what==="pushed")pushed++;
    }).catch(function(e){errs.push({key:st.key,msg:String(e&&e.message||"错")});});
  });
  var done=chain.then(function(){
    if(settled)return;settled=true;clearTimeout(timer);
    busy=false;lastOkT=Date.now();
    if(errs.length)setMsg("✗ "+errs.length+"店失败:"+errs[0].msg.slice(0,44));
    else setMsg("✓ "+hhmm(lastOkT)+(changed.length?" 收"+changed.length:"")+(pushed?" 发"+pushed:"")+(nearLimit?" ⚠店近1MB界":""));
    if(changed.length&&A.applied){try{A.applied(changed);}catch(e){}}
  }).catch(function(e){
    if(settled)return;settled=true;clearTimeout(timer);
    busy=false;setMsg("✗ "+String(e&&e.message||"网络不通").slice(0,42));
  });
  var guard=new Promise(function(res){timer=setTimeout(function(){   /* 90s 硬超时：fetch 悬挂也不永久卡 busy（E10） */
    if(!settled){settled=true;busy=false;setMsg("✗ 超时");}res();
  },90000);});
  return Promise.race([done,guard]);
}

/* 壳 save() 后的防抖上推 */
function saved(){
  if(!A||!enabled()||(A.blocked&&A.blocked()))return;
  clearTimeout(savedT);
  savedT=setTimeout(function(){syncNow(false);},10000);
}

/* ---------------- 面板 UI（克制灰阶 · 黑底） ---------------- */
var UI_CSS=[
"#kysync-btn{position:fixed;z-index:9990;right:10px;bottom:calc(44px + env(safe-area-inset-bottom));width:30px;height:30px;line-height:30px;text-align:center;",  /* 44px=让开各壳底栏与 408 字号钮；safe-area 让开 iOS Home 条（I5） */
" color:#3c3c44;font-size:14px;cursor:pointer;user-select:none;-webkit-user-select:none;border-radius:50%;transition:color .25s;}",
"#kysync-btn:hover{color:#8a8a94;}",
"#kysync-btn.kys-on{color:#5a5240;}#kysync-btn.kys-on:hover{color:#a8965e;}",
"#kysync-btn.kys-err{color:#6e3a3a;}",
"#kysync-panel{position:fixed;z-index:9991;right:12px;bottom:calc(80px + env(safe-area-inset-bottom));width:19.5rem;background:#0a0a0c;border:1px solid #232329;",
" border-radius:6px;padding:.9rem .95rem;font-size:.72rem;line-height:1.6;color:#9a9aa2;display:none;",
" box-shadow:0 8px 30px rgba(0,0,0,.55);text-align:left;}",
"#kysync-panel.show{display:block;}",
"#kysync-panel h4{margin:0 0 .5rem;font-size:.74rem;color:#c8c8ce;font-weight:600;letter-spacing:.08em;}",
"#kysync-panel input[type=text],#kysync-panel input[type=password]{width:100%;box-sizing:border-box;background:#101014;",
" border:1px solid #26262c;border-radius:3px;color:#c9c9cf;padding:.3rem .45rem;font-size:.72rem;margin:.15rem 0 .45rem;outline:none;}",
"#kysync-panel input:focus{border-color:#3a3a42;}",
"#kysync-panel label{color:#77777f;display:block;}",
"#kysync-row{display:flex;gap:.45rem;align-items:center;margin:.3rem 0 .5rem;}",
"#kysync-panel button{background:#131317;border:1px solid #2a2a31;color:#a9a9b1;border-radius:3px;",
" padding:.28rem .6rem;font-size:.7rem;cursor:pointer;}",
"#kysync-panel button:hover{border-color:#4a4a54;color:#d4d4da;}",
"#kysync-panel button.kys-gold{color:#b09a5e;border-color:#4a4232;}",
"#kysync-st{color:#6e6e76;margin-top:.45rem;min-height:1.1em;}",
"#kysync-hint{color:#55555c;font-size:.64rem;margin-top:.5rem;line-height:1.55;}",
"#kysync-more{margin-top:.4rem;}",
"#kysync-io{width:100%;box-sizing:border-box;height:7rem;background:#0d0d10;border:1px solid #26262c;color:#b9b9bf;",
" font-size:.62rem;margin-top:.4rem;display:none;}",
"#kysync-io.show{display:block;}",
"@media (max-width:520px){#kysync-panel{width:calc(100vw - 40px);right:8px;}}"
].join("\n");

function el(tag,attrs,html){var e=document.createElement(tag);if(attrs)Object.keys(attrs).forEach(function(k){e.setAttribute(k,attrs[k]);});if(html!=null)e.innerHTML=html;return e;}
var $btn=null,$panel=null,$st=null,$stBtn=null,$vault=null;
function vaultRefresh(){                                          /* 保险柜有槽才现身（修缮三） */
  if(!$vault)return;
  var v=vaultFind();
  if(v){$vault.textContent=vaultLabel(v);$vault.style.display="block";}
  else $vault.style.display="none";
}

function renderStatus(){
  if($st)$st.textContent=lastMsg;
  vaultRefresh();                                                 /* 修缮三：翻代刚发生也能当场现身 */
  if($btn){
    $btn.classList.toggle("kys-on",enabled());
    $btn.classList.toggle("kys-err",/^✗/.test(lastMsg));
    $btn.title="云档同步 · "+lastMsg;
  }
}
function buildUI(){
  if($btn||!document.body)return;
  var style=document.createElement("style");style.textContent=UI_CSS;document.head.appendChild(style);
  $btn=el("div",{id:"kysync-btn"},"⇅");
  $panel=el("div",{id:"kysync-panel"});
  $panel.appendChild(el("h4",null,"云档同步"));
  var tok=el("input",{type:"password",placeholder:"GitHub fine-grained token（只授 ky-sync 仓）",autocomplete:"off"});
  var dev=el("input",{type:"text",placeholder:"本机名（如 PC壁纸 / 手机）",autocomplete:"off"});
  var repo=el("input",{type:"text",placeholder:"仓库（owner/repo）",autocomplete:"off"});
  var lab1=el("label",null,"token");var lab2=el("label",null,"设备名");var lab3=el("label",null,"仓库");
  var row=el("div",{id:"kysync-row"});
  var onCk=el("input",{type:"checkbox",id:"kysync-on"});
  var onLab=el("label",{for:"kysync-on",style:"display:inline;color:#9a9aa2;cursor:pointer;"},"开启自动同步");
  row.appendChild(onCk);row.appendChild(onLab);
  var bSave=el("button",{"class":"kys-gold"},"保存并同步");
  var bNow=el("button",null,"立即同步");
  var more=el("div",{id:"kysync-more"});
  var bExp=el("button",null,"导出");var bImp=el("button",null,"导入");
  var bUp=el("button",null,"本机覆盖云端");var bDown=el("button",null,"云端覆盖本机");
  more.appendChild(bExp);more.appendChild(document.createTextNode(" "));more.appendChild(bImp);
  more.appendChild(document.createTextNode(" "));more.appendChild(bUp);more.appendChild(document.createTextNode(" "));more.appendChild(bDown);
  $vault=el("button",{id:"kysync-vault",style:"display:none;margin-top:.4rem;width:100%;"},"找回翻代前档");  /* 修缮三 */
  more.appendChild($vault);
  var io=el("textarea",{id:"kysync-io",placeholder:"存档 JSON（导出结果 / 粘贴后点导入）"});
  $st=el("div",{id:"kysync-st"},"");
  var hint=el("div",{id:"kysync-hint"},
    "token 创建：github.com → Settings → Developer settings → Fine-grained tokens，Repository access 只选 ky-sync，Permissions 只给 Contents Read&write。同一 token 各设备各贴一次。");
  $panel.appendChild(lab1);$panel.appendChild(tok);
  $panel.appendChild(lab2);$panel.appendChild(dev);
  $panel.appendChild(lab3);$panel.appendChild(repo);
  $panel.appendChild(row);
  $panel.appendChild(bSave);$panel.appendChild(document.createTextNode(" "));$panel.appendChild(bNow);
  $panel.appendChild(more);$panel.appendChild(io);$panel.appendChild($st);$panel.appendChild(hint);
  document.body.appendChild($btn);document.body.appendChild($panel);
  ["keydown","keyup","keypress"].forEach(function(t){$panel.addEventListener(t,function(e){e.stopPropagation();});});
  $panel.addEventListener("focusin",function(){$panel.style.bottom="auto";$panel.style.top="calc(8px + env(safe-area-inset-top))";});  /* 输入聚焦：面板贴顶，免手机软键盘盖住（I8） */
  $panel.addEventListener("focusout",function(){$panel.style.bottom="";$panel.style.top="";});
  function fill(){loadCfg();var c=cfg||{};tok.value=c.tok||"";dev.value=c.dev||"";repo.value=c.repo||DEF_REPO;onCk.checked=!!c.on;}
  $btn.addEventListener("click",function(){fill();$panel.classList.toggle("show");renderStatus();});
  document.addEventListener("pointerdown",function(e){
    if($panel.classList.contains("show")&&!e.target.closest("#kysync-panel,#kysync-btn"))$panel.classList.remove("show");
  },true);
  function grab(on){saveCfg({tok:tok.value.trim(),dev:dev.value.trim()||"设备",repo:repo.value.trim()||DEF_REPO,branch:"main",on:!!on});}
  bSave.addEventListener("click",function(){grab(true);onCk.checked=true;setMsg("已保存");syncNow(true);});
  bNow.addEventListener("click",function(){grab(onCk.checked);syncNow(true);});
  onCk.addEventListener("change",function(){grab(onCk.checked);setMsg(onCk.checked?"已开启":"已关闭");});
  bExp.addEventListener("click",function(){
    var out={_ky:"灯下存档",t:Date.now(),stores:{}};
    (A?A.stores:[]).forEach(function(st){out.stores[st.key]=st.get();});
    io.value=JSON.stringify(out);io.classList.add("show");io.select();
    setMsg("已导出本页各店，全选复制即可");
  });
  bImp.addEventListener("click",function(){
    if(!io.classList.contains("show")){io.classList.add("show");setMsg("粘贴导出 JSON 后再点导入");return;}
    try{
      var inp=JSON.parse(io.value);var n=0;
      (A?A.stores:[]).forEach(function(st){
        var lib=STORES[st.key];if(!lib||!inp.stores||inp.stores[st.key]==null)return;
        var cur=st.get(),nv=(cur==null)?inp.stores[st.key]:lib.merge(cur,inp.stores[st.key],{base:null});  /* 快照导入只增不删：不以本机 shadow 作三方基线（E4） */
        st.set(clone(nv));n++;
      });
      if(A&&A.applied)try{A.applied(["import"]);}catch(e){}
      setMsg("已按合并律导入 "+n+" 店");saved();
    }catch(e){setMsg("✗ 导入 JSON 不合法");}
  });
  bUp.addEventListener("click",function(){
    if(!confirm("以本机当前档覆盖云端（跳过合并）？"))return;
    grab(onCk.checked);syncNow(true,"pushAll");
  });
  bDown.addEventListener("click",function(){
    if(!confirm("以云端档覆盖本机（跳过合并，本机未上推的进度将丢失）？"))return;
    grab(onCk.checked);syncNow(true,"pullAll");
  });
  $vault.addEventListener("click",function(){                     /* 修缮三：取回翻代前的本机档 */
    var v=vaultFind();
    if(!v){setMsg("无翻代前档");vaultRefresh();return;}
    if(A&&A.blocked&&A.blocked()){setMsg("本页免写模式，不取回");return;}   /* MEMONLY/selftest/回看：零写入 */
    var sv=null;(A?A.stores:[]).forEach(function(s){if(s.key===v.key)sv=s;});
    if(!sv){setMsg("✗ 本页无 "+v.key+" 店");return;}
    if(!confirm("用翻代前的本机档覆盖当前本机档？随后自动同步会把它合并上云"))return;
    sv.set(clone(v.data));                                        /* 不动 sgen：本地代照旧，下一轮走常规合并律上云 */
    if(A&&A.applied)try{A.applied([v.key]);}catch(e){}
    setMsg("已取回翻代前档，正在同步…");
    syncNow(true);
  });
  renderStatus();
}

/* ---------------- 触屏与窄屏件（PROGRESS AI ⑤） ---------------- */
function mobilePatch(opt){
  opt=opt||{};
  try{ /* A1：standalone（PWA 加主屏/全屏）→ html.kysa，各壳 CSS 据 env(safe-area-inset) 让开刘海顶/Home 条底 */
    if(navigator.standalone===true||(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches))
      document.documentElement.classList.add("kysa");
  }catch(e){}
  try{ /* 窄屏视口钉 500：按「当前视口」判且随转屏重估——横屏 926pt 若仍钉 500 会成 1.85x 放大镜（审查官发现④） */
    if(!opt.noClamp){
      var reclamp=function(){
        var m=document.querySelector("meta[name=viewport]");
        if(!m){m=document.createElement("meta");m.setAttribute("name","viewport");document.head.appendChild(m);}
        var w=window.innerWidth||screen.width||9999;
        var clamp=!!(w&&w<500);
        var want=clamp?"width=500, viewport-fit=cover":"width=device-width, initial-scale=1, viewport-fit=cover";
        if(m.getAttribute("content")!==want)m.setAttribute("content",want);
        if(window.__KY_CLAMPED!==clamp){window.__KY_CLAMPED=clamp;   /* B3：置/撤钳即广播，各壳 fz 应用据此把生效值 cap 到 2.0（存储值不动） */
          try{window.dispatchEvent(new Event("ky:reclamp"));}catch(e){}}
      };
      reclamp();
      window.addEventListener("orientationchange",function(){setTimeout(reclamp,120);});
      window.addEventListener("resize",function(){setTimeout(reclamp,120);});
    }
  }catch(e){}
  if(!("ontouchstart" in window))return;
  var st=document.createElement("style");
  /* touch-action 必须落在命中目标上（只挂 body 时后代仍会吃双击缩放手势——手机双击查词难产的主嫌） */
  st.textContent="html,body,body *{touch-action:manipulation;}"
    +(opt.calloutSel?opt.calloutSel+"{-webkit-touch-callout:none;}":"")                    /* 只禁系统长按菜单（保留选区能力） */
    +(opt.noSelectSel?opt.noSelectSel+"{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}":"");
  document.head.appendChild(st);
  /* 双 tap → 合成 dblclick（iOS Safari 触屏不产原生 dblclick）
     宽容参数：≤450ms/≤44px；派发用「第一击」的坐标与元素——第二击手指常漂到邻词/空白 */
  var lt=0,lx=0,ly=0,lel=null;
  document.addEventListener("touchend",function(e){
    if(e.touches&&e.touches.length)return;
    var t=e.changedTouches&&e.changedTouches[0];if(!t)return;
    if(e.target&&e.target.closest&&e.target.closest("input,textarea,select,#kysync-panel"))return;
    var n=Date.now();
    var db=(n-lt)<450&&Math.hypot(t.clientX-lx,t.clientY-ly)<44;
    if(!db){lt=n;lx=t.clientX;ly=t.clientY;lel=e.target;return;}   /* 记 target 而非 elementFromPoint：捏合缩放下坐标系错位免疫（WebKit #170981） */
    var px=lx,py=ly,pel=(lel&&lel.isConnected)?lel:null;
    lt=0;lel=null;
    /* 延后派发恢复桌面事件序 click,click,dblclick——iOS 兼容鼠标事件在 touchend 之后才发，
       同步派发会变成 click①→dblclick→click②，尾随 click 覆写澈泡/误推导读（审查官发现①） */
    setTimeout(function(){
      if(opt.wordSelect)selectWordAt(px,py);
      var tgt=pel||document.elementFromPoint(px,py)||document.body;
      var ev;
      try{ev=new MouseEvent("dblclick",{bubbles:true,cancelable:true,view:window,clientX:px,clientY:py});}
      catch(err){ev=document.createEvent("MouseEvents");ev.initMouseEvent("dblclick",true,true,window,2,0,0,px,py,false,false,false,false,0,null);}
      tgt.dispatchEvent(ev);
    },120);
  },{passive:true});
  function selectWordAt(x,y){ /* 给「读选区」型双击处理器铺路：程序化选中所点单词 */
    try{
      var r=document.caretRangeFromPoint?document.caretRangeFromPoint(x,y):null;
      if(!r||r.startContainer.nodeType!==3)return;
      var node=r.startContainer,s=node.textContent,a=r.startOffset,b=a;
      while(a>0&&/[A-Za-z'\-]/.test(s.charAt(a-1)))a--;
      while(b<s.length&&/[A-Za-z'\-]/.test(s.charAt(b)))b++;
      if(b<=a)return;
      var rng=document.createRange();rng.setStart(node,a);rng.setEnd(node,b);
      var sel=window.getSelection();sel.removeAllRanges();sel.addRange(rng);
    }catch(e){}
  }
}

/* ---------------- 历史栈垫片（PROGRESS AI 追记四；I2 重写）：手机侧滑/浏览器返回=上一层而非直接离页
   levels=[{isOpen,close}] 自顶向底；「有层敞开↔历史签在位」由 ensureTag 对齐——冒泡相 click/touchend/keyup
   三监听在同一手势派发内同步补签（携用户激活，防 WebKit #248303 跳过无手势 pushState）+ 600ms 轮询兜底桌面/深链。
   开层→补签 pushState（仅未抛异常后置签）；侧滑/返回→popstate pop 签并 close() 最上层，setTimeout(0) 内若下面
   还有层立即补签（逐层可退）；UI 键自关→ensureTag 见无层有签即 history.back() 消签。签全消后再滑=原生离页（回枢纽）。 */
function histShim(levels){
  try{if(!window.history||!history.pushState||!levels||!levels.length)return;}catch(e){return;}
  var tagged=false;
  function top(){for(var i=0;i<levels.length;i++){try{if(levels[i].isOpen())return levels[i];}catch(e){}}return null;}
  function hasTag(){try{return !!(history.state&&history.state.ky);}catch(e){return tagged;}}
  function ensureTag(){                                    /* 层签对齐：有层无签补签、无层有签消签 */
    var open=!!top();
    if(open&&!tagged){try{history.pushState({ky:1},"");tagged=true;}catch(e){}}   /* 仅未抛异常后才置签 */
    else if(!open&&tagged){tagged=false;if(hasTag()){try{history.back();}catch(e){}}}
  }
  window.addEventListener("popstate",function(){
    var L=top();
    if(L){tagged=false;try{L.close();}catch(e){}
      setTimeout(function(){if(top())ensureTag();},0);     /* 关顶层后若下面还有层：导航语境立即补签，逐层可退（I2） */
    }
  });
  /* 冒泡相挂 click/touchend/keyup：同一手势派发内同步补签，携用户激活标记，防 WebKit #248303 跳过无手势签（I2） */
  ["click","touchend","keyup"].forEach(function(t){document.addEventListener(t,function(){ensureTag();},false);});
  setInterval(ensureTag,600);                              /* 桌面/深链兜底（无手势场景） */
}

/* ---------------- 装配 ---------------- */
function mount(adapter){
  A=adapter;loadCfg();seedCfg();  /* W3b：空档时采纳本机 sync_cfg.js 种子（免键盘贴 token） */
  try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist();}catch(e){}  /* iOS Safari 7 日无访问清档：申请持久存储豁免（I6） */
  mobilePatch(A.mobile||{});
  var tries=0;
  (function waitReady(){
    var ok=true;
    try{ok=!A.ready||A.ready();}catch(e){ok=false;}
    if(!ok&&++tries<120)return setTimeout(waitReady,500);
    buildUI();renderStatus();
    if(A.blocked&&A.blocked())return;         /* 免写模式：连轮询都不挂 */
    if(!ok){setMsg("壳未就绪，仅手动");return;}  /* ready 超时仍未就绪：不裸开 boot 同步/轮询/可见性，只留手动（E5） */
    setTimeout(function(){syncNow(false,A.firstForce||null);},1500);  /* ?reset=1 主动清档：firstForce="pushAll" 推平云端（沿守渡 WIPED 语义） */
    pollT=setInterval(function(){syncNow(false);},600000);
    document.addEventListener("visibilitychange",function(){
      if(document.hidden){                       /* 切后台：防抖在途即抢发（iOS 冻结前的几秒宽限窗能推完；失败=fail-closed 下轮再推） */
        if(savedT){clearTimeout(savedT);savedT=0;syncNow(false);}
      }else if(Date.now()-lastOkT>60000)syncNow(false);
    });
  })();
}
function lsStores(keys){
  return keys.map(function(k){return {
    key:k,
    get:function(){try{return JSON.parse(localStorage.getItem(k)||"null");}catch(e){return null;}},
    set:function(d){try{localStorage.setItem(k,JSON.stringify(d));}catch(e){}}
  };});
}
return {mount:mount,saved:saved,syncNow:syncNow,lsStores:lsStores,histShim:histShim,
        _m:{m408:m408,mWugeng:mWugeng,mMath:mMath,mWB:mWB,mArr:mArr,STORES:STORES,stab:stab},
        cfg:loadCfg,enabled:enabled,_io:_io};
})();

/* ==== M1 站群回传 evsite_core.js（正本 tools/app/，构建期原样带入）==== */
/* 站群使用事件回传 evsite_core.js（M1，正本在 tools/app/；与 sync_core/evlog_core 同块注入）。
   ----------------------------------------------------------------------------
   window.KyEvSite：把「页面进出」按经纪中心平台契约（spec-platform-v3 §六）送进统一账本。
     行： {ts:"2026-08-09T21:00:03.123-04:00", dev:"site", app:"<站名>",
           event:"open"|"close", id:"<yyyyMMddHHmmssSSS 北京>-<rand4>", meta:{…}}
     件： PUT /repos/<repo>/contents/ev/site/<yyyyMMdd 北京>/<HHmmssSSS 北京>-<rand4>.jsonl
          （一次 flush 一文件多行；base64 Contents API；create-only 免 sha，重名换名重试一次）
   进出口径：可见即 open、隐藏/离页即 close（页面进出的浏览器等价物）；页内视图/操作一律
     入 meta，不另发事件、不进配对（契约原文：页内细粒度放 meta，不进配对）。
   信道：与 ky-sync 同信任级——浏览器 fetch 出网，物理过用户 Clash TUN/系统代理，页面 JS
     无绕行面；无 token / 无网 / 接口错 = 静默跳过（fail-closed），本地行为分毫不变。
     铁律 8 复核在案（1ccuse CLAUDE.md）。
   ★ 只在 http(s) 页面动作：file:// 壁纸/本地壳一律零监听零写入零出网（那不是「站」，
     PC 侧另有 ActivityWatch 与执灯流水在账）。
   ★ 未 init / blocked()（selftest/SIM/SEEDED/MEMONLY/coop-join）：整对象零副作用——
     无定时器 / 无监听 / 无网络 / 无 localStorage 写入。
   ★ token 绝不入仓：只从本机 localStorage 取（三源，见 loadCfg）。
   ============================================================================ */
window.KyEvSite = (function () {
  "use strict";
  var API = "https://api.github.com";
  var DEF_REPO = "TricGrizen/agent-center";
  var CFG_KEY = "ky_ev_cfg";      /* 本站自有配置 {tok,repo,on} */
  var PAT_KEY = "jjzx_pat";       /* 经纪中心页同域 PAT（tricgrizen.com 上贴一处、各站通用） */
  var SYNC_KEY = "ky_sync_cfg";   /* 只借其 dev 设备名，不碰 token */
  var QKEY = "ky_evsite_q";       /* 离线队列（同源各站共用；每条自带 app，互不串账） */
  var QCAP = 2000;                /* 队列上限，溢出丢最旧 */
  var MAXAGE = 48 * 3600 * 1000;  /* 超 48h 的陈事件丢弃（账本已翻页，补传无意义） */
  var BATCH = 120;                /* 单文件行数上限（keepalive 体积 64KB 限内） */
  var BJ = 8 * 3600 * 1000;       /* 北京 = UTC+8 固定（1991 起无夏令时，不依赖 Intl） */
  var BACKOFF = [30000, 120000, 600000];

  var APP = null, BLK = null, INIT = false, cfg = null;
  var Q = [], seg = null, busy = false, tmr = 0, failN = 0, coldT = 0;

  /* ---------------- 小工具 ---------------- */
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function p3(n) { return (n < 10 ? "00" : n < 100 ? "0" : "") + n; }
  function nk(o) { var k; for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return true; return false; }
  function rnd() { return ("000" + Math.floor(Math.random() * 1679616).toString(36)).slice(-4); }
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function blocked() { try { return BLK ? !!BLK() : false; } catch (e) { return true; } }
  function webPage() {
    try { return location.protocol === "https:" || location.protocol === "http:"; } catch (e) { return false; }
  }

  /* ts：设备本地墙上时间 + 真实偏移（契约「ISO 带偏移」；汇流层按偏移换算北京） */
  function isoTs(t) {
    var d = new Date(t), o = -d.getTimezoneOffset(), s = o < 0 ? "-" : "+", a = Math.abs(o);
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "T" +
      p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds()) +
      s + p2(Math.floor(a / 60)) + ":" + p2(a % 60);
  }
  /* 目录与文件名一律北京时（平台 watchDirs 按北京日历日巡目录，须对齐） */
  function bj(t) {
    var d = new Date(t + BJ);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
             H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(), ms: d.getUTCMilliseconds() };
  }
  function bjYmd(t) { var p = bj(t); return "" + p.y + p2(p.m) + p2(p.d); }
  function bjHms(t) { var p = bj(t); return p2(p.H) + p2(p.M) + p2(p.S) + p3(p.ms); }
  function newId(t) { return bjYmd(t) + bjHms(t) + "-" + rnd(); }

  /* ---------------- 配置（三源；一律本机，绝不入仓） ---------------- */
  function loadCfg() {
    var c = null, v;
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch (e) { c = null; }
    if (!c || typeof c !== "object" || !c.tok) c = null;
    if (!c) {                                   /* 同域回落：经纪中心页贴的 PAT（一处贴、各站通用） */
      try { v = localStorage.getItem(PAT_KEY); } catch (e) { v = null; }
      if (v && String(v).trim()) c = { tok: String(v).trim(), repo: DEF_REPO, on: true };
    }
    if (!c) {                                   /* 本机免键盘桩（壁纸/WE 同 sync_cfg.js 先例） */
      try { v = window.__KY_EV_CFG; } catch (e) { v = null; }
      if (v && typeof v === "object" && v.tok)
        c = { tok: String(v.tok).trim(), repo: (v.repo ? String(v.repo).trim() : "") || DEF_REPO, on: v.on !== false };
    }
    if (c && !c.repo) c.repo = DEF_REPO;
    cfg = c; return c;
  }
  function enabled() { return !!(cfg && cfg.on !== false && cfg.tok && cfg.repo); }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} cfg = c; }
  /* 深链一次性配 token：?evtok=…（各 PWA 容器 localStorage 各自独立，装机后每壳开一次即可）；
     取到即从地址栏抹去，且保 history.state 不失（math/vocab 的层栈以 state 为身） */
  function takeTok() {
    try {
      var m = /[?&]evtok=([^&#]+)/.exec(location.search);
      if (!m) return;
      var tok = decodeURIComponent(m[1]).trim();
      var r = /[?&]evrepo=([^&#]+)/.exec(location.search);
      if (tok) saveCfg({ tok: tok, repo: (r ? decodeURIComponent(r[1]).trim() : "") || DEF_REPO, on: true });
      var s = location.search.replace(/([?&])evtok=[^&#]*/, "$1").replace(/([?&])evrepo=[^&#]*/, "$1")
        .replace(/&&+/g, "&").replace(/[?&]$/, "").replace(/^\?&/, "?");
      if (s === "?") s = "";
      if (history.replaceState) history.replaceState(history.state, "", location.pathname + s + location.hash);
    } catch (e) {}
  }
  function devName() {
    try {
      var c = JSON.parse(localStorage.getItem(SYNC_KEY) || "null");
      if (c && c.dev) return String(c.dev).slice(0, 24);
    } catch (e) {}
    return "";
  }

  /* ---------------- 队列（localStorage 环形；写在前、发在后，硬杀不丢） ---------------- */
  function qload() {
    try { var a = JSON.parse(localStorage.getItem(QKEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function qsave() { try { localStorage.setItem(QKEY, JSON.stringify(Q)); } catch (e) {} }
  function qtrim() {                                /* 返回是否动过（免空写 localStorage） */
    var t = Date.now(), n = Q.length;
    Q = Q.filter(function (x) { return x && typeof x.t === "number" && t - x.t <= MAXAGE; });
    if (Q.length > QCAP) Q = Q.slice(Q.length - QCAP);
    return Q.length !== n;
  }

  /* meta：页内细节（路径/查询）；凭据样参数一律抹去，不进配对 */
  var SECRET_RE = /(tok|token|pat|pass|pw|key|secret|auth|gp)$/i;
  function scrubQS() {
    var s = "";
    try { s = (location.search || "") + (location.hash || ""); } catch (e) { return ""; }
    if (!s) return "";
    s = s.replace(/([?&#]|^)([A-Za-z0-9_\-]+)=([^&#]*)/g, function (all, sep, k, v) {
      return SECRET_RE.test(k) ? sep + k + "=…" : all;
    });
    return s.slice(0, 80);
  }
  function meta() {
    var m = {}, d;
    try { if (location.pathname) m.p = String(location.pathname).slice(0, 80); } catch (e) {}
    var q = scrubQS(); if (q) m.q = q;
    d = devName(); if (d) m.d = d;
    return m;
  }

  function log(t, kind, m) {
    Q.push({ t: t, a: APP, e: kind, m: m, id: newId(t) });
    qtrim(); qsave();                               /* 写在前、发在后：硬杀/闪退不丢事件 */
  }
  function wire(x) {
    var o = { ts: isoTs(x.t), dev: "site", app: x.a, event: x.e, id: x.id };
    if (x.m && nk(x.m)) o.meta = x.m;
    return o;
  }

  /* ---------------- 进出 ---------------- */
  function openSeg() {
    if (seg || !INIT || blocked()) return;
    var t = Date.now();
    seg = { t: t };
    log(t, "open", meta());
    sched(2000);                       /* 尽快上屏：平台「此刻」靠这条 open 认在用 */
  }
  function closeSeg(hard) {
    if (!seg || !INIT || blocked()) return;
    var t = Date.now(), m = meta();
    m.s = Math.round((t - seg.t) / 1000);
    seg = null;
    log(t, "close", m);
    flush(!!hard);                     /* 离页：keepalive 直发（sendBeacon 不能带 Authorization 头） */
  }

  /* ---------------- 上传 ---------------- */
  function sched(ms) {
    if (tmr || !INIT || blocked()) return;
    try { tmr = setTimeout(function () { tmr = 0; flush(false); }, ms); } catch (e) { tmr = 0; }
  }
  function cool() { coldT = Date.now() + BACKOFF[Math.min(failN, BACKOFF.length - 1)]; failN++; }

  function putOnce(t, body, keepalive) {
    var path = "/repos/" + cfg.repo + "/contents/ev/site/" + bjYmd(t) + "/" + bjHms(t) + "-" + rnd() + ".jsonl";
    var h = { "Authorization": "Bearer " + cfg.tok, "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
    var o = { method: "PUT", headers: h, body: JSON.stringify(body) };
    if (keepalive) o.keepalive = true;
    else { try { if (window.AbortSignal && AbortSignal.timeout) o.signal = AbortSignal.timeout(20000); } catch (e) {} }
    return fetch(API + path, o);
  }

  function flush(keepalive) {
    if (!INIT || blocked()) return;
    if (busy && !keepalive) return;               /* 离页一发不可挡：宁可重发（id 去重）也不吞 close */
    if (qtrim()) qsave();
    if (!Q.length) return;
    loadCfg();
    if (!enabled()) return;                       /* fail-closed：无 token 静默，事件留队列候配置 */
    if (Date.now() < coldT) return;
    var batch = Q.slice(0, BATCH);
    var ids = {}, i;
    for (i = 0; i < batch.length; i++) ids[batch[i].id] = 1;
    var text = batch.map(function (x) { return JSON.stringify(wire(x)); }).join("\n") + "\n";
    var body = { message: "ev site", content: b64e(text) };
    var t = Date.now();
    busy = true;
    var done = function (ok) {
      busy = false;
      if (ok) {
        failN = 0; coldT = 0;
        Q = Q.filter(function (x) { return !ids[x.id]; });
        qsave();
        if (Q.length) sched(1500);                /* 余量续发 */
      } else cool();
    };
    var go = function (retry) {
      return putOnce(t, body, keepalive).then(function (r) {
        if (r && (r.status === 200 || r.status === 201)) { done(true); return; }
        if (r && r.status === 422 && !retry) return go(true);   /* 撞名：新随机名再来一次 */
        done(false);
      }).catch(function () { done(false); });
    };
    try { go(false); } catch (e) { busy = false; cool(); }
  }

  /* ---------------- 装配 ---------------- */
  function init(opt) {
    if (INIT) return;                              /* 幂等 */
    opt = opt || {};
    APP = String(opt.app || "site").slice(0, 24);
    BLK = (typeof opt.blocked === "function") ? opt.blocked : null;
    if (!webPage()) return;                        /* file:// 等非站形态：整件不上场 */
    if (blocked()) return;                         /* 惰化：零监听/零定时器/零网络/零写入 */
    INIT = true;
    takeTok();
    Q = qload();
    try {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") closeSeg(true); else openSeg();
      });
      window.addEventListener("pagehide", function () { closeSeg(true); });
      window.addEventListener("pageshow", function () {
        if (document.visibilityState !== "hidden") openSeg();
      });
    } catch (e) {}
    try { setInterval(function () { flush(false); }, 60000); } catch (e) {}
    if (document.visibilityState === "hidden") sched(3000);   /* 后台开页：只补传旧队列 */
    else openSeg();
  }

  return {
    init: init, flush: flush,
    open: openSeg, close: closeSeg,
    setToken: function (tok, repo) { saveCfg({ tok: String(tok || "").trim(), repo: repo || DEF_REPO, on: true }); },
    _q: function () { return Q; },
    _wire: wire,
    _cfg: function () { return loadCfg(); }
  };
})();
