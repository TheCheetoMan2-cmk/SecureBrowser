/* Shared Input Summary visibility gate. The search engine itself stays available. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SecureSummarySafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Explicit adult, graphic violence, and other clearly inappropriate queries.
  // Match whole words and short phrases to avoid hiding innocent searches that
  // happen to contain those letters (e.g. "Sussex" or "cocktail").
  const explicit = [
    /^(?:sex|naked|nudity|18\+|adult content)$/i,
    /\b(?:sexual|adult)\s*(?:content|videos?|images?|photos?|scenes?|material|websites?|sites?)\b/i,
    /\b(?:porn|pornography|porno|pornographic|xxx|nsfw|hentai|rule\s*34|r34|onlyfans|camgirl|camgirls|sexcam|sex\s*cam|sex\s*tape|sexual\s*videos?|explicit\s*sex(?:ual)?|hardcore\s*sex|erotic(?:a)?|fetish(?:es)?|striptease|strip\s*clubs?|nudes?|naked\s*(?:pics?|photos?|videos?)|sexting)\b/i,
    /\b(?:fuck|fucking|motherfucker|shit|bullshit|bitch|cunt|dick\s*pics?|pussy\s*pics?)\b/i,
    /\b(?:gore|gory\s*(?:videos?|photos?|footage)|snuff\s*(?:films?|videos?)|beheading\s*(?:videos?|footage)|execution\s*(?:videos?|footage)|real\s*(?:murder|death|killing)\s*(?:videos?|footage)|watch\s*people\s*die)\b/i,
    /\b(?:how\s+to\s+(?:kill\s+myself|commit\s+suicide|self[- ]?harm|make\s+(?:meth|a\s+bomb))|suicide\s*(?:methods?|instructions?)|self[- ]?harm\s*(?:methods?|instructions?)|buy\s+(?:cocaine|heroin|methamphetamine))\b/i,
    /\b(?:best|top|free|watch|download|find|show|see|where\s+to\s+find)\s+(?:sex\s*(?:videos?|clips?|scenes?)|nude\s*(?:photos?|images?|videos?)|graphic\s*(?:violence|deaths?|murders?|torture))\b/i
  ];
  function shouldHideInputSummary(query) {
    const text = String(query == null ? '' : query).normalize('NFKC')
      .replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[_-]+/g,' ')
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) return false;
    return explicit.some(pattern => pattern.test(text));
  }
  return Object.freeze({shouldHideInputSummary});
});
