'use strict';
// Bounded, cached public-source discovery for Secure Search categories.
// Image files: Wikimedia Commons; videos: supported YouTube discovery;
// maps: OpenStreetMap data via the public Photon geocoder.
const cache=new Map();
const CACHE_MAX=130;
const TTL={images:300000,videos:120000,maps:360000};
const cleanQuery=(q)=>String(q||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,150);
const safeHttps=(value)=>{try{const u=new URL(String(value||''));return u.protocol==='https:'?u.href:null;}catch{return null;}};
async function getJson(url,timeout=3200){
 const controller=new AbortController();const t=setTimeout(()=>controller.abort(),timeout);
 try{const res=await fetch(url,{signal:controller.signal,headers:{accept:'application/json','user-agent':'SecureSearchBrowser/2.2 (public image and places lookup)'}});
  if(!res.ok)throw new Error('Upstream '+res.status);
  const length=Number(res.headers?.get?.('content-length')||0);if(length>1250000)throw new Error('Response too large');
  const body=await res.text();if(body.length>1250000)throw new Error('Response too large');return JSON.parse(body);
 }finally{clearTimeout(t)}
}
async function commonsImages(q,page){
 const url=new URL('https://commons.wikimedia.org/w/api.php');
 for(const [k,v] of Object.entries({action:'query',format:'json',generator:'search',gsrsearch:q,gsrnamespace:'6',gsrlimit:'24',gsroffset:String(page*24),prop:'imageinfo',iiprop:'url|mime|size',iiurlwidth:'480'}))url.searchParams.set(k,v);
 const data=await getJson(url.href,3900);
 return Object.values(data.query?.pages||{}).map(x=>{
  const info=x.imageinfo?.[0];if(!info||!/^image\/(?:png|jpe?g|webp|gif)$/i.test(info.mime||''))return null;
  const thumb=safeHttps(info.thumburl||info.url),original=safeHttps(info.url),source=safeHttps(info.descriptionurl);
  if(!thumb||!source)return null;
  return {title:String(x.title||'Image').replace(/^File:/,'').slice(0,180),thumb,original,source,host:'Wikimedia Commons',width:Number(info.width)||0,height:Number(info.height)||0};
 }).filter(Boolean);
}
async function youtubeVideos(q){
 const {handler}=require('./youtube-core');
 const data=await handler({action:'search',q,type:'video'});
 return (data.items||[]).filter(x=>x.type==='video'&&safeHttps(x.url)&&safeHttps(x.thumbnail)).slice(0,24).map(x=>({
  title:String(x.title||'Video').slice(0,200),thumb:x.thumbnail,url:x.url,channel:String(x.channelTitle||'YouTube').slice(0,100),description:String(x.description||'').slice(0,230),id:String(x.id||'')
 }));
}
async function places(q){
 const url=new URL('https://photon.komoot.io/api/');url.searchParams.set('q',q);url.searchParams.set('limit','10');url.searchParams.set('lang','en');
 const data=await getJson(url.href,3400);
 return (data.features||[]).map(f=>{
  const coords=f.geometry?.coordinates||[];const lng=Number(coords[0]),lat=Number(coords[1]);if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return null;
  const p=f.properties||{};const name=[p.name,p.city||p.county,p.state,p.country].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i).join(', ').slice(0,230);
  return {name:name||String(q).slice(0,120),lat,lng,kind:String(p.osm_value||p.type||'Place').replaceAll('_',' ').slice(0,60),url:'https://www.openstreetmap.org/?mlat='+lat+'&mlon='+lng+'#map=15/'+lat+'/'+lng};
 }).filter(Boolean).slice(0,10);
}
async function media(kind,q,page=0){
 kind=['images','videos','maps'].includes(kind)?kind:'images';q=cleanQuery(q);page=Math.max(0,Math.min(4,Number.parseInt(page,10)||0));
 if(!q)return {kind,query:q,items:[],message:'Enter a search to see '+kind+'.'};
 const key=JSON.stringify([kind,q.toLowerCase(),page]),existing=cache.get(key);
 if(existing?.value && existing.expiry>Date.now())return {...existing.value,cached:true};
 if(existing?.pending)return existing.pending;
 const pending=(async()=>{
  let items=[];try{items=kind==='images'?await commonsImages(q,page):kind==='videos'?await youtubeVideos(q):await places(q);}catch(e){/* fail safe and display an honest fallback */}
  const value={kind,query:q,page,items,source:kind==='images'?'Wikimedia Commons':kind==='videos'?'YouTube':'OpenStreetMap / Photon',message:items.length?'':'This source returned no results. Try a different phrase or open the provider directly.'};
  cache.set(key,{value,expiry:Date.now()+TTL[kind]});if(cache.size>CACHE_MAX)cache.delete(cache.keys().next().value);
  return value;
 })();cache.set(key,{pending});return pending;
}
module.exports={media,_internals:{cleanQuery,safeHttps,commonsImages,places}};
