/**
 * server.js — Secure Browser rewriting reverse proxy
 * ---------------------------------------------------------------------------
 * Runs two ways from the same file:
 *   - Render:    `npm start`                 (listens on PORT, serves /public)
 *   - locally:   `node server.js`            (same routes as Render)
 *
 * What it does for every request to  /proxy?url=<encoded target URL>
 *   1. Validates the target (http/https only, no private / loopback addresses).
 *   2. Fetches it with a real-browser User-Agent. Redirects are NOT followed
 *      automatically; each hop is handed back to the browser through the proxy
 *      so every hop is validated and rewritten.
 *   3. Drops X-Frame-Options, Content-Security-Policy (and friends) from the
 *      response, so the page can live inside our <iframe>.
 *   4. Rewrites the body:
 *        text/html -> JSDOM walk: href / src / srcset / action / poster / ...
 *                     inline style="" and <style> url(...), meta refresh,
 *                     <base href>, plus an injected runtime shim for URLs that
 *                     JavaScript builds on the fly (fetch, XHR, setAttribute...)
 *        text/css  -> url(...) and @import rewritten
 *        anything else (JS, images, fonts, JSON, video) is streamed through.
 *
 * THE PATH-RESOLUTION ENGINE is `toProxyUrl()` below — read that first.
 */
'use strict';

const path = require('path');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const express = require('express');
const axios = require('axios');
const { JSDOM, VirtualConsole } = require('jsdom');

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const PROXY_PATH = '/proxy';
// Render runs a persistent Node server (no serverless response body cap).
// Keep these limits to avoid large remote pages exhausting server memory.
const REQUEST_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 12000;
const MAX_BYTES = 10 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Optional lock-down: ALLOWED_HOSTS="example.com,wikipedia.org" (subdomains match).
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// Response headers that must never reach the browser (framing/CSP killers plus
// headers that no longer describe the rewritten body or would leak third-party
// state onto our origin).
const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'report-to',
  'nel',
  'x-xss-protection',
  'strict-transport-security',
  'public-key-pins',
  'alt-svc',
  'link',
  'set-cookie', // third-party cookies must not be set on the proxy origin
  'content-length', // recomputed by Express
  'content-encoding', // Axios already decompressed the body
  'transfer-encoding',
  'connection',
  'keep-alive',
  'etag', // body may be rewritten, validators would lie
  'content-range',
]);

// ----------------------------------------------------------------------------
// SSRF protection (this is an open fetcher — it must not reach your network)
// ----------------------------------------------------------------------------
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || // CGNAT
    (p[0] === 169 && p[1] === 254) || // link-local + cloud metadata
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
    p[0] >= 224 // multicast / reserved
  );
}

function isPrivateIPv6(ip) {
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::') return true;
  if (l.startsWith('::ffff:')) {
    const v4 = l.slice(7);
    return net.isIPv4(v4) ? isPrivateIPv4(v4) : true; // hex-form mapped: refuse
  }
  return /^(fc|fd|fe[89ab]|ff)/.test(l); // ULA, link-local, multicast
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

/**
 * DNS lookup used by the HTTP agents. Validating at connect time (instead of
 * resolving once up front) also defeats DNS-rebinding tricks.
 */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    for (const entry of list) {
      if (isPrivateIp(entry.address)) {
        const e = new Error('Blocked: target resolves to a private address');
        e.code = 'EBLOCKED';
        return callback(e);
      }
    }
    return callback(null, address, family);
  });
}

const httpAgent = new http.Agent({ lookup: safeLookup, keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ lookup: safeLookup, keepAlive: true, maxSockets: 32 });

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function assertSafeTarget(raw, selfHost) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw httpError(400, 'The url parameter is not a valid absolute URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw httpError(400, 'Only http and https URLs can be proxied.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host) && isPrivateIp(host)) throw httpError(403, 'Blocked address.');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/.test(host)) throw httpError(403, 'Blocked host.');
  if (selfHost && u.host.toLowerCase() === selfHost.toLowerCase()) {
    throw httpError(400, 'Refusing to proxy the proxy.');
  }
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    throw httpError(403, 'This host is not on the allow-list.');
  }
  return u;
}

// ----------------------------------------------------------------------------
// PATH-RESOLUTION ENGINE
// ----------------------------------------------------------------------------
/**
 * toProxyUrl(raw, base)
 *
 * Turns ANY URL found in a page into a URL that goes back through this proxy.
 *
 *   raw   the attribute / CSS value exactly as written in the source:
 *           "style.css"            (document-relative)
 *           "/img/logo.png"        (root-relative)
 *           "../a/b.js"            (parent-relative)
 *           "//cdn.example.com/x"  (protocol-relative)
 *           "https://other.com/y"  (absolute)
 *           "?page=2"              (query-only)
 *   base  the ABSOLUTE URL the browser would use to resolve `raw`:
 *           the page's final URL, or its <base href> if it had one, or for CSS
 *           files the URL of the stylesheet itself.
 *
 * Steps:
 *   1. Leave non-fetchable schemes alone (javascript:, data:, blob:, mailto:,
 *      tel:, about:) and pure fragments ("#top").
 *   2. `new URL(raw, base)` runs the standard WHATWG resolution algorithm, so
 *      every relative form above becomes one absolute URL using the *target
 *      site's* origin — never ours. This is the key step: without it,
 *      "/img/logo.png" would hit the proxy host instead of the target site.
 *   3. Keep the #fragment OUTSIDE the encoded value so in-page anchors still
 *      work after proxying.
 *   4. Emit  /proxy?url=<percent-encoded absolute URL>.
 *
 * Already-proxied values are detected and returned untouched, which makes the
 * rewriter idempotent.
 */
function toProxyUrl(raw, base) {
  if (raw === null || raw === undefined) return raw;
  const value = String(raw).trim();
  if (!value || value.startsWith('#')) return raw;
  if (/^(javascript:|data:|blob:|mailto:|tel:|sms:|about:|file:)/i.test(value)) return raw;
  if (value.startsWith(PROXY_PATH + '?')) return raw; // already proxied

  let absolute;
  try {
    absolute = new URL(value, base); // <- resolution against the TARGET origin
  } catch {
    return raw; // unparsable: leave it
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return raw;

  const fragment = absolute.hash;
  absolute.hash = '';
  return PROXY_PATH + '?url=' + encodeURIComponent(absolute.href) + fragment;
}

/** srcset="a.jpg 1x, b.jpg 2x" -> every candidate URL proxied. */
function rewriteSrcset(value, base) {
  // Note: assumes candidate URLs contain no literal commas (true in practice).
  return value
    .split(',')
    .map((part) => {
      const t = part.trim();
      if (!t) return t;
      const i = t.search(/\s/);
      const url = i === -1 ? t : t.slice(0, i);
      const descriptor = i === -1 ? '' : t.slice(i);
      return toProxyUrl(url, base) + descriptor;
    })
    .join(', ');
}

/** Rewrites url(...) and @import "..." inside any CSS text. */
function rewriteCss(css, base) {
  return css
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => '@import ' + q + toProxyUrl(u, base) + q)
    .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (m, q, u) => {
      const out = toProxyUrl(u, base);
      return out === u ? m : 'url("' + out + '")';
    });
}

/**
 * Resolve literal JavaScript module imports relative to their original script
 * URL, not the Netlify function URL. This addresses a common reason dynamic
 * search sites show bare HTML with no hydrated styling or features.
 * Non-literal dynamic imports still require the site to be compatible with a
 * reverse proxy; they cannot be resolved safely from the response alone.
 */
function rewriteJavaScriptModules(source, scriptUrl) {
  const rewrite = (quoted) => {
    const quote = quoted[0];
    const literal = quoted.slice(1, -1);
    if (!/^(?:\.{1,2}\/|\/|https?:\/\/|\/\/)/i.test(literal)) return quoted;
    const out = toProxyUrl(literal, scriptUrl);
    return quote + out.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote) + quote;
  };
  // import X from '...'; export X from '...'; import '...'
  source = source.replace(/\b(?:import|export)\s*(?:[^;()\n]*?\s*from\s*)?(['"])([^'"\r\n]+)\1/g,
    (whole, q, literal) => whole.slice(0, whole.lastIndexOf(q + literal + q)) + rewrite(q + literal + q));
  // import('...'), import ( '...' )
  source = source.replace(/\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
    (whole, q, literal) => whole.replace(q + literal + q, rewrite(q + literal + q)));
  return source;
}

// ----------------------------------------------------------------------------
// Runtime shim injected into every HTML page.
// Static rewriting cannot see URLs that scripts build at runtime, so this patches
// the browser APIs that create requests. (String.raw keeps the regex escapes;
// do not use backticks or dollar-brace inside it.)
// ----------------------------------------------------------------------------
const SHIM_SOURCE = String.raw`
(function () {
  'use strict';
  var BASE = __BASE__;
  var PREFIX = '/proxy?url=';
  var SKIP = /^\s*(javascript:|data:|blob:|about:|mailto:|tel:|sms:|#)/i;

  function isProxied(s) {
    return s.indexOf('/proxy?') === 0 || s.indexOf(location.origin + '/proxy?') === 0;
  }
  function wrap(u) {
    if (u === null || u === undefined) return u;
    var s = String(u);
    if (!s || SKIP.test(s) || isProxied(s)) return u;
    try {
      var abs = new URL(s, BASE);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
      var hash = abs.hash;
      abs.hash = '';
      return PREFIX + encodeURIComponent(abs.href) + hash;
    } catch (e) { return u; }
  }

  // fetch()
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || (window.URL && input instanceof URL)) input = wrap(input);
        else if (input && input.url) input = new Request(wrap(input.url), input);
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
  }

  // XMLHttpRequest
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = wrap(url);
    return _open.apply(this, args);
  };

  // window.open, sendBeacon, history
  var _wopen = window.open;
  window.open = function (u) {
    var args = Array.prototype.slice.call(arguments);
    if (args[0]) args[0] = wrap(args[0]);
    return _wopen.apply(window, args);
  };
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { return _beacon(wrap(u), d); };
  }
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function (state, title, url) { return orig.call(this, state, title, url ? wrap(url) : url); };
  });

  // el.src = ..., a.href = ..., form.action = ...
  function patchProp(proto, prop) {
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { d.set.call(this, wrap(v)); }
    });
  }
  [
    [window.HTMLImageElement, 'src'], [window.HTMLScriptElement, 'src'],
    [window.HTMLLinkElement, 'href'], [window.HTMLAnchorElement, 'href'],
    [window.HTMLIFrameElement, 'src'], [window.HTMLSourceElement, 'src'],
    [window.HTMLMediaElement, 'src'], [window.HTMLEmbedElement, 'src'],
    [window.HTMLFormElement, 'action']
  ].forEach(function (p) { if (p[0]) patchProp(p[0].prototype, p[1]); });

  // el.setAttribute('src', ...)
  var URL_ATTR = { src: 1, href: 1, action: 1, poster: 1, 'data-src': 1 };
  var _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (URL_ATTR[String(name).toLowerCase()] && this.tagName !== 'BASE') value = wrap(value);
    return _setAttr.call(this, name, value);
  };

  // Markup injected via innerHTML / insertAdjacentHTML
  function fix(el) {
    if (!el || el.nodeType !== 1) return;
    ['src', 'href', 'action', 'poster'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (v) { var w = wrap(v); if (w !== v) _setAttr.call(el, a, w); }
    });
  }

  // Modern sites add preload links, images and styles dynamically. The
  // original shim only handled some of those, leaving the rest at / on Netlify.
  function fixNode(el) {
    if (!el || el.nodeType !== 1) return;
    ['src', 'href', 'action', 'poster', 'background', 'data-src', 'data-href', 'srcset'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (!v) return;
      var w = a === 'srcset' ? v.split(',').map(function (x) {
        var t = x.trim(), i = t.search(/\s/);
        return wrap(i < 0 ? t : t.slice(0, i)) + (i < 0 ? '' : t.slice(i));
      }).join(', ') : wrap(v);
      if (w !== v) _setAttr.call(el, a, w);
    });
    var style = el.getAttribute('style');
    if (style && /url\(/i.test(style)) {
      var converted = style.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, function (all, q, u) {
        var out = wrap(u); return out === u ? all : 'url("' + out + '")';
      });
      if (converted !== style) _setAttr.call(el, 'style', converted);
    }
  }
  // A GET form cannot submit directly to /proxy?url= because the browser
  // replaces that query when sending its own inputs. Build the destination's
  // URL first, then navigate through the proxy as a whole.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.tagName !== 'FORM' || event.defaultPrevented) return;
    if ((form.method || 'get').toLowerCase() !== 'get') return;
    try {
      var action = form.getAttribute('action') || BASE;
      var destination;
      if (action === '/proxy' && form.elements.namedItem('__pt')) {
        destination = new URL(form.elements.namedItem('__pt').value);
      } else if (isProxied(action)) {
        destination = new URL(new URL(action, location.href).searchParams.get('url'));
      } else {
        destination = new URL(action, BASE);
      }
      if (!/^https?:$/.test(destination.protocol)) return;
      var params = new URLSearchParams(new FormData(form));
      params.delete('__pt');
      params.forEach(function (v, k) { destination.searchParams.append(k, v); });
      event.preventDefault();
      location.assign(wrap(destination.href));
    } catch (e) { /* allow standard form submission on unexpected markup */ }
  }, false);

  // Style tags created through JavaScript can contain URLs to the original
  // website; the server never saw them to rewrite them.
  function fixStyleTag(el) {
    if (!el || el.tagName !== 'STYLE' || !el.textContent || !/url\(/i.test(el.textContent)) return;
    var old = el.textContent;
    var newText = old.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, function (all, q, u) {
      var out = wrap(u); return out === u ? all : 'url("' + out + '")';
    });
    if (newText !== old) el.textContent = newText;
  }
  new MutationObserver(function(records) {
    records.forEach(function(record) {
      if (record.type === 'childList') {
        record.addedNodes.forEach(function(node) {
          if (node.nodeType === 1) {
            fixNode(node); fixStyleTag(node);
            if (node.querySelectorAll) node.querySelectorAll('[src],[href],[action],[poster],[style],[srcset],style').forEach(function(el) {
              fixNode(el); fixStyleTag(el);
            });
          } else if (node.nodeType === 3 && node.parentElement && node.parentElement.tagName === 'STYLE') {
            fixStyleTag(node.parentElement);
          }
        });
      }
    });
  }).observe(document.documentElement, {childList: true, subtree: true});

  // iOS standalone apps: never rewrite or proxy YouTube links the user taps.
  // Use the original window.open, captured above, to avoid the proxy wrapper.
  document.addEventListener('click', function(e){
    var a=e.target.closest && e.target.closest('a[href]');
    if(!a || !((navigator.standalone===true)||(window.matchMedia && matchMedia('(display-mode: standalone)').matches)))return;
    if(!(/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)))return;
    try{
      var href=a.href, link=new URL(href,location.href);
      if(link.pathname==='/proxy' && link.searchParams.has('url'))href=link.searchParams.get('url');
      var target=new URL(href,BASE);
      if(target.protocol!=='https:'||!(/(^|\.)youtube\.com$/.test(target.hostname)||target.hostname==='youtu.be'||/(^|\.)youtube-nocookie\.com$/.test(target.hostname)))return;
      e.preventDefault();e.stopImmediatePropagation();
      var opened=_wopen.call(window,target.href,'_blank');
      if(!opened)parent.postMessage({type:'secure-browser:youtube-external',url:target.href},'*');
    }catch(err){}
  },true);

  // Tell the parent browser UI where we really are (for its address bar).
  function notify() {
    try { parent.postMessage({ type: 'secure-browser:navigated', url: BASE, title: document.title }, '*'); } catch (e) {}
  }
  // Zero-reload Readable view.  We KEEP the original page in this frame, but
  // display a self-contained, script-free snapshot in a shadow root when CSS
  // has failed, or when the person presses the toolbar's Reader button.
  // The parent browser provides the actual navigation bar; we add no header.
  var ssReaderHost = null;
  var ssReaderWasAutomatic = false;
  var ssReading = false;
  var ssReaderRestoreOverflow = '';
  var ssReaderScheduled = false;
  var ssReaderUserOverride = false;
  var ssLastBrokenCheck = 0;
  var SS_BAD = { SCRIPT:1, STYLE:1, LINK:1, META:1, NOSCRIPT:1,
    NAV:1, ASIDE:1, HEADER:1, FOOTER:1, IFRAME:1, OBJECT:1, EMBED:1,
    FORM:1, INPUT:1, BUTTON:1, SELECT:1, TEXTAREA:1, SVG:1, CANVAS:1,
    VIDEO:1, AUDIO:1, TEMPLATE:1, SOURCE:1, PICTURE:0 };
  var SS_OK = { DIV:1, SECTION:1, ARTICLE:1, MAIN:1, P:1,
    H1:1, H2:1, H3:1, H4:1, H5:1, H6:1,
    UL:1, OL:1, LI:1, A:1, IMG:1, TABLE:1, THEAD:1, TBODY:1,
    TR:1, TD:1, TH:1, PRE:1, CODE:1, BLOCKQUOTE:1, STRONG:1,
    EM:1, B:1, I:1, SMALL:1, SPAN:1, FIGURE:1, FIGCAPTION:1,
    BR:1, HR:1, DL:1, DT:1, DD:1, TIME:1, DETAILS:1, SUMMARY:1 };

  function ssMainContent() {
    var amazon = /(^|\.)amazon\.(com|ca|co\.uk|de|fr|es|it|co\.jp|com\.au)$/i.test(new URL(BASE).hostname);
    var selectors = amazon ? [
      '#dp-container', '#ppd', '#centerCol', '#dp', '#search',
      '[data-component-type="s-search-result"]', 'main', '#main-content',
      '[role="main"]', 'article'
    ] : [
      '#mw-content-text', 'main article', 'article', '[role="main"]',
      'main', '#content', '#main-content', '#page-content', '.content'
    ];
    for (var i = 0; i < selectors.length; ++i) {
      try {
        var n = document.querySelector(selectors[i]);
        if (n && (n.textContent || '').trim().length >= 120) return n;
      } catch (e) {}
    }
    return document.body || document.documentElement;
  }
  function ssPickImage(img) {
    var candidates = ['data-old-hires', 'data-src', 'data-original',
      'data-lazy-src', 'data-image-src','src'];
    for (var i=0;i<candidates.length;i++) {
      var raw=img.getAttribute(candidates[i]);
      if (!raw || /^data:image\/gif;base64,R0lGOD/i.test(raw)) continue;
      try { var u = String(wrap(raw));
        if (u && (/^\/proxy\?url=/.test(u) || /^https?:\/\//.test(u) || /^data:image\//.test(u))) return u;
      } catch(e) {}
    }
    // Amazon often keeps the real image URL only in its dynamic-image map.
    try {
      var sizes = JSON.parse(img.getAttribute('data-a-dynamic-image') || '{}');
      var urls = Object.keys(sizes);
      if (urls.length) return String(wrap(urls[urls.length-1]));
    } catch(e) {}
    return '';
  }
  function ssCopyReadable(node, target, limit) {
    if (limit.nodes >= 3500 || limit.text >= 140000) return;
    if (node.nodeType === 3) {
      var txt = (node.nodeValue || '').replace(/\s+/g,' ');
      if (txt.trim() && limit.text < 140000) {
        target.appendChild(document.createTextNode(txt.slice(0,140000-limit.text)));
        limit.text += txt.length;
      }
      return;
    }
    if (node.nodeType !== 1 || SS_BAD[node.tagName] || node.id === 'secureReaderOverlay') return;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return;
    var tag = node.tagName;
    var parent = target;
    if (SS_OK[tag]) {
      var child = document.createElement(tag.toLowerCase());
      if (tag === 'A') {
        var href=node.getAttribute('href');
        if (href && !/^javascript:|^data:/i.test(href)) {
          child.setAttribute('href',String(wrap(href)));
          child.setAttribute('target','_self');
          child.setAttribute('rel','noopener noreferrer');
        }
      } else if (tag === 'IMG') {
        var src=ssPickImage(node);
        if (!src) return;
        child.setAttribute('src',src);
        child.setAttribute('alt',node.getAttribute('alt')||'');
        child.setAttribute('loading','lazy');
        child.setAttribute('decoding','async');
        child.setAttribute('referrerpolicy','no-referrer');
      } else if (tag === 'TD' || tag === 'TH') {
        ['colspan','rowspan'].forEach(function(key) {
          var n=Number(node.getAttribute(key));
          if(n>=2 && n<=15)child.setAttribute(key,String(n));
        });
      }
      target.appendChild(child); parent=child; limit.nodes++;
    }
    if (tag === 'IMG' || tag === 'BR' || tag === 'HR') return;
    var children = node.childNodes;
    for (var i=0;i<children.length && limit.nodes<3500 && limit.text<140000;i++) ssCopyReadable(children[i],parent,limit);
  }
  function ssReaderStyles() {
    return ':host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;'+
      'display:block!important;overflow:auto!important;overscroll-behavior:contain!important;'+
      'color-scheme:light dark!important;background:#f7f8fa!important;color:#1d2633!important;'+
      'font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif!important}'+
      '*,*::before,*::after{box-sizing:border-box}'+
      '.ss-article{max-width:980px;margin:0 auto;padding:24px clamp(16px,4vw,38px) 90px;'+
      'overflow-wrap:anywhere;word-break:normal}'+
      'h1,h2,h3,h4,h5,h6{font-family:inherit;line-height:1.28;letter-spacing:-.012em;color:inherit}'+
      'h1{font-size:clamp(27px,4vw,39px);margin:12px 0 24px}'+
      'h2{font-size:24px;margin-top:28px;border-bottom:1px solid #dce1e8;padding-bottom:7px}'+
      'h3{font-size:19px;margin-top:22px}p{margin:9px 0 15px}'+
      'a{color:#155fbe;text-decoration:none}a:hover{text-decoration:underline}'+
      'img{max-width:100%;height:auto;max-height:440px;object-fit:contain;margin:9px 0;border-radius:7px}'+
      'ul,ol{padding-left:25px}li{padding:3px 0}'+
      'table{max-width:100%;display:block;overflow-x:auto;border-collapse:collapse;font-size:14px}'+
      'td,th{border:1px solid #d5dce6;padding:7px 10px;vertical-align:top}'+
      'pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:13px;background:#eceff5;border-radius:8px}'+
      'blockquote{margin:18px 0;border-left:3px solid #b9c7db;padding:4px 16px}'+
      '.ss-site{font-size:12px;color:#647084;margin:0 0 7px}.ss-empty{color:#758198}'+
      '@media(prefers-color-scheme:dark){:host{background:#171b22!important;color:#e8ecf4!important}'+
      '.ss-site,.ss-empty{color:#adb4c3}h2{border-color:#333d4b}a{color:#8bb9ff}'+
      'pre{background:#282d37}td,th{border-color:#404853}}';
  }
  function ssShowReader(on,automatic) {
    if (!on) {
      if (ssReaderHost) { ssReaderHost.remove(); ssReaderHost=null; }
      if (ssReading) document.documentElement.style.overflow=ssReaderRestoreOverflow;
      ssReading=false;ssReaderWasAutomatic=false;
      return;
    }
    if (ssReading || !document.body || !document.documentElement) return;
    try {
      var content=ssMainContent();
      var host=document.createElement('div');
      host.id='secureReaderOverlay';
      var shadow=host.attachShadow({mode:'open'});
      var sheet=document.createElement('style');sheet.textContent=ssReaderStyles();
      var article=document.createElement('div');article.className='ss-article';
      var source=document.createElement('div');source.className='ss-site';
      try{source.textContent=new URL(BASE).hostname.replace(/^www\./,'');}catch(e){}
      article.appendChild(source);
      var heading=document.createElement('h1');
      var existing=content.querySelector('h1');
      heading.textContent=(existing && existing.textContent.trim() || document.title || 'Readable page').slice(0,160);
      if (!existing) article.appendChild(heading);
      var fragment=document.createDocumentFragment();
      ssCopyReadable(content,fragment,{nodes:0,text:0});
      if ((fragment.textContent||'').trim().length < 40) {
        var empty=document.createElement('p');empty.className='ss-empty';
        empty.textContent='This website did not provide enough readable content. Try opening it in your device browser.';
        article.appendChild(empty);
      } else article.appendChild(fragment);
      shadow.appendChild(sheet);shadow.appendChild(article);
      ssReaderRestoreOverflow=document.documentElement.style.overflow;
      document.documentElement.style.overflow='hidden';
      document.documentElement.appendChild(host);
      ssReaderHost=host;ssReading=true;ssReaderWasAutomatic=!!automatic;
      if (automatic) parent.postMessage({type:'secure-browser:unstyled',url:BASE},'*');
    } catch(err) { console.warn('Secure Browser readable overlay unavailable',err); }
  }

  // Reader is optional only. Never auto-replace a failed website.
  // Detect failed style/script/image requests and report the actual problem.
  var failures = { stylesheet:0, script:0, image:0, other:0 };
  var reported = false;
  function reportBroken() {
    if (reported || !failures.stylesheet && failures.script < 3) return;
    reported = true;
    try { parent.postMessage({type:'secure-browser:assets-failed',url:BASE,failures:failures},'*'); }
    catch (_) {}
  }
  document.addEventListener('error', function (event) {
    var n=event.target;
    if (!n || n===window) return;
    var tag=String(n.tagName||'').toLowerCase();
    if(tag==='link' && /stylesheet/i.test(n.rel||'')) failures.stylesheet++;
    else if(tag==='script') failures.script++;
    else if(tag==='img') failures.image++;
    else failures.other++;
    if(failures.stylesheet || failures.script>=3) queueMicrotask(reportBroken);
  }, true);
  document.addEventListener('DOMContentLoaded', notify);
  window.addEventListener('load', notify);
  if(document.readyState==='interactive'||document.readyState==='complete') notify();
  // No automatic or manual reader replacement; broken pages use Safari fallback.
  // Check high-confidence stylesheet failures after the page is settled.
  window.addEventListener('load',function() {
    setTimeout(function(){
      try {
        var links=document.querySelectorAll('link[rel~="stylesheet"]');
        if(links.length < 2)return;
        var usable=Array.prototype.some.call(document.styleSheets,function(sheet){
          try { return sheet.cssRules.length>0; } catch(_) { return true; }
        });
        if(!usable && document.querySelectorAll('body *').length>=25){
          parent.postMessage({type:'secure-browser:layout-broken',url:BASE},'*');
        }
      }catch(_){}
    },900);
  });
})();
`;

function buildShim(baseUrl) {
  const safeBase = JSON.stringify(baseUrl).replace(/</g, '\\u003c');
  return SHIM_SOURCE.replace('__BASE__', safeBase);
}

// ----------------------------------------------------------------------------
// HTML rewriting (JSDOM)
// ----------------------------------------------------------------------------
const URL_ATTRS = ['href', 'src', 'action', 'poster', 'background', 'data-src', 'data-original', 'data-href', 'xlink:href'];
const SRCSET_ATTRS = ['srcset', 'data-srcset'];

function rewriteHtml(html, pageUrl) {
  // Scripts are NOT executed (no runScripts option) and nothing is fetched.
  const dom = new JSDOM(html, { url: pageUrl, contentType: 'text/html', virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;

  // 1. Effective base: <base href> beats the page URL, then the tag is removed
  //    (we resolve everything ourselves, and a leftover <base> would break the
  //    proxied URLs we are about to write).
  let base = pageUrl;
  const baseEl = doc.querySelector('base[href]');
  if (baseEl) {
    try {
      base = new URL(baseEl.getAttribute('href'), pageUrl).href;
    } catch {
      /* keep pageUrl */
    }
    baseEl.remove();
  }

  // 2. Things that would re-impose the restrictions we are removing, or that
  //    would make the browser connect straight to third parties.
  doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
    const v = (m.getAttribute('http-equiv') || '').toLowerCase();
    if (v === 'content-security-policy' || v === 'x-frame-options' || v === 'content-type') m.remove();
  });
  doc.querySelectorAll('meta[charset]').forEach((m) => m.remove());
  doc.querySelectorAll('link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel~="prefetch"]').forEach((l) => l.remove());

  // 3. Walk every element once.
  [...doc.querySelectorAll('*'), ...[...doc.querySelectorAll('template')].flatMap((t) => [...t.content.querySelectorAll('*')])].forEach((el) => {
    const tag = el.tagName.toLowerCase();

    // <script>/<link> integrity hashes break when we rewrite CSS; nonces are
    // meaningless without the CSP header.
    if (tag === 'script' || tag === 'link') {
      el.removeAttribute('integrity');
      el.removeAttribute('nonce');
      el.removeAttribute('crossorigin');
    }

    // Forms. A GET form REPLACES the action's query string on submit, which
    // would wipe "?url=". So: action="/proxy" + a hidden __pt field holding the
    // real destination; the server merges the typed fields back into it.
    if (tag === 'form') {
      const method = (el.getAttribute('method') || 'get').toLowerCase();
      const rawAction = el.getAttribute('action') || '';
      if (!/^javascript:/i.test(rawAction)) {
        if (method === 'get') {
          try {
            const dest = new URL(rawAction || base, base);
            if (dest.protocol === 'http:' || dest.protocol === 'https:') {
              el.setAttribute('action', PROXY_PATH);
              const hidden = doc.createElement('input');
              hidden.setAttribute('type', 'hidden');
              hidden.setAttribute('name', '__pt');
              hidden.setAttribute('value', dest.href);
              el.insertBefore(hidden, el.firstChild);
            }
          } catch {
            /* leave it */
          }
        } else {
          el.setAttribute('action', toProxyUrl(rawAction || base, base));
        }
      }
    }

    // href / src / poster / data-src ...
    for (const attr of URL_ATTRS) {
      if (tag === 'form' && attr === 'action') continue;
      const v = el.getAttribute(attr);
      if (v) el.setAttribute(attr, toProxyUrl(v, base));
    }
    if (tag === 'object' && el.hasAttribute('data')) el.setAttribute('data', toProxyUrl(el.getAttribute('data'), base));

    // srcset on <img>/<source>
    for (const attr of SRCSET_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) el.setAttribute(attr, rewriteSrcset(v, base));
    }

    // inline style="background:url(...)"
    const style = el.getAttribute('style');
    if (style && /url\(/i.test(style)) el.setAttribute('style', rewriteCss(style, base));

    // <style> blocks
    if (tag === 'style' && el.textContent) el.textContent = rewriteCss(el.textContent, base);

    // Browsers resolve import-map paths against the hosting origin, not the
    // original document. Rewrite URL entries before the JS loader sees them.
    if (tag === 'script' && (el.getAttribute('type')||'').toLowerCase()==='importmap') {
      try {
        const map=JSON.parse(el.textContent||'{}');
        const fixEntries=(o)=>{if(!o || typeof o!=='object')return;
          for(const [k,v] of Object.entries(o)) {
            if(typeof v==='string' && /^(?:\.{1,2}\/|\/|https?:\/\/|\/\/)/i.test(v))o[k]=toProxyUrl(v,base);
          }
        };
        fixEntries(map.imports);
        if(map.scopes && typeof map.scopes==='object') {
          const next={};
          for(const imports of Object.values(map.scopes)) fixEntries(imports);
          for(const [key,imports] of Object.entries(map.scopes)) {
            const fixed=/^(?:\.{1,2}\/|\/|https?:\/\/|\/\/)/i.test(key)?toProxyUrl(key,base):key;
            next[fixed]=imports;
          }
          map.scopes=next;
        }
        el.textContent=JSON.stringify(map);
      } catch (_) { /* leave malformed maps untouched */ }
    }

    // <meta http-equiv="refresh" content="3; url=/next">
    if (tag === 'meta' && /refresh/i.test(el.getAttribute('http-equiv') || '')) {
      const c = el.getAttribute('content') || '';
      el.setAttribute('content', c.replace(/(url\s*=\s*)(['"]?)([^'"]+)\2/i, (m, p, q, u) => p + q + toProxyUrl(u, base) + q));
    }
  });

  // 4. Charset (we always re-encode as UTF-8) + runtime shim, first thing in <head>.
  const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  const shim = doc.createElement('script');
  shim.textContent = buildShim(base);
  head.insertBefore(shim, head.firstChild);
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.insertBefore(charset, head.firstChild);

  return dom.serialize();
}

/** Decode bytes using the charset from the Content-Type header (default UTF-8). */
function decodeBody(buffer, contentType) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  try {
    return new TextDecoder(m ? m[1] : 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// ----------------------------------------------------------------------------
// Express app
// ----------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
// Render checks this endpoint before accepting public traffic.
app.get('/healthz', (_req, res) => res.status(200).json({ok:true,service:'secure-browser'}));
// Isolated (opaque-origin) iframes need explicit CORS for fetch/XHR and fonts.
// Only the sandboxed null origin is granted cross-origin access; never expose
// internal service tokens or website cookies through this public proxy.
app.use((req,res,next)=>{
  if(req.path==='/proxy'||req.path==='/.netlify/functions/proxy'){
    if(req.headers.origin==='null'){
      res.setHeader('Access-Control-Allow-Origin','null');
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept, Range, X-Requested-With, Authorization');
    }
    res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
    if(req.method==='OPTIONS')return res.status(204).end();
  }
  next();
});

// Local development: serve the browser UI. (On Netlify the CDN serves /public.)
// Secure Search owns its results UI and ranking. It does not iframe third-party search pages.
const secureSearch = require('./search-core');
app.get('/api/search', async (req,res)=>{
 res.set('Cache-Control','public, max-age=40');
 try{res.json(await secureSearch.search(req.query.q,req.query.page));}
 catch(e){res.status(503).json({results:[],sources:[],message:'Search temporarily unavailable.'});}
});
// Input Summary: short, source-linked extracts. Loaded independently from search results.
const inputSummary = require('./summary-core');
const summaryEligibility = require('./public/summary-eligibility');
app.get('/api/summary', async (req,res)=>{
 if(summaryEligibility.shouldHideInputSummary(req.query.q)){
  res.set('Cache-Control','no-store');
  return res.json({suppressed:true,points:[],sources:[],available:false});
 }
 res.set('Cache-Control','public, max-age=90');
 try{res.json(await inputSummary.summarize(req.query.q));}
 catch(e){res.status(503).json({points:[],sources:[],available:false,note:'Summary temporarily unavailable.'});}
});
app.get('/api/media',async(req,res)=>{
 res.set('Cache-Control','public, max-age=60, stale-while-revalidate=180');
 try{res.json(await require('./media-core').media(req.query.kind,req.query.q,req.query.page));}
 catch(e){res.status(503).json({items:[],message:'Media search temporarily unavailable.'});}
});
app.get('/api/suggest', async (req,res)=>{
 res.set('Cache-Control','public, max-age=20');
 try{res.json(await secureSearch.suggest(req.query.q));}
 catch(e){res.json({suggestions:[]});}
});
// YouTube watch/feed/channel metadata, with optional official API key.
const youtubeService = require('./youtube-core');
app.get('/api/youtube', async (req,res)=>{
 res.set('Cache-Control','public, max-age=90');
 try {res.json(await youtubeService.handler(req.query));}
 catch(e) {res.status(503).json({error:'YouTube data temporarily unavailable',items:[]});}
});
app.use(express.static(path.join(__dirname, 'public')));

// Fast, styled, deliberately script-free reader fallback for hard-to-proxy pages.
// It preserves actual article text, links, and images, but not the site's custom UI.
const READER_CSS = `:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:#f8f9fb;color:#1e2532;font:17px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px max(18px,calc((100vw - 880px)/2));background:#fff;border-bottom:1px solid #e4e6eb;box-shadow:0 2px 8px #1111}.brand{font:700 15px system-ui;color:#47576d}.actions a{display:inline-block;padding:5px 8px;color:#245fbb;font:13px system-ui;text-decoration:none}.wrap{max-width:880px;padding:19px 22px 90px;margin:auto}.source{font:13px system-ui;color:#718096;margin-bottom:10px;word-break:break-all}h1,h2,h3,h4,h5,h6{font-family:system-ui,sans-serif;line-height:1.22;letter-spacing:-.02em}h1{font-size:clamp(29px,5vw,40px);margin:8px 0 26px}h2{font-size:26px;margin-top:38px;border-bottom:1px solid #e0e4eb;padding-bottom:6px}h3{font-size:20px}a{color:#245fb7;text-decoration:none}a:hover{text-decoration:underline}p{margin:13px 0 19px}img{display:block;max-width:100%;height:auto;margin:12px 0;border-radius:6px}figure{margin:25px 0;color:#697587;font-size:14px}li{margin:7px 0}pre,code{background:#eef0f4;border-radius:5px}pre{padding:16px;white-space:pre-wrap;overflow-wrap:anywhere}code{font-size:.88em;padding:2px 4px}blockquote{border-left:4px solid #c5d4ef;padding:6px 20px;margin:22px 0;color:#5e6675}table{width:100%;display:block;overflow-x:auto;border-collapse:collapse;font-size:15px}td,th{border:1px solid #dce1e8;padding:7px 10px;text-align:left}button,input{font:inherit}.notice{padding:15px;border:1px solid #d7dfeb;border-radius:12px;background:#fff;color:#48576d}@media(prefers-color-scheme:dark){body{background:#15181f;color:#e6e9ef}header{background:#1e222a;border-color:#303844}.brand{color:#a7b6d0}.source{color:#99a7b8}a{color:#9ebdff}h2{border-color:#383d46}pre,code{background:#292d36}td,th{border-color:#424a54}.notice{background:#202630;border-color:#485063;color:#bac5d6}}`;
function htmlEsc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
const READ_TAGS = new Set(['DIV','SECTION','ARTICLE','MAIN','P','H1','H2','H3','H4','H5','H6','UL','OL','LI','A','IMG','TABLE','THEAD','TBODY','TR','TD','TH','PRE','CODE','BLOCKQUOTE','STRONG','EM','B','I','SUP','SUB','SPAN','FIGURE','FIGCAPTION','HR','DETAILS','SUMMARY','DL','DT','DD','BR','SMALL','TIME','ABBR']);
const DISCARD_TAGS=new Set(['SCRIPT','STYLE','LINK','META','NOSCRIPT','IFRAME','OBJECT','EMBED','FORM','BUTTON','INPUT','SELECT','TEXTAREA','CANVAS','SVG','MATH','VIDEO','AUDIO','NAV','ASIDE','FOOTER','HEADER']);
function cleanReaderContent(src,pageUrl,output){
 for(const child of [...src.childNodes]){
  if(child.nodeType===3){output.appendChild(output.ownerDocument.createTextNode(child.nodeValue));continue;}
  if(child.nodeType!==1||DISCARD_TAGS.has(child.tagName))continue;
  if(!READ_TAGS.has(child.tagName)){cleanReaderContent(child,pageUrl,output);continue;}
  const el=output.ownerDocument.createElement(child.tagName.toLowerCase());
  if(child.tagName==='A'){
   const href=child.getAttribute('href');try{const u=new URL(href,pageUrl);if(/^https?:$/.test(u.protocol)){el.setAttribute('href',u.href);el.setAttribute('rel','noreferrer noopener');}}
   catch{};
  }
  if(child.tagName==='IMG'){
   const raw=child.getAttribute('src')||child.getAttribute('data-src');
   try{const u=new URL(raw,pageUrl);if(u.protocol==='https:'||u.protocol==='http:'){el.setAttribute('src',u.href);el.setAttribute('loading','lazy');el.setAttribute('referrerpolicy','no-referrer');}}
   catch{};
   el.setAttribute('alt',child.getAttribute('alt')||'');
  }
  if(['TD','TH'].includes(child.tagName)){for(const a of ['colspan','rowspan']){const v=Number(child.getAttribute(a));if(v>1&&v<20)el.setAttribute(a,String(v));}}
  cleanReaderContent(child,pageUrl,el);output.appendChild(el);
 }
}
function makeReaderHtml(html,pageUrl){
 const source=new JSDOM(html,{url:pageUrl,virtualConsole:new VirtualConsole()}).window.document;
 const target=new JSDOM('<!doctype html><html><body><div id="out"></div></body></html>').window.document;
 const title=(source.querySelector('h1')?.textContent||source.title||new URL(pageUrl).hostname).trim().slice(0,180);
 const candidates=['#mw-content-text .mw-parser-output','#mw-content-text','#bodyContent','.mw-body-content','main article','article','[role="main"]','main','#content','#main-content'];
 let content=null;for(const selector of candidates){const found=source.querySelector(selector);if(found && found.textContent.trim().length>130){content=found;break;}}
 if(!content)content=source.body;
 cleanReaderContent(content,pageUrl,target.getElementById('out'));
 const markup=target.getElementById('out').innerHTML.slice(0,1800000);
 const safeUrl=htmlEsc(pageUrl),safeTitle=htmlEsc(title);
 const script=`document.addEventListener('click',function(e){const a=e.target.closest('a[href]');if(!a)return;try{const u=new URL(a.href);if(!/^https?:$/.test(u.protocol))return;e.preventDefault();parent.postMessage({type:'secure-browser:reader-navigate',url:u.href,newTab:!!(e.ctrlKey||e.metaKey||e.shiftKey)},location.origin)}catch(err){}},true);`;
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+safeTitle+' · Reader</title><style>'+READER_CSS+'</style></head><body><div class="wrap"><div class="source">'+safeUrl+'</div><h1>'+safeTitle+'</h1>'+ (markup||'<div class="notice">Could not extract readable content from this page. Use Original site instead.</div>')+'</div><script>'+script+'</scr'+'ipt></body></html>';
}
async function handleReader(req,res){
 try{
  const url=assertSafeTarget(req.query.url,req.headers.host);
  const response=await axios.get(url.href,{headers:{'User-Agent':USER_AGENT,Accept:'text/html,application/xhtml+xml','Accept-Language':'en-US,en;q=0.9'},responseType:'arraybuffer',timeout:6500,maxContentLength:2*1024*1024,maxRedirects:0,validateStatus:()=>true,httpAgent,httpsAgent});
  if(response.status>=300&&response.status<400&&response.headers.location){const redirected=new URL(response.headers.location,url);assertSafeTarget(redirected.href,req.headers.host);return res.redirect(302,'/reader?url='+encodeURIComponent(redirected.href));}
  const type=String(response.headers['content-type']||'');
  if(response.status>=400||!(/html/i.test(type)))throw httpError(502,'This site did not return a readable HTML page.');
  res.set('Cache-Control','public, max-age=60, s-maxage=180');
  res.set('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: http: data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
  res.type('html').send(makeReaderHtml(decodeBody(Buffer.from(response.data),type),url.href));
 }catch(err){sendError(res,err);}
}
// Reader route disabled: use real Safari links instead.

// POST/PUT bodies are forwarded byte-for-byte.
const rawBody = express.raw({ type: () => true, limit: '5mb' });

function resolveTarget(req) {
  const query = new URLSearchParams(req.url.split('?')[1] || '');
  // GET forms rewritten by rewriteHtml(): destination in __pt, typed fields in the rest.
  if (query.has('__pt')) {
    const dest = new URL(query.get('__pt')); // throws on junk -> 400 below
    query.delete('__pt');
    query.forEach((value, key) => dest.searchParams.append(key, value));
    return dest.href;
  }
  return query.get('url');
}

app.all([PROXY_PATH, '/.netlify/functions/proxy'], rawBody, async (req, res) => {
  try {
    let targetRaw;
    try {
      targetRaw = resolveTarget(req);
    } catch {
      throw httpError(400, 'Bad form target.');
    }
    if (!targetRaw) throw httpError(400, 'Missing ?url= parameter.');
    const target = assertSafeTarget(targetRaw, req.headers.host);

    const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: req.headers.accept || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      Referer: target.origin + '/',
    };
    if (req.headers.range) headers.Range = req.headers.range;
    if (hasBody) {
      headers['Content-Type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
      headers.Origin = target.origin;
    }

    const upstream = await axios.request({
      url: target.href,
      method: req.method,
      headers,
      data: hasBody ? req.body : undefined,
      responseType: 'arraybuffer',
      transformResponse: (d) => d,
      maxRedirects: 0, // we re-validate every hop ourselves
      validateStatus: () => true, // pass 4xx/5xx through to the browser
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      decompress: true,
      httpAgent,
      httpsAgent,
    });

    // Redirects: send the browser to the proxied version of the next hop.
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.location) {
      res.status(upstream.status).set('Location', toProxyUrl(upstream.headers.location, target.href)).end();
      return;
    }

    // Copy headers, minus the framing/CSP killers (see STRIP_RESPONSE_HEADERS).
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
    }
    res.removeHeader('X-Frame-Options'); // belt and braces: the contract of this proxy
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const contentType = String(upstream.headers['content-type'] || '').toLowerCase();
    const fileExt = path.posix.extname(target.pathname).toLowerCase();
    const isStyleFile = fileExt === '.css' && !contentType.includes('text/html');
    const isScriptFile = (fileExt === '.js' || fileExt === '.mjs') && !contentType.includes('text/html');
    const body = Buffer.from(upstream.data);

    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      const html = rewriteHtml(decodeBody(body, contentType), target.href);
      res.status(upstream.status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' }).send(html);
    } else if (contentType.includes('text/css') || isStyleFile) {
      const css = rewriteCss(decodeBody(body, contentType), target.href); // base = the stylesheet's own URL
      if(req.method==='GET' && upstream.status===200)res.setHeader('Cache-Control','public, max-age=1200, s-maxage=86400, stale-while-revalidate=604800');
      res.status(upstream.status).set('Content-Type', 'text/css; charset=utf-8').send(css);
    } else if (/javascript|ecmascript/i.test(contentType) || isScriptFile) {
      const script = rewriteJavaScriptModules(decodeBody(body, contentType), target.href);
      if(req.method==='GET' && upstream.status===200)res.setHeader('Cache-Control','public, max-age=600, s-maxage=21600, stale-while-revalidate=86400');
      res.status(upstream.status).set('Content-Type', 'application/javascript; charset=utf-8').send(script);
    } else {
      if(req.method==='GET' && upstream.status===200 && /^(?:image\/|font\/|audio\/|video\/|application\/(?:font|octet-stream))/.test(contentType))res.setHeader('Cache-Control','public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      res.status(upstream.status).send(body);
    }
  } catch (err) {
    sendError(res, err);
  }
});

function sendError(res, err) {
  let status = err.status || 502;
  let message = err.message || 'Upstream error';
  if (err.code === 'EBLOCKED') [status, message] = [403, 'Blocked: that address is not allowed.'];
  else if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') [status, message] = [504, 'The target site took too long to respond.'];
  else if (/maxContentLength/i.test(message)) [status, message] = [413, 'The target response is too large for this proxy.'];
  else if (err.code === 'ENOTFOUND') [status, message] = [502, 'Could not resolve that host name.'];
  const esc = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res
    .status(status)
    .type('html')
    .send(
      '<!doctype html><meta charset="utf-8"><title>Proxy error</title>' +
        '<script>try{var q=new URLSearchParams(location.search);parent.postMessage({type:"secure-browser:proxy-error",url:q.get("url")},"*")}catch(e){}</script>' +
        '<body style="font:16px system-ui;background:#0f1115;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">' +
        '<div style="max-width:480px;text-align:center"><h2>Couldn’t load this page</h2><p style="color:#9aa3b2">' +
        esc +
        '</p></div></body>'
    );
}

module.exports = app;
module.exports._internals = { toProxyUrl, rewriteCss, rewriteJavaScriptModules, rewriteSrcset, rewriteHtml, isPrivateIp, assertSafeTarget, buildShim, makeReaderHtml };

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log('Secure Browser ready on 0.0.0.0:' + PORT));
}
