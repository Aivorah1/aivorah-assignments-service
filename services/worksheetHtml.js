/**
 * HTML handling for Prepare Worksheet documents (routes/worksheets.js).
 *
 *  - sanitizeWorksheetHtml: what the editor sends is cleaned before it is
 *    stored, because a shared document is opened by other teachers. Only
 *    document markup survives (text, headings, lists, tables, images and their
 *    formatting styles); scripts, event handlers, frames and javascript: links
 *    are dropped.
 *  - hostDataImages: images pasted or inserted as data: URIs are moved to
 *    Cloudinary on save, so documents stay small (same idea as
 *    hostEmbeddedImages in routes/assignments.js for uploaded .docx files).
 *  - worksheetDocx: the .docx for Download and Assign. Images from other
 *    websites are fetched here (the browser often cannot, because of CORS)
 *    and embedded; an image that cannot be fetched is left out rather than
 *    failing the whole document.
 */
const dns = require('dns').promises;
const net = require('net');
const sanitizeHtml = require('sanitize-html');

const MAX_HTML_CHARS = 8 * 1024 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10000;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;

// A style value may not load anything (url(), expression()) or run script.
const SAFE_STYLE = /^(?!.*(?:url|expression|javascript|image-set|-moz-binding)\s*[:(])[-\w\s#.,%()"'/+!]*$/i;
const STYLE_PROPS = [
  'color', 'background-color', 'background', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-decoration', 'text-decoration-line', 'text-align', 'line-height', 'vertical-align',
  'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'padding', 'padding-left', 'padding-right',
  'padding-top', 'padding-bottom', 'text-indent', 'width', 'height', 'min-width', 'max-width',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-width',
  'border-style', 'border-collapse', 'list-style-type', 'float', 'display', 'white-space',
];

const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'span', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'font',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre', 'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col', 'caption',
  ],
  allowedAttributes: {
    '*': ['style', 'align'],
    img: ['src', 'alt', 'width', 'height'],
    a: ['href'],
    font: ['color', 'face', 'size'],
    ol: ['start', 'type'],
    table: ['border', 'cellpadding', 'cellspacing', 'width'],
    td: ['colspan', 'rowspan', 'width'],
    th: ['colspan', 'rowspan', 'width'],
    col: ['span', 'width'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  allowedStyles: { '*': Object.fromEntries(STYLE_PROPS.map((p) => [p, [SAFE_STYLE]])) },
  // Office paste leaves <o:p> etc.; drop the tag, keep its text.
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head', 'iframe', 'object', 'embed', 'svg', 'math'],
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  transformTags: {
    img: (tagName, attribs) => {
      const src = String(attribs.src || '').trim();
      // data: only for real raster images (no SVG: it can carry script).
      if (/^data:/i.test(src) && !DATA_IMAGE.test(src)) return { tagName, attribs: { ...attribs, src: '' } };
      return { tagName, attribs };
    },
  },
};

function sanitizeWorksheetHtml(html) {
  return sanitizeHtml(String(html || ''), SANITIZE_OPTIONS).trim();
}

function normalizeTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim();
}

// Returns an error message, or null when the title/html are acceptable.
function validateWorksheet({ title, html }, { requireTitle = true } = {}) {
  if (requireTitle || title !== undefined) {
    const t = normalizeTitle(title);
    if (!t) return 'Enter a file name';
    if (t.length > MAX_TITLE_CHARS) return `File name must be at most ${MAX_TITLE_CHARS} characters`;
  }
  if (html !== undefined && typeof html !== 'string') return 'html must be a string';
  if (typeof html === 'string' && html.length > MAX_HTML_CHARS) return 'This document is too large to save. Try using smaller images.';
  return null;
}

// "Fractions: practice/1" -> "Fractions practice 1.docx"
function docxFileName(title) {
  const base = normalizeTitle(title).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Worksheet';
  return `${base.slice(0, 120)}.docx`;
}

const imgSrcs = (html) => [...String(html).matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi)].map((m) => m[2]);

async function hostDataImages(html, upload) {
  const dataUris = [...new Set(imgSrcs(html).filter((s) => DATA_IMAGE.test(s)))];
  let out = html;
  for (const uri of dataUris) {
    try {
      const url = await upload(uri);
      if (url) out = out.split(uri).join(url);
    } catch { /* keep this image inline: non-fatal */ }
  }
  return out;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

// Only public http(s) hosts: never the server's own network (cloud metadata, localhost).
async function isPublicHttpUrl(src, lookup = dns.lookup) {
  let url;
  try { url = new URL(src); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (net.isIP(host)) return !isPrivateAddress(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 3;

async function fetchImageAsDataUri(src, { fetchImpl = fetch, lookup } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  try {
    // Redirects are followed by hand so every hop is checked, not just the first URL.
    let url = src;
    let res = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!(await isPublicHttpUrl(url, lookup))) return null;
      res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'manual', headers: { Accept: 'image/*' } });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!next) break;
      url = new URL(next, url).href;
      res = null;
    }
    if (!res || !res.ok) return null;
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Every <img> becomes an embedded data: image, or is removed if it cannot be fetched.
async function embedImages(html, opts) {
  const remote = [...new Set(imgSrcs(html).filter((s) => !/^data:/i.test(s)))];
  const resolved = new Map(await Promise.all(remote.map(async (s) => [s, await fetchImageAsDataUri(s, opts)])));
  return String(html).replace(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi, (tag, q, src) => {
    if (DATA_IMAGE.test(src)) return tag;
    const data = resolved.get(src);
    return data ? tag.split(src).join(data) : '';
  });
}

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'blockquote', 'pre', 'caption']);
const CONTAINER_TAGS = new Set([...BLOCK_TAGS, 'ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'col', 'hr', 'img']);
const isBoldStyle = (s) => /(?:^|;)\s*font-weight\s*:\s*(?:bold|bolder|[6-9]00)\b/i.test(s);
const isItalicStyle = (s) => /(?:^|;)\s*font-style\s*:\s*(?:italic|oblique)\b/i.test(s);
const isNormalWeight = (s) => /(?:^|;)\s*font-weight\s*:\s*(?:normal|lighter|[1-4]00)\b/i.test(s);

/**
 * The Word converter reads bold/italic only from <b>/<strong>/<i>/<em>, but
 * text pasted from Google Docs or websites often sets them with
 * style="font-weight:700" / "font-style:italic". Wrap such text in <b>/<i>.
 * Google Docs also wraps a whole paste in <b style="font-weight:normal">,
 * which must not turn everything bold.
 */
function promoteInlineStyles(html) {
  const { parseDocument } = require('htmlparser2');
  const { Element } = require('domhandler');
  const render = require('dom-serializer').default;
  const doc = parseDocument(html);
  const walk = (node) => {
    for (const child of [...(node.children || [])]) walk(child);
    if (node.type !== 'tag') return;
    const style = node.attribs?.style || '';
    if ((node.name === 'b' || node.name === 'strong') && isNormalWeight(style)) {
      const hasBlocks = (node.children || []).some((c) => c.type === 'tag' && CONTAINER_TAGS.has(c.name));
      if (hasBlocks && node.parent) {
        // Unwrap: an inline element around paragraphs would make the converter drop them.
        const siblings = node.parent.children;
        for (const c of node.children) c.parent = node.parent;
        siblings.splice(siblings.indexOf(node), 1, ...node.children);
        return;
      }
      node.name = 'span';
    }
    if (CONTAINER_TAGS.has(node.name) && !BLOCK_TAGS.has(node.name)) return;
    // A block whose children include other blocks/lists/tables is left alone.
    if (BLOCK_TAGS.has(node.name) && (node.children || []).some((c) => c.type === 'tag' && CONTAINER_TAGS.has(c.name))) return;
    const wrap = (tag) => {
      const inner = new Element(tag, {}, node.children);
      for (const c of node.children) c.parent = inner;
      inner.parent = node;
      node.children = [inner];
    };
    if (isItalicStyle(style) && node.name !== 'i' && node.name !== 'em') wrap('i');
    if (isBoldStyle(style) && node.name !== 'b' && node.name !== 'strong') wrap('b');
  };
  walk(doc);
  return render(doc, { encodeEntities: 'utf8' });
}

const A4 = { width: 11906, height: 16838 }; // twips
const MARGIN = 1440; // 1 inch

async function worksheetDocx({ title, html }, opts = {}) {
  const HTMLtoDOCX = require('@turbodocx/html-to-docx');
  const clean = sanitizeWorksheetHtml(html) || '<p></p>';
  const body = await embedImages(promoteInlineStyles(clean), opts);
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title></title></head><body>${body}</body></html>`;
  const buffer = await HTMLtoDOCX(doc, null, {
    title: normalizeTitle(title) || 'Worksheet',
    creator: 'Aivorah',
    orientation: 'portrait',
    pageSize: A4,
    margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN, header: 720, footer: 720, gutter: 0 },
    font: 'Calibri',
    fontSize: 22, // half-points: 11 pt
    table: { row: { cantSplit: true } },
    decodeUnicode: true,
  });
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(await buffer.arrayBuffer());
}

module.exports = {
  MAX_HTML_CHARS, MAX_TITLE_CHARS,
  sanitizeWorksheetHtml, normalizeTitle, validateWorksheet, docxFileName,
  hostDataImages, isPrivateAddress, isPublicHttpUrl, fetchImageAsDataUri, embedImages, promoteInlineStyles, worksheetDocx,
};
