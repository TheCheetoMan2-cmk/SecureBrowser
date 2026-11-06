/* Input Summary — non-AI, extractive summaries for Secure Search.
 * Uses the existing search results, pulls short excerpts from accessible pages,
 * and keeps a link back to the exact page supporting every excerpt.
 */
'use strict';

const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const { search } = require('./search-core');

const MAX_PAGE_BYTES = 600_000;
const PAGE_TIMEOUT_MS = 2100;
const CACHE_MS = 4 * 60_000;
const cache = new Map();
const STOP_WORDS = new Set('a an the is are was were be been being how what which who where when why does do did can should would could in on at for from to of by with and or but as it its this that these those you your about information tell me search find meaning definition'.split(' '));

function privateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && (p[1] === 168 || p[1] === 0)) || p[0] >= 224;
  }
  if (net.isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')) {
      const v4 = l.slice(7);
      return net.isIP(v4) === 4 ? privateIp(v4) : true;
    }
    return /^(fc|fd|fe[89ab]|ff)/.test(l);
  }
  return true;
}
function publicUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    if ((u.protocol === 'http:' && u.port && u.port !== '80') || (u.protocol === 'https:' && u.port && u.port !== '443')) return null;
    if (net.isIP(host) && privateIp(host)) return null;
    if (!host || host === 'localhost' || /\.(?:localhost|local|internal|test|invalid)$/.test(host) || host.length > 253) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {callback = options; options = {};}
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    const addresses = Array.isArray(address) ? address : [{address, family}];
    if (addresses.some(x => privateIp(x.address))) return callback(new Error('Private address is blocked'));
    callback(null, address, family);
  });
}
const agents = {
  httpAgent: new http.Agent({ lookup: safeLookup, keepAlive: true, maxSockets: 5 }),
  httpsAgent: new https.Agent({ lookup: safeLookup, keepAlive: true, maxSockets: 5 })
};
function cleanText(value) {
  return String(value || '')
    .replace(/\[[\d,\s]+\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
}
function tokens(q) {
  return [...new Set(String(q || '').toLowerCase().match(/[a-z\d]{2,}/g) || [])].filter(x => !STOP_WORDS.has(x));
}
function splitSentences(text) {
  return cleanText(text).split(/(?<=[.!?])\s+(?=[A-Z0-9“"'([])/u)
    .map(s => cleanText(s)).filter(s => s.length >= 48 && s.length <= 440 && s.split(/\s+/).length >= 8);
}
function scoreSentence(s, terms, position = 0) {
  const words = s.toLowerCase();
  const matches = terms.filter(w => words.includes(w)).length;
  const concentration = matches / Math.max(terms.length, 1);
  const lengthBonus = s.length >= 80 && s.length <= 280 ? 2 : 0;
  const boilerplate = /cookie|subscribe|sign in|log in|privacy policy|enable javascript|terms of use|all rights reserved|click here|advertisement/i.test(s) ? 12 : 0;
  return matches * 5 + concentration * 6 + lengthBonus - Math.min(position, 15) * .13 - boilerplate;
}
function trimSentence(sentence, max = 300) {
  let s = cleanText(sentence);
  if (s.length <= max) return s;
  const end = s.lastIndexOf(' ', max - 1);
  return (end > 135 ? s.slice(0, end) : s.slice(0, max)).trimEnd() + '…';
}
function looksLikeTextPage(html, url) {
  const doc = new JSDOM(html, { url }).window.document;
  for (const el of [...doc.querySelectorAll('script,style,noscript,template,nav,header,footer,aside,form,button,iframe,svg,canvas,[role="navigation"],[aria-hidden="true"],.cookie,.banner,.menu,.sidebar,.advertisement')]) el.remove();
  const description = cleanText(doc.querySelector('meta[name="description"]')?.getAttribute('content') || doc.querySelector('meta[property="og:description"]')?.getAttribute('content'));
  const nodes = [...doc.querySelectorAll('article p,main p,[role="main"] p')];
  if (nodes.length < 2) nodes.push(...doc.querySelectorAll('p'));
  const paragraphs = [];
  for (const n of nodes.slice(0, 100)) {
    const value = cleanText(n.textContent);
    if (value.length >= 60 && value.length < 1800 && !paragraphs.includes(value)) paragraphs.push(value);
    if (paragraphs.length >= 30) break;
  }
  const title = cleanText(doc.querySelector('title')?.textContent || '');
  doc.defaultView?.close();
  return {title, description, paragraphs};
}
async function fetchPage(url, depth = 0) {
  const safe = publicUrl(url);
  if (!safe || depth > 2) return null;
  const response = await axios.get(safe, {
    ...agents,
    timeout: PAGE_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_PAGE_BYTES,
    maxBodyLength: MAX_PAGE_BYTES,
    responseType: 'arraybuffer',
    validateStatus: () => true,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,text/plain;q=0.8',
      'accept-language': 'en-US,en;q=0.8'
    }
  });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
    return fetchPage(new URL(response.headers.location, safe).href, depth + 1);
  }
  if (response.status !== 200) return null;
  const type = String(response.headers['content-type'] || '').toLowerCase();
  if (!/text\/html|application\/xhtml\+xml|text\/plain/.test(type)) return null;
  let html = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);
  if (html.length > MAX_PAGE_BYTES) html = html.slice(0, MAX_PAGE_BYTES);
  if (type.includes('text/plain')) return {title: '', description: '', paragraphs: html.split(/\n\s*\n/).map(cleanText).filter(x => x.length >= 60).slice(0, 24)};
  return looksLikeTextPage(html, safe);
}
function chooseExtracts(query, results, pageContent) {
  const terms = tokens(query);
  const entries = [];
  const seenHosts = new Set();
  for (let i = 0; i < results.length && entries.length < 8; i++) {
    const result = results[i];
    const url = publicUrl(result?.url);
    if (!url || !result?.title) continue;
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (seenHosts.has(hostname)) continue;
    seenHosts.add(hostname);
    entries.push({url, title: cleanText(result.title).slice(0, 180), snippet: cleanText(result.snippet), hostname, source: result.source});
  }
  const points = [];
  for (const entry of entries) {
    const page = pageContent.get(entry.url);
    const candidates = [];
    if (page) {
      const sentences = page.paragraphs.flatMap(p => splitSentences(p)).slice(0, 85);
      if (page.description) sentences.unshift(...splitSentences(page.description));
      sentences.forEach((text, idx) => candidates.push({text, quality: 'page', score: scoreSentence(text, terms, idx)}));
    }
    const snippets = splitSentences(entry.snippet);
    if (snippets.length) snippets.forEach((text, idx) => candidates.push({text, quality: 'description', score: scoreSentence(text, terms, idx) - 3}));
    else if (entry.snippet.length >= 48) candidates.push({text: entry.snippet, quality: 'description', score: scoreSentence(entry.snippet, terms) - 3});
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best && best.score >= 0) points.push({text: trimSentence(best.text), quality: best.quality, title: entry.title, url: entry.url, hostname: entry.hostname, score: best.score});
  }
  // Prefer text actually read from pages, while retaining variety across sources.
  points.sort((a, b) => ((b.quality === 'page') - (a.quality === 'page')) * 6 + b.score - a.score);
  const chosen = [];
  for (const p of points) {
    if (chosen.some(x => x.text.toLowerCase() === p.text.toLowerCase())) continue;
    chosen.push(p);
    if (chosen.length >= 3) break;
  }
  return chosen.map(({score, ...point}, i) => ({...point, id: i + 1}));
}

// Input Summary question answering is extractive: the answer is taken verbatim
// from a search result description or an accessible webpage, never invented.
function questionKind(input) {
  const q = cleanText(input).toLowerCase().replace(/[?!.,]+$/, '').trim();
  if (/^(?:why\b|what (?:causes|caused)\b)/.test(q)) return 'reason';
  if (/^(?:when\b|what (?:year|date|day)\b)/.test(q)) return 'date';
  if (/^(?:where\b|in what (?:country|city|state)\b)/.test(q)) return 'place';
  if (/^(?:who\b|whom\b|whose\b)/.test(q)) return 'person';
  if (/^how (?:many|much|old|long|high|tall|far|big|fast|deep|heavy|wide)\b/.test(q)) return 'quantity';
  if (/^(?:how\b|what (?:steps|process)\b)/.test(q)) return 'process';
  if (/^(?:is|are|was|were|can|could|do|does|did|will|would|should|has|have)\b/.test(q)) return 'yesno';
  if (/^(?:what|which|define|definition of|meaning of|capital of|population of)\b/.test(q)) return 'fact';
  return /\?$/.test(cleanText(input)) ? 'fact' : null;
}
const ANSWER_PATTERNS = {
  reason: /\b(?:because|due to|caused by|causes?|results? (?:from|in)|responsible for|leads? to|scatter(?:s|ed|ing)?|absor(?:bs?|ption)|explained by|as a result)\b/i,
  date: /\b(?:1[5-9]\d{2}|20\d{2}|21\d{2}|january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  place: /\b(?:located|situated|based|capital|city|country|region|near|within|in)\b/i,
  person: /\b(?:is|was|were|named|known as|founded|invented|created|born|discovered|developed)\b/i,
  quantity: /\b(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|million|billion|percent)\b/i,
  process: /\b(?:by|through|using|involves?|first|then|process|requires?|steps?|when|works? by|used to|converts?|produces?|uses?)\b/i,
  yesno: /\b(?:can|cannot|can't|does|doesn't|do|don't|is|isn't|are|aren't|has|hasn't|may|possible|not|yes|no)\b/i,
  fact: /\b(?:is|are|was|were|refers to|means|known as|capital|defined as|consists of|includes?|appears?|contains?|differs?|transforms?|made of)\b/i
};
function answerSentences(text) {
  return cleanText(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"'([])/u)
    .map(cleanText).filter(s => s.length >= 22 && s.length <= 460 && s.split(/\s+/).length >= 4)
    .slice(0, 14);
}
function answerCandidates(query, results, pageContent, kind) {
  const terms = tokens(query);
  const candidates = [];
  const hosts = new Set();
  for (const result of results.slice(0, 18)) {
    const url = publicUrl(result?.url);
    if (!url || !result?.title) continue;
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (hosts.has(hostname)) continue;
    hosts.add(hostname);
    const title = cleanText(result.title).slice(0, 180);
    const page = pageContent.get(url);
    const texts = [];
    if (page) {
      if (page.description) texts.push(...answerSentences(page.description).map(text => ({text, quality: 'page'})));
      for (const paragraph of page.paragraphs.slice(0, 22)) {
        texts.push(...answerSentences(paragraph).map(text => ({text, quality: 'page'})));
        if (texts.length >= 110) break;
      }
    }
    texts.push(...answerSentences(result.snippet).map(text => ({text, quality: 'description'})));
    for (const [pos, candidate] of texts.entries()) {
      const value = candidate.text;
      const low = value.toLowerCase();
      const matched = terms.filter(term => low.includes(term)).length;
      if (matched < (terms.length >= 6 ? 2 : 1)) continue;
      if (/\b(?:accept (?:all )?cookies|enable javascript|sign in|log in|click here|terms and conditions|advertisement|all rights reserved)\b/i.test(value)) continue;
      // A summary should not repeat the question or present a headline as the answer.
      if (low.replace(/[?.!]+$/g, '') === cleanText(query).toLowerCase().replace(/[?.!]+$/g, '')) continue;
      const shape = ANSWER_PATTERNS[kind]?.test(value) ?? false;
      const overlap = matched / Math.max(terms.length, 1);
      const startOfPage = candidate.quality === 'page' ? Math.max(0, 3 - pos * 0.15) : 0;
      const score = matched * 5 + overlap * 7 + (shape ? 7 : -3) +
        (candidate.quality === 'page' ? 4 : -1) +
        (value.length >= 42 && value.length <= 290 ? 2 : 0) + startOfPage -
        (value.length > 360 ? 5 : 0) - (pos * 0.035);
      candidates.push({text: trimSentence(value, 340), quality: candidate.quality,
        url, hostname, title, shape, score, matched});
    }
    if (hosts.size >= 9) break;
  }
  candidates.sort((a,b) => b.score-a.score);
  return candidates;
}
function answerQuestion(query, results, pages) {
  const kind = questionKind(query);
  if (!kind) return null;
  const candidates = answerCandidates(query, results, pages, kind);
  // Only claim a direct answer if the sentence contains evidence of the
  // requested answer type, not merely the same search keywords.
  const best = candidates.find(c => c.shape && c.score >= (c.quality === 'page' ? 14 : 13));
  return {kind, best: best || null};
}

// Why questions require a real causal explanation from the BODY of a readable
// webpage. Search snippets and meta descriptions are never accepted as why answers.
// This is deterministic extraction and constrained wording, not a language model.
const WHY_CAUSAL_CONNECTORS = [
  {pattern: /\b(?:because of|due to|owing to|as a result of)\s+(.+)/i, style: 'noun'},
  {pattern: /\b(?:is|are|was|were|can be|may be|often be)?\s*caused by\s+(.+)/i, style: 'noun'},
  {pattern: /\b(?:results? from|stems? from|arises? from)\s+(.+)/i, style: 'noun'},
  {pattern: /\b(?:because|as the reason is that|the reason is that)\s+(.+)/i, style: 'clause'},
];
function whyFocus(query) {
  const stripped = cleanText(query).toLowerCase()
    .replace(/^(?:why\s+|what\s+(?:causes|caused)\s+)/, '')
    .replace(/^(?:does|do|did|is|are|was|were|has|have|can|could|would|will)\s+/, '')
    .replace(/[?!.]+$/g, '');
  return tokens(stripped).filter(x => !/^(?:happen|happens|thing|things|occur|occurs)$/.test(x));
}
function whySourceTrust(host) {
  if (/(?:^|\.)(?:gov|edu)$/.test(host)) return 7;
  if (/(?:^|\.)(?:wikipedia\.org|britannica\.com|nature\.com|nationalgeographic\.com|scientificamerican\.com)$/.test(host)) return 5;
  if (/(?:^|\.)(?:org)$/.test(host)) return 2;
  return 0;
}
function reasonSentence(source, context, focus) {
  const sentence = cleanText(source);
  if (sentence.length < 45 || sentence.length > 450 || /\b(?:cookie|subscribe|advertisement|privacy policy|learn more|buy now|read on|click here|sponsored|affiliate)\b/i.test(sentence)) return null;
  const low = sentence.toLowerCase();
  const words = sentence.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length < 8) return null;
  const inSentence = focus.filter(w => low.includes(w)).length;
  const inContext = focus.filter(w => String(context || '').toLowerCase().includes(w)).length;
  // The candidate must actually discuss the subject of the question, not just
  // include 'because' somewhere else on the page.
  if (focus.length && inSentence < Math.min(2, focus.length) && inContext < Math.min(2, focus.length)) return null;
  for (const connector of WHY_CAUSAL_CONNECTORS) {
    const match = connector.pattern.exec(sentence);
    if (!match) continue;
    const leading = sentence.slice(0, match.index).trim();
    let cause = match[1].trim().replace(/^[,:;\s]+|[\s]+$/g, '');
    cause = cause.replace(/(?:\s+Read more|\s+Click here|\s+Learn more)\b.*$/i,'').trim();
    if (cause.length < 25 || cause.split(/\s+/).length < 5 || cause.length > 295) continue;
    if (/^(?:something|anything|various factors|many things|several reasons|unknown reasons|the reasons above)\b/i.test(cause)) continue;
    if (!/[.!?]$/.test(cause)) cause += '.';
    const beforeRelevant = focus.some(w => leading.toLowerCase().includes(w));
    // Never use an explanation about a DIFFERENT subject just because the
    // following sentence mentions the search topic. For 'This is because…',
    // require the preceding sentence to establish the topic.
    const refersBack = /^(?:this|it|they|these|that|the main reason|one reason|the reason)\b/i.test(leading);
    const priorMatch = focus.some(w => String(context || '').toLowerCase().includes(w));
    if (!beforeRelevant && !(refersBack && priorMatch)) continue;
    // Keep a subject-containing lead from the body when it is short and clear.
    // Otherwise answer the question directly with a neutral, causal lead-in.
    let answer;
    if (connector.style === 'clause') {
      answer = beforeRelevant && leading.length >= 8 && leading.length <= 105 &&
        !/\b(?:however|although|though|while|whether|question|ask|explain)\b/i.test(leading) ?
        leading.replace(/[,;:]$/,'') + ' because ' + cause :
        'This happens because ' + cause[0].toLowerCase() + cause.slice(1);
    } else {
      answer = connector.style === 'noun' ? 'The main cause is ' + cause[0].toLowerCase() + cause.slice(1) : sentence;
      // For a gerund / action in the cause phrase, use natural causal language.
      if (/^the main cause is (?:the fact that |that )/i.test(answer)) {
        answer = answer.replace(/^the main cause is (?:the fact that |that )/i, 'This happens because ');
      }
    }
    return {text: trimSentence(answer, 425), original: sentence, cause, leading,
      inSentence, inContext, beforeRelevant, direct: beforeRelevant};
  }
  // A common explanatory pattern in science pages: the mechanism causes the
  // effect, instead of 'effect happens because mechanism'.
  const mechanism = /\b(?:causes?|produces?|creates?|triggers?|makes?|leads? to|results? in|is responsible for)\b/i.exec(sentence);
  if (mechanism && inSentence >= Math.min(2, focus.length) && sentence.length <= 310) {
    const before = sentence.slice(0, mechanism.index).trim();
    const after = sentence.slice(mechanism.index + mechanism[0].length).trim();
    if (before.length >= 15 && after.length >= 18 && focus.some(w => after.toLowerCase().includes(w))) {
      return {text: sentence, original:sentence, cause:before, leading:after,
        inSentence, inContext, beforeRelevant:true, direct:true};
    }
  }
  return null;
}
function findWhyEvidence(query, results, pages) {
  const focus = whyFocus(query);
  const candidates = [];
  const visitedHosts = new Set();
  for (const result of results.slice(0, 22)) {
    const url = publicUrl(result?.url);
    if (!url) continue;
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (visitedHosts.has(host)) continue;
    visitedHosts.add(host);
    const page = pages.get(url);
    if (!page?.paragraphs?.length) continue;
    const paragraphs = page.paragraphs.slice(0, 38);
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      const sentences = answerSentences(paragraph);
      for (const [index, sentence] of sentences.entries()) {
        const context = sentences.slice(Math.max(0,index-1), index).join(' ');
        const explanation = reasonSentence(sentence, context, focus);
        if (!explanation) continue;
        let score = explanation.inSentence * 6 + explanation.inContext * 2 +
          (explanation.beforeRelevant ? 7 : 0) + whySourceTrust(host) +
          (explanation.direct ? 2 : 0) - Math.min(paragraphIndex,20) * 0.16;
        if (explanation.cause.length > 180) score -= 2;
        if (/^this happens because/i.test(explanation.text)) score -= 2;
        candidates.push({...explanation, score, url, hostname: host,
          title: cleanText(page.title || result.title || host).slice(0,180),
          quality: 'page', paragraph, paragraphIndex});
      }
    }
  }
  candidates.sort((a,b) => b.score - a.score);
  return candidates;
}
function buildWhyAnswer(query, results, pages) {
  const evidence = findWhyEvidence(query, results, pages);
  const primary = evidence[0];
  if (!primary) return null;
  // Select a useful, separate explanation if the source contains one, ideally
  // from a second independent domain. Never add unsupported filler.
  let supporting = evidence.find(x => x.hostname !== primary.hostname &&
    x.original.toLowerCase() !== primary.original.toLowerCase() &&
    (x.inSentence >= 1 || x.inContext >= 2) && x.score >= primary.score - 12);
  if (!supporting) {
    const paras = pages.get(primary.url)?.paragraphs || [];
    const para = paras[primary.paragraphIndex] || '';
    const neighbours = answerSentences(para);
    const focus = whyFocus(query);
    const causeTerms = tokens(primary.cause).filter(t => t.length >= 5);
    const extra = neighbours.find(line => {
      const low = line.toLowerCase();
      const explainsSameCause = causeTerms.filter(t => low.includes(t)).length >= 2;
      return line !== primary.original && line.length >= 44 && line.length <= 240 &&
        (focus.some(t => low.includes(t)) || explainsSameCause) &&
        !/cookie|subscribe|read more|privacy policy/i.test(line);
    });
    if (extra) supporting = {...primary, text:extra, original:extra};
  }
  const sources = [{id:1,url:primary.url,title:primary.title,hostname:primary.hostname,quality:'page'}];
  const points = [];
  if (supporting) {
    const id = supporting.url === primary.url ? 1 : 2;
    points.push({id,text:trimSentence(supporting.text,300),quality:'page'});
    if (id === 2) sources.push({id,url:supporting.url,title:supporting.title,hostname:supporting.hostname,quality:'page'});
  }
  const differentSources = sources.length;
  return {
    query, isQuestion: true, questionKind:'reason',
    answer:{id:1,text:primary.text,quality:'page',type:'explanation'},
    points,sources,method:'pages',available:true,
    note:differentSources > 1 ?
      'Explanation constructed from accessible webpage text. Two independent sources are linked; check them for context.' :
      'Explanation based on an accessible webpage, not a blog preview. Check the linked source for full context.'
  };
}

function buildSummary(query, results, pages) {
  const kind = questionKind(query);
  if (kind === 'reason') {
    const explanation = buildWhyAnswer(query, results, pages);
    if (explanation) return explanation;
    return {query, isQuestion:true, questionKind:'reason', answer:null,
      points:[], sources:[], method:'pages', available:false,
      note:'I could not verify why from readable webpage content. Search previews alone are not enough to support an explanation.'};
  }
  const question = answerQuestion(query, results, pages);
  const rawPoints = chooseExtracts(query, results, pages);
  let points;
  let answer = null;
  if (question?.best) {
    const best = question.best;
    answer = {id: 1, text: best.text, quality: best.quality};
    const others = rawPoints.filter(x =>
      x.text.toLowerCase() !== best.text.toLowerCase() &&
      // Don't duplicate a near-identical answer as a supporting point.
      !(x.url === best.url && x.text.toLowerCase().includes(best.text.toLowerCase().slice(0, 65)))
    ).slice(0, 2);
    points = others.map((x, i) => ({...x, id: i + 2}));
  } else points = rawPoints;
  const sourceItems = question?.best ? [{...question.best, id: 1}, ...points] : points;
  const sources = sourceItems.map(({id, url, title, hostname, quality}) => ({id, url, title, hostname, quality}));
  const fullPages = sourceItems.filter(x => x.quality === 'page').length;
  const method = fullPages === 0 ? 'descriptions' : fullPages === sourceItems.length ? 'pages' : 'mixed';
  const available = !!answer || points.length > 0;
  const note = question ?
    (answer ? (answer.quality === 'page' ?
      'Answer excerpted from an accessible webpage. Read the linked source for full context.' :
      'Answer based on a search-result description; verify the linked source for full context.') :
      'A direct answer could not be verified from available source text. These related excerpts may help.') :
    !available ? 'Not enough reliable text was available to build an extractive summary.' :
    method === 'pages' ? 'Extracted from accessible web pages. Information may be incomplete or out of date.' :
    method === 'mixed' ? 'Uses readable page excerpts and search-result descriptions. Check sources for full context.' :
    'Based on search-result descriptions; the original pages could not be read. Check links for accuracy.';
  return {
    query, isQuestion: !!question, questionKind: question?.kind || null,
    answer, points: points.map(({id, text, quality}) => ({id, text, quality})),
    sources, method, available, note
  };
}

async function summarize(query) {
  query = String(query || '').trim().slice(0, 300);
  if (!query) return buildSummary('', [], new Map());
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return {...hit.value, cached: true};
  const response = await search(query, 0);
  const results = response.results || [];
  // Pages likely to provide readable prose. Avoid video/short-form feeds first.
  const domainSeen = new Set();
  const candidates = [];
  for (const r of results) {
    const url = publicUrl(r.url);
    if (!url) continue;
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (domainSeen.has(host) || /(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com)$/.test(host)) continue;
    domainSeen.add(host);
    candidates.push(url);
    if (candidates.length >= (questionKind(query) === 'reason' ? 6 : 3)) break;
  }
  const pageContent = new Map();
  await Promise.all(candidates.map(async url => {
    try {
      const page = await fetchPage(url);
      if (page && page.paragraphs.length) pageContent.set(url, page);
    } catch { /* Use clearly labelled search descriptions if pages are unavailable. */ }
  }));
  const value = buildSummary(query, results, pageContent);
  cache.set(key, {time: Date.now(), value});
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return value;
}
module.exports = {summarize, _internals: {buildSummary, chooseExtracts, questionKind, answerQuestion, answerCandidates, publicUrl, splitSentences, looksLikeTextPage, scoreSentence, findWhyEvidence, buildWhyAnswer, reasonSentence, whyFocus}};
