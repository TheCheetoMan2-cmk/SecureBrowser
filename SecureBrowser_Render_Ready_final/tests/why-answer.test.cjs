const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm'), path = require('path');
const mod = {exports:{}};
const ctx = {module:mod,exports:mod.exports, require:(name)=>{
  if (name === 'axios')return {get:async()=>{throw Error('Offline test')}};
  if (name === 'jsdom')return {JSDOM:class {constructor(){this.window={document:{}}}}};
  if (name === './search-core')return {search:async()=>({results:[]})};
  return require(name);
},Buffer,URL,setTimeout,clearTimeout,console,Map,Set,Date};
const source = fs.readFileSync(path.resolve(__dirname, '../summary-core.js'),'utf8');
vm.runInNewContext(source,ctx);
const {buildSummary,findWhyEvidence,reasonSentence} = mod.exports._internals;
const mk=(url,snippet)=>({url,title:new URL(url).hostname,snippet,source:'Web'});
const wiki='https://en.wikipedia.org/wiki/Diffuse_sky_radiation';
const blog='https://example.org/sky-blue';
const results=[mk(blog,'Wondering why the sky is blue? Discover seven fun facts and get the answer in this helpful blog article.'),mk(wiki,'The color of the sky can be explained through physics.')];
const pages = new Map([[wiki,{title:'Diffuse sky radiation',description:'Learn why the sky is blue today.', paragraphs:[
  'The sky appears blue because molecules and particles in the atmosphere scatter shorter blue wavelengths of sunlight more strongly than longer wavelengths. This phenomenon is commonly described as Rayleigh scattering, a process that redistributes sunlight in different directions.'
]}]]);
let a=buildSummary('Why is the sky blue?',results,pages);
console.log('Sky answer:',a.answer?.text, 'sources:',a.sources.map(x=>x.hostname));
assert(a.answer?.text.includes('scatter shorter blue wavelengths'));
assert.equal(a.answer?.quality,'page');
assert.equal(a.sources[0].url,wiki);
assert.equal(a.questionKind,'reason');
assert(!a.answer.text.includes('seven fun facts'));
let nothing=buildSummary('Why is the sky blue?',results,new Map());
assert.equal(nothing.answer,null,'No direct cause should come from snippets only');
assert.equal(nothing.available,false);
assert(!nothing.points.length);
const ice='https://university.edu/science/ice';
a=buildSummary('Why does ice float?', [mk(ice,'Read about why ice floats.')],new Map([[ice,{title:'Ice explained',paragraphs:[
  'Ice floats on water due to its lower density compared with liquid water, because its crystalline structure takes up more space for the same mass.'
]}]]));
assert(a.answer && /density/i.test(a.answer.text));
const unrelated='https://example.com/trees';
a=buildSummary('Why does rain fall?', [mk(unrelated,'There are many reasons that rain falls because of the clouds.')],new Map([[unrelated,{title:'Trees',paragraphs:[
  'Plants grow taller because they have access to water and sunlight throughout their developmental stages. Rain can fall anywhere in the world at different times.'
]}]]));
assert.equal(a.answer,null,'A different because clause must not answer the question');
const france=buildSummary('What is the capital of France?', [mk('https://example.com/france','Paris is the capital and largest city of France. It is located in northern France.')],new Map());
assert(france.answer?.text.includes('Paris'),'Non-why answers remain supported');
console.log('PASS: page-backed why answers, no blog previews as answers, no cross-topic causes, non-why unaffected.');
