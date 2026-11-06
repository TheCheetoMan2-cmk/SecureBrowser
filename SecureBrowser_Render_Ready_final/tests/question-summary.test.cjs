const fs=require('fs'),vm=require('vm'),assert=require('assert');
const file=require('path').resolve(__dirname,'../summary-core.js');
const module1={exports:{}};
const ctx={module:module1,exports:module1.exports,require:(name)=>{
 if(name==='axios')return {get:async()=>{throw Error('No internet')}};
 if(name==='jsdom')return {JSDOM:class {constructor(){this.window={document:{}}}}};
 if(name==='./search-core')return {search:async()=>({results:[]})};
 return require(name);
},Buffer, URL, setTimeout, clearTimeout, console, Map,Set,Date};
vm.runInNewContext(fs.readFileSync(file,'utf8'),ctx,{filename:file});
const {buildSummary,questionKind}=module1.exports._internals;
const make=(url,text,source='Web')=>({url,title:new URL(url).hostname,snippet:text,source});
const cases=[
 {q:'What is the capital of France?', r:make('https://example.org/France','Paris is the capital and largest city of France. It is located in northern France.'), contains:'Paris'},
 {q:'When was the first iPhone released?',r:make('https://example.org/iphone','The first iPhone was released on June 29, 2007 in the United States.'),contains:'2007'},
 {q:'Where is Mount Everest located?',r:make('https://example.org/everest','Mount Everest is located on the border between Nepal and the Tibet Autonomous Region of China.'),contains:'Nepal'},
 {q:'How many legs does a spider have?',r:make('https://example.org/spider','A spider has eight legs, unlike insects which have only six legs.'),contains:'eight'},
 {q:'what is a black hole',r:make('https://example.org/black-hole','A black hole is a region of spacetime where gravity is so strong that nothing can escape.'),contains:'gravity'}
];
for(const {q,r,contains} of cases){
 const data=buildSummary(q,[r],new Map());
 assert(data.isQuestion===true);
 assert(data.answer && data.answer.text.includes(contains),'No answer for '+q);
 assert.equal(data.sources[0].url,r.url);
}
const noSource=buildSummary('Why does water freeze?',[],new Map());
assert(noSource.isQuestion===true&&!noSource.answer&&!noSource.available);
const bland=buildSummary('Why is the sky blue?',[make('https://example.org/foo','The sky is blue on clear days and may be gray when cloudy.')],new Map());
assert(!bland.answer,'Should not make unsupported causal claim');
const tempting=buildSummary('Why is the sky blue?',[make('https://example.org/blog','The sky looks blue because air molecules scatter blue light.')],new Map());
assert(!tempting.answer,'Should not use blog metadata without verified body text');
const ordinary=buildSummary('Weather', [make('https://example.org/weather','Weather conditions change frequently in different parts of the world.')],new Map());
assert(ordinary.isQuestion===false);
console.log('OK all tests');
