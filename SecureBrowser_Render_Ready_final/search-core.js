/* Secure Search: search result aggregation & ranking layer.
   The UI and ranking are Secure Search's own; result URLs come from publicly
   accessible third-party indexes (not a proprietary full-web crawler). */
'use strict';
const { JSDOM } = require('jsdom');
const { URL } = require('url');
const internalIndex = require('./secure-index.json');

const htmlScratch = new JSDOM('<body></body>').window.document;
const ua = 'Mozilla/5.0 (compatible; SecureSearch/1.0; +https://example.invalid/)';
const cache = new Map();
const CACHE_MS = 90 * 1000;
function textOf(node) {return (node?.textContent||'').replace(/\s+/g,' ').trim();}
function plain(s) {const input=String(s||'');if(!/[<&]/.test(input))return input.replace(/\s+/g,' ').trim();htmlScratch.body.innerHTML=input;return textOf(htmlScratch.body);}
function safeLink(raw){
  try {
    let url=new URL(String(raw).trim(), 'https://duckduckgo.com');
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname==='/l/') {
      const out=url.searchParams.get('uddg');if(out)url=new URL(out);
    }
    if (!['http:','https:'].includes(url.protocol)||url.username||url.password) return null;
    if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?)/i.test(url.hostname)) return null;
    url.hash='';
    return url.href;
  } catch {return null;}
}
function item(title,url,snippet,source){
 const valid=safeLink(url);
 if(!valid||!String(title).trim())return null;
 return {title:plain(title).slice(0,220),url:valid,snippet:plain(snippet).slice(0,430),source};
}
async function get(url,{timeout=3000,headers={}}={}){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
 try{
   const response=await fetch(url,{headers:{'user-agent':ua,'accept-language':'en-US,en;q=0.9',...headers},signal:controller.signal,redirect:'follow'});
   if(!response.ok)throw new Error('Upstream '+response.status);
   const body=await response.text();if(body.length>2_000_000)throw new Error('Upstream too large');
   return body;
 }finally{clearTimeout(timer);}
}
async function duckDuckGo(query,page=0){
 const url='https://html.duckduckgo.com/html/?q='+encodeURIComponent(query)+(page?'&s='+page*30:'');
 const html=await get(url,{headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0','accept':'text/html'}});
 const doc=new JSDOM(html).window.document;
 let items=[];
 for(const r of doc.querySelectorAll('.result, .web-result')){
  if(r.classList.contains('result--ad')||r.querySelector('.result__badge--ad'))continue;
  const a=r.querySelector('a.result__a, h2 a[href], .result__title a[href]');
  if(!a)continue;
  const sn=r.querySelector('.result__snippet, .result-snippet');
  const x=item(textOf(a),a.getAttribute('href'),textOf(sn),'Web');if(x)items.push(x);
 }
 return items;
}
async function bingRss(query,page=0){
 const xml=await get('https://www.bing.com/search?format=rss&q='+encodeURIComponent(query)+'&first='+(page*10+1),{headers:{accept:'application/rss+xml, application/xml, text/xml'}});
 const d=new JSDOM(xml,{contentType:'text/xml'}).window.document;
 return [...d.querySelectorAll('item')].slice(0,18).map(n=>item(textOf(n.querySelector('title')),textOf(n.querySelector('link')),textOf(n.querySelector('description')),'Web')).filter(Boolean);
}
async function wiki(query){
 const raw=await get('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch='+encodeURIComponent(query)+'&srlimit=6&format=json&utf8=1',{timeout:2500});
 const body=JSON.parse(raw);
 return (body.query?.search||[]).map(x=>item(x.title,'https://en.wikipedia.org/wiki/'+encodeURIComponent(x.title.replace(/ /g,'_')),x.snippet,'Wikipedia')).filter(Boolean);
}
async function braveApi(query,page){
 const key=process.env.BRAVE_SEARCH_API_KEY;if(!key)return [];
 const raw=await get('https://api.search.brave.com/res/v1/web/search?q='+encodeURIComponent(query)+'&count=20&offset='+Math.min(page,9),{headers:{'X-Subscription-Token':key,Accept:'application/json'}});
 return (JSON.parse(raw).web?.results||[]).map(x=>item(x.title,x.url,x.description,'Web')).filter(Boolean);
}
function indexSearch(query){
 const words=query.toLowerCase().split(/[^a-z0-9]+/).filter(x=>x.length>1);
 if(!words.length)return [];
 return internalIndex.map(x=>{
   const title=x.title.toLowerCase(),body=(x.title+' '+x.snippet+' '+x.tags).toLowerCase();
   const matches=words.filter(w=>body.includes(w)).length;
   const phrase=(title.includes(query.toLowerCase())?2:0);
   return {x,score:matches*2+phrase};
 }).filter(v=>v.score>=Math.max(2,words.length)).sort((a,b)=>b.score-a.score)
 .slice(0,8).map(({x})=>item(x.title,x.url,x.snippet,'Secure index')).filter(Boolean);
}
function rank(results,query,limit=22){
 const words=query.toLowerCase().split(/\W+/).filter(x=>x.length>2);
 const unique=new Map();let order=0;
 for(const list of results){for(const result of list){
  const key=result.url.replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/$/,'').toLowerCase();
  if(unique.has(key))continue;
  let score=100-(order++/4);const t=result.title.toLowerCase();const sn=result.snippet.toLowerCase();
  for(const w of words){if(t.includes(w))score+=5;if(sn.includes(w))score+=1;}
  if(t.includes(query.toLowerCase()))score+=13;
  if(result.source==='Wikipedia')score-=11;
  unique.set(key,{...result,score});
 }}
 const arr=[...unique.values()].sort((a,b)=>b.score-a.score);
 const used=new Map(),output=[];
 const hostLimit=/\bsite:/i.test(query)?18:3;
 for(const result of arr){let host;try{host=new URL(result.url).hostname.replace(/^www\./,'');}catch{continue;}
  if((used.get(host)||0)>=hostLimit)continue;used.set(host,(used.get(host)||0)+1);
  output.push((({score,...rest})=>rest)(result));
  if(output.length>=limit)break;
 }
 return output;
}
async function search(query,page=0){
 query=String(query||'').trim().slice(0,300);page=Math.max(0,Math.min(4,Number.parseInt(page,10)||0));
 if(!query)return {query,results:[],sources:[],message:'Enter a search term.'};
 const key=JSON.stringify([query,page]);const hit=cache.get(key);if(hit&&Date.now()-hit.at<(hit.value.partial?25000:CACHE_MS))return {...hit.value,cached:true};
 // Run all providers concurrently, but don't make fast results wait for the slowest.
 const tasks=[['Brave API',()=>braveApi(query,page)],['Web',()=>duckDuckGo(query,page)],['Bing RSS',()=>bingRss(query,page)],['Wikipedia',()=>wiki(query)]];
 const lists=tasks.map(()=>[]),completedFlags=tasks.map(()=>false);
 const jobs=tasks.map(([name,fn],i)=>Promise.resolve().then(fn).then(v=>{lists[i]=Array.isArray(v)?v:[];completedFlags[i]=true;},()=>{completedFlags[i]=true;}));
 const done=Promise.all(jobs);
 const waitFor=async(ms)=>{let t;try{await Promise.race([done,new Promise(resolve=>{t=setTimeout(resolve,ms);})]);}finally{clearTimeout(t);}};
 await waitFor(1650);
 if(!lists.some(x=>x.length))await waitFor(1050);
 const curated=indexSearch(query),sources=tasks.filter((_,i)=>lists[i].length).map(t=>t[0]);
 if(curated.length)sources.push('Secure index');
 const ranked=rank([...lists,curated],query);
 const partial=!completedFlags.every(Boolean);
 const value={query,page,results:ranked,sources,partial,message:ranked.length?'':'No results could be retrieved right now. The public search sources may be unavailable; try again or open a website directly.'};
 cache.set(key,{at:Date.now(),value});if(cache.size>80)cache.delete(cache.keys().next().value);
 // If a provider finishes just after the fast response, prepare a richer cache for a retry.
 if(partial)void done.then(()=>{
   const finishedSources=tasks.filter((_,i)=>lists[i].length).map(t=>t[0]);if(curated.length)finishedSources.push('Secure index');
   const finished=rank([...lists,curated],query);
   if(finished.length>=ranked.length)cache.set(key,{at:Date.now(),value:{query,page,results:finished,sources:finishedSources,partial:false,message:finished.length?'':value.message}});
 });
 return value;
}

async function suggest(query){
 query=String(query||'').trim().slice(0,100);
 if(query.length<2)return {query,suggestions:[]};
 const results=await Promise.allSettled([
  get('https://duckduckgo.com/ac/?q='+encodeURIComponent(query),{timeout:1900}).then(s=>JSON.parse(s).map(x=>x.phrase).filter(Boolean)),
  get('https://en.wikipedia.org/w/api.php?action=opensearch&search='+encodeURIComponent(query)+'&limit=6&namespace=0&format=json',{timeout:1900}).then(s=>JSON.parse(s)[1]),
 ]);
 const items=[],seen=new Set([query.toLowerCase()]);
 for(const result of results){if(result.status!=='fulfilled'||!Array.isArray(result.value))continue;for(const x of result.value){const t=String(x).trim().slice(0,100);if(t&&!seen.has(t.toLowerCase())){items.push(t);seen.add(t.toLowerCase())}}}
 return {query,suggestions:items.slice(0,8)};
}
module.exports={search,suggest,_internals:{rank,safeLink,indexSearch,duckDuckGo,bingRss,wiki}};
