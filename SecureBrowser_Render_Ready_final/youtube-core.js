'use strict';
// Official YouTube Data API when YOUTUBE_API_KEY is configured. Without a key,
// public web search and YouTube's public oEmbed endpoint are used for a limited view.
// No extraction of video streams, access tokens or authentication cookies.
const {search: webSearch} = require('./search-core');
const KEY = () => String(process.env.YOUTUBE_API_KEY || '').trim();
const cache = new Map();
const LIMIT = 150;
const EXAMPLES = [
  {id:'M7lc1UVf-VE', title:'YouTube embedded player demo',channelTitle:'YouTube Developers'},
  {id:'jNQXAC9IVRw',title:'Me at the zoo',channelTitle:'jawed'},
  {id:'aqz-KE-bpKQ',title:'Big Buck Bunny',channelTitle:'Blender Foundation'},
  {id:'9bZkp7q19f0',title:'PSY — GANGNAM STYLE',channelTitle:'officialpsy'},
  {id:'dQw4w9WgXcQ',title:'Rick Astley — Never Gonna Give You Up',channelTitle:'Rick Astley'},
  {id:'jfKfPfyJRdk',title:'lofi hip hop radio — beats to relax/study to',channelTitle:'Lofi Girl'},
];
function examples(){return EXAMPLES.map(x=>({type:'video',id:x.id,title:x.title,channelTitle:x.channelTitle,thumbnail:'https://i.ytimg.com/vi/'+x.id+'/hqdefault.jpg',url:'https://www.youtube.com/watch?v='+x.id,source:'featured'}));}
function clean(v,n=150){return String(v||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,n)}
function videoId(raw){try{const u=new URL(raw);const h=u.hostname.toLowerCase();if(h==='youtu.be')return /^[\w-]{11}$/.test(u.pathname.slice(1,12))?u.pathname.slice(1,12):null;if(!/(^|\.)youtube\.com$/.test(h))return null;const id=u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1];return /^[\w-]{11}$/.test(id||'')?id:null;}catch{return null}}
function image(id){return 'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg'}
function cached(key,ttl,fn){const now=Date.now(),hit=cache.get(key);if(hit&&hit.expires>now)return Promise.resolve(hit.value);if(hit?.pending)return hit.pending;const pending=Promise.resolve().then(fn).then(v=>{cache.set(key,{expires:Date.now()+ttl,value:v});if(cache.size>LIMIT)cache.delete(cache.keys().next().value);return v},e=>{cache.delete(key);throw e});cache.set(key,{pending});return pending;}
async function getJSON(url,timeout=4800){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);try{const r=await fetch(url,{signal:controller.signal,headers:{accept:'application/json','user-agent':'SecureBrowser/2.0'}});if(!r.ok)throw new Error('Upstream '+r.status);return await r.json();}finally{clearTimeout(timer)}}
async function api(resource,p){if(!KEY())return null;const url=new URL('https://www.googleapis.com/youtube/v3/'+resource);for(const [key,val] of Object.entries(p))if(val!==undefined&&val!==null&&val!=='')url.searchParams.set(key,String(val));url.searchParams.set('key',KEY());return getJSON(url.href)}
function toVideo(i){const id=typeof i.id==='string'?i.id:(i.id?.videoId||i.snippet?.resourceId?.videoId||i.contentDetails?.videoId);if(!/^[\w-]{11}$/.test(id||''))return null;const s=i.snippet||{},thumb=s.thumbnails||{};return {type:'video',id,title:clean(s.title||i.title,220)||'YouTube video',description:clean(s.description,2500),channelId:clean(s.channelId||i.channelId,120),channelTitle:clean(s.channelTitle||i.channelTitle,150),publishedAt:s.publishedAt||'',thumbnail:thumb.high?.url||thumb.medium?.url||thumb.default?.url||image(id),url:'https://www.youtube.com/watch?v='+id,views:i.statistics?.viewCount||'',likes:i.statistics?.likeCount||'',duration:i.contentDetails?.duration||'',source:'youtube-api'};}
function toChannel(i){const id=typeof i.id==='string'?i.id:(i.id?.channelId||i.snippet?.channelId);if(!id)return null;const s=i.snippet||{},thumb=s.thumbnails||{};return {type:'channel',id,title:clean(s.title,200)||'YouTube channel',description:clean(s.description,1800),thumbnail:thumb.high?.url||thumb.medium?.url||thumb.default?.url||'',banner:i.brandingSettings?.image?.bannerExternalUrl||'',handle:s.customUrl||'',subscribers:i.statistics?.subscriberCount||'',videos:i.statistics?.videoCount||'',url:'https://www.youtube.com/channel/'+encodeURIComponent(id)};}
async function webVideoSearch(q,limit=24){let r;try{r=await webSearch(q+' site:youtube.com/watch');}catch{return [];}const seen=new Set();const out=[];for(const x of r.results||[]){const id=videoId(x.url);if(!id||seen.has(id))continue;seen.add(id);out.push({type:'video',id,title:clean(x.title.replace(/\s*[-|]\s*YouTube\s*$/i,''),220)||'YouTube video',description:clean(x.snippet,340),channelTitle:'YouTube',thumbnail:image(id),url:'https://www.youtube.com/watch?v='+id,source:'web-search'});if(out.length===limit)break;}return out;}
async function search(q,kind='video',pageToken=''){q=clean(q,140);kind=['video','channel','playlist'].includes(kind)?kind:'video';pageToken=clean(pageToken,220);if(!q)return {items:[],source:'empty'};
 return cached('search:'+q+':'+kind+':'+pageToken,120000,async()=>{
 if(KEY())try{const data=await api('search',{part:'snippet',q,type:kind,maxResults:24,videoEmbeddable:kind==='video'?'true':undefined,pageToken});return {items:(data.items||[]).map(kind==='channel'?toChannel:toVideo).filter(Boolean),nextPageToken:data.nextPageToken||'',source:'youtube-api'};}catch(e){/* degrade visibly */}
 if(kind!=='video')return {items:[],source:'limited',notice:'Channel and playlist discovery needs a YouTube Data API key.'};
 return {items:await webVideoSearch(q),source:'web-search',notice:'Limited public web-search results; add YOUTUBE_API_KEY for richer and more accurate YouTube results.'};
 });}
async function feed(region='US'){
 return cached('feed:'+region,240000,async()=>{
 if(KEY())try{const data=await api('videos',{part:'snippet,contentDetails,statistics',chart:'mostPopular',regionCode:clean(region,2).toUpperCase()||'US',maxResults:30});const items=(data.items||[]).map(toVideo).filter(Boolean);if(items.length)return {items,source:'youtube-api',heading:'Trending videos'};}catch(e){}
 const found=await Promise.allSettled(['music videos','technology reviews','gaming videos'].map(q=>webVideoSearch(q,9)));
 const items=[],seen=new Set();for(const r of found)if(r.status==='fulfilled')for(const v of r.value){if(!seen.has(v.id)){seen.add(v.id);items.push(v);}}
 return items.length?{items,source:'web-search',heading:'Videos from public web search',notice:'A general public search feed, not YouTube personalized recommendations.'}:{items:examples(),source:'featured',heading:'Featured videos',notice:'Example videos are shown because live YouTube discovery is unavailable. Add a YouTube Data API key for live trending videos.'};
 });}
async function details(id){if(!/^[\w-]{11}$/.test(id))return {error:'Invalid video ID'};return cached('video:'+id,180000,async()=>{
 if(KEY())try{const data=await api('videos',{part:'snippet,statistics,contentDetails',id});const video=toVideo(data.items?.[0]||{});if(video)return {video,source:'youtube-api'};}catch(e){}
 try{const o=await getJSON('https://www.youtube.com/oembed?url='+encodeURIComponent('https://www.youtube.com/watch?v='+id)+'&format=json',3200);return {video:{type:'video',id,title:clean(o.title,220),channelTitle:clean(o.author_name,150),channelUrl:o.author_url||'',thumbnail:o.thumbnail_url||image(id),url:'https://www.youtube.com/watch?v='+id,source:'oembed'},source:'oembed'};}catch{return {video:{type:'video',id,title:'YouTube video',thumbnail:image(id),url:'https://www.youtube.com/watch?v='+id,source:'limited'},source:'limited'};}
 });}
async function channel(idOrHandle){const term=clean(idOrHandle,120);if(!term)return {error:'Missing channel'};return cached('channel:'+term,300000,async()=>{
 if(KEY())try{const param=/^UC[\w-]{22}$/.test(term)?{id:term}:term.startsWith('@')?{forHandle:term}:{forUsername:term};const data=await api('channels',{part:'snippet,statistics,brandingSettings',...param});const c=toChannel(data.items?.[0]||{});if(c)return {channel:c,source:'youtube-api'};}catch(e){}
 const id=term.startsWith('@')?term:'@'+term;return {channel:{type:'channel',id:term,title:term.startsWith('@')?term:'Channel '+term,description:'Full channel details require a YouTube Data API key.',thumbnail:'',banner:'',url:term.startsWith('@')?'https://www.youtube.com/'+encodeURI(term):'https://www.youtube.com/channel/'+encodeURIComponent(term)},source:'limited'};
 });}
async function channelVideos(idOrHandle,kind='videos',pageToken=''){
 const term=clean(idOrHandle,120);kind=kind==='shorts'?'shorts':'videos';if(!term)return {items:[]};return cached('channel-videos:'+term+':'+kind+':'+pageToken,180000,async()=>{
 let actualId=term;if(KEY()&&!actualId.startsWith('UC')){const c=await channel(term);actualId=c.channel?.id||term;}
 if(KEY()&&/^UC[\w-]{22}$/.test(actualId))try{const data=await api('search',{part:'snippet',channelId:actualId,type:'video',order:'date',maxResults:24,pageToken,videoDuration:kind==='shorts'?'short':undefined});return {items:(data.items||[]).map(toVideo).filter(Boolean),nextPageToken:data.nextPageToken||'',source:'youtube-api'};}catch(e){}
 const q=(term.startsWith('@')?term:'"'+term+'"')+' '+(kind==='shorts'?'shorts':'videos');return {items:await webVideoSearch(q,15),source:'web-search',notice:'Channel-specific results are approximate without a YouTube API key.'};
 });}
async function shorts(q){const r=await search(clean(q,100)||'popular shorts','video');return {...r,notice:'Short-video results are not guaranteed to be classified as Shorts; official Shorts identification requires additional data.'};}
async function comments(id){if(!KEY())return {items:[],source:'limited',notice:'YouTube comments require an API key.'};try{const data=await api('commentThreads',{part:'snippet',videoId:id,maxResults:15,order:'relevance',textFormat:'plainText'});return {items:(data.items||[]).map(x=>({author:clean(x.snippet?.topLevelComment?.snippet?.authorDisplayName,140),avatar:x.snippet?.topLevelComment?.snippet?.authorProfileImageUrl||'',text:clean(x.snippet?.topLevelComment?.snippet?.textDisplay,1700),likes:x.snippet?.topLevelComment?.snippet?.likeCount||0})),source:'youtube-api'};}catch{return {items:[],source:'limited',notice:'Comments are unavailable for this video.'};}}
async function handler(params){const action=clean(params.action,25)||'feed';const q=clean(params.q,140);switch(action){case 'feed':return feed(params.region);case 'search':return search(q,params.type,params.pageToken);case 'shorts':return shorts(q);case 'video':return details(clean(params.id,20));case 'channel':return channel(clean(params.id,120));case 'channelVideos':return channelVideos(clean(params.id,120),params.kind,params.pageToken);case 'comments':return comments(clean(params.id,20));default:return {error:'Unknown action'};}}
module.exports={handler,videoId,examples,toVideo};
