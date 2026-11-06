const assert = require('node:assert/strict');
const {shouldHideInputSummary: hide} = require('../public/summary-eligibility');
for(const q of [
  'watch porn', 'NSFW videos', 'hentai drawings', 'nude photos', 'how to find a sex tape',
  'rule 34', 'real gore footage', 'how to kill myself', 'how to make a bomb', 'what the fuck',
  'onlyfans', 'download xxx videos', 'sex', 'nudity', 'adult videos'
]) assert.equal(hide(q), true, 'Should hide summary: '+q);
for(const q of [
  'Why is the sky blue?', 'how do plants grow', 'Roblox Studio tutorials',
  'sex education for teenagers', 'breast cancer research', 'suicide prevention support',
  'how to report a crime', 'Sussex England weather', 'cocktail recipes',
  'how do I prevent online harassment?', 'how many planets are in our solar system?'
]) assert.equal(hide(q), false, 'Should retain summary: '+q);
console.log('Input Summary query filter checks passed.');
