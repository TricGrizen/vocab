/* 铸影 sw.js（build_vocab.py 产）：版本化预缓存；数据件独立缓存名（内容不变不重下）。*/
var V="vc-4d01deb8", DATA="vc-data-20d98dbf";
var PRE=["./","./index.html","./vocab_sync.js","./manifest.webmanifest","./icon-512.png","./icon-192.png","./icon-180.png"];
self.addEventListener("install",function(e){e.waitUntil(caches.open(V).then(function(c){return c.addAll(PRE);}).then(function(){return self.skipWaiting();}));});
self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==V&&k!==DATA;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener("fetch",function(e){var u;try{u=new URL(e.request.url);}catch(err){return;}
if(u.origin!==location.origin)return; if(e.request.method!=="GET")return;
var cn=/vocab_data\.js$/.test(u.pathname)?DATA:V;
e.respondWith(caches.open(cn).then(function(c){return c.match(e.request,{ignoreSearch:true}).then(function(hit){if(hit)return hit;return fetch(e.request).then(function(r){if(r&&r.ok){c.put(e.request,r.clone());}return r;});});}));});
