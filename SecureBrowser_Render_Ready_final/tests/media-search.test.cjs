'use strict';
const assert=require('node:assert/strict');
const actualFetch=global.fetch;
const responses={
 wikimedia:{query:{pages:{123:{title:'File:Sunset cat.jpg',imageinfo:[{mime:'image/jpeg',url:'https://upload.wikimedia.org/photo.jpg',thumburl:'https://upload.wikimedia.org/thumb.jpg',descriptionurl:'https://commons.wikimedia.org/wiki/File:Sunset_cat.jpg',width:900,height:650}]}}}},
 photon:{features:[{geometry:{coordinates:[-122.9574,50.1163]},properties:{name:'Whistler',city:'Whistler',state:'British Columbia',country:'Canada',osm_value:'town'}}]}
};
global.fetch=async url=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(String(url).includes('wikimedia')?responses.wikimedia:responses.photon)});
(async()=>{
 const {media,_internals}=require('../media-core');
 assert.equal(_internals.safeHttps('javascript:alert(1)'),null);
 assert.equal(_internals.cleanQuery('  sunsets  '),'sunsets');
 const imgs=await media('images','sunsets');
 assert.equal(imgs.items.length,1);assert.match(imgs.items[0].source,/commons\.wikimedia\.org/);
 const imgCache=await media('images','sunsets');assert.equal(imgCache.cached,true);
 const maps=await media('maps','Whistler');assert.equal(maps.items.length,1);assert.equal(maps.items[0].lat,50.1163);
 assert.match(maps.items[0].url,/openstreetmap\.org/);
 console.log('Media source, URL-safety, and cache tests passed.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.fetch=actualFetch;});
