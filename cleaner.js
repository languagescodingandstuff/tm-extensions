// v5.02: scope gate — only prose under ai-response is processed. user-message
//        bubbles, thinking blocks and all other UI are never touched (v5.01
//        and v4 processed user bubbles because the gate was response-block only).
// v5.01 hotfix: fixed SKIP_KEYWORDWORDS typo in shouldSkip (a ReferenceError that
// disabled the extension entirely) and added a full-pipeline test harness.
// TypingMind Extension: clean the assistant's FINAL response only.
// Skips chain-of-thought, tool usage, code blocks, blockquotes and non-Latin scripts.
//
// v5 fixes (vs v4):
//   P0  "Wait — really." now becomes "Wait: really." (no stray space before the colon)
//   P0  Oxford pass is idempotent: clause chains such as "red, white and blue,
//       and they waved" are never touched, so the observer's follow-up pass
//       cannot eat additional commas
//   P1  dash pairing spans inline formatting (<strong>/<em>/<a> split text nodes)
//   P1  pairing scope is one sentence: independent dashes in separate sentences
//       are never fused into a single parenthetical
//   P2  whitespace collapsing runs only in nodes that were actually edited
//   P2  blockquotes skipped; en dashes handled; numeric ranges (2019—2024)
//       preserved as an en dash; unicode-aware word check; literal "( text )"
//       spacing in the source is no longer altered
(function () {
  const MESSAGE_BLOCK_ID = 'response-block';
  const AI_CONTENT_ID = 'ai-response';
  const SKIP_KEYWORDS = ['reason', 'think', 'chain', 'cot', 'reasoning', 'thinking'];
  const COT_CLASS = 'border-l-2';

  const DASH_RE = /[—–―]/;
  const SENTENCE_END = /[.!?…]/;
  const CLOSERS = /["'”’)\]}]/;
  const WS = /\s/;
  const DIGIT = /\d/;

  // Same script ranges as v4's guard regex, expressed as numbers so the
  // ranges can never be mis-encoded.
  const PROTECTED_RANGES = [
    [0x0400, 0x04FF], // Cyrillic
    [0x0600, 0x06FF], // Arabic
    [0x0750, 0x077F], // Arabic Supplement
    [0x08A0, 0x08FF], // Arabic Extended-A
    [0x0900, 0x097F], // Devanagari
    [0x0E00, 0x0E7F], // Thai
    [0x1100, 0x11FF], // Hangul Jamo
    [0x3040, 0x30FF], // Hiragana + Katakana
    [0x3400, 0x4DBF], // CJK Ext-A
    [0x4E00, 0x9FFF], // CJK Unified Ideographs
    [0xAC00, 0xD7AF]  // Hangul Syllables
  ];

  function hasProtectedScript(text) {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      for (let i = 0; i < PROTECTED_RANGES.length; i++) {
        if (cp >= PROTECTED_RANGES[i][0] && cp <= PROTECTED_RANGES[i][1]) return true;
      }
    }
    return false;
  }

  function isWord(ch) {
    return ch !== undefined && ch !== null && /[\p{L}\p{N}]/u.test(ch);
  }

  // Decide for every dash in 'text' whether it opens / closes a parenthetical
  // pair or stands alone. Pairing scope is a single sentence, so two
  // independent dashes in different sentences can never be fused together,
  // and a leftover odd dash becomes "A: B" punctuation.
  function planDashes(text) {
    const chars = text.split('');
    const plan = new Map();

    // classify dashes: numeric ranges are preserved (as an en dash) and
    // excluded from pairing entirely
    const idxs = [];
    for (let i = 0; i < chars.length; i++) {
      if (!DASH_RE.test(chars[i])) continue;
      let p = i - 1;
      while (p >= 0 && WS.test(chars[p])) p--;
      let n = i + 1;
      while (n < chars.length && WS.test(chars[n])) n++;
      const range = p >= 0 && n < chars.length && DIGIT.test(chars[p]) && DIGIT.test(chars[n]);
      if (range) plan.set(i, 'range');
      else idxs.push(i);
    }

    // sentence boundaries: terminal punctuation (+ closing quotes/brackets)
    // followed by whitespace or end of text
    const bounds = [];
    for (let i = 0; i < chars.length; i++) {
      if (!SENTENCE_END.test(chars[i])) continue;
      let j = i + 1;
      while (j < chars.length && CLOSERS.test(chars[j])) j++;
      if (j >= chars.length || WS.test(chars[j])) bounds.push(j);
    }

    // segment id per dash
    const segIds = [];
    let bi = 0;
    for (const d of idxs) {
      while (bi < bounds.length && bounds[bi] <= d) bi++;
      segIds.push(bi);
    }

    // pair within each segment; an odd leftover dash is standalone
    let s = 0;
    while (s < idxs.length) {
      let e = s;
      while (e + 1 < idxs.length && segIds[e + 1] === segIds[s]) e++;
      const count = e - s + 1;
      for (let k = s; k <= e; k++) {
        if (count % 2 === 1 && k === e) plan.set(idxs[k], 'standalone');
        else plan.set(idxs[k], (k - s) % 2 === 0 ? 'open' : 'close');
      }
      s = e + 1;
    }
    return plan;
  }

  const REL_CLAUSE = /^\s*(which|who|whom|whose|that|where|when|after|before|because|although|while|though|if|whether)\b/i;
  const CONJ = /\b(and|or)\b/i;

  function stripOxford(text) {
    return text.replace(/,\s+([^,]+),\s+(and|or)\s+([^,]+)/g, (m, x, conj, y) => {
      if (REL_CLAUSE.test(x)) return m;
      // x already containing a conjunction = a clause chain (or text we have
      // already cleaned), never an Oxford list. This guards both false
      // positives and re-processing by the observer's follow-up pass.
      if (CONJ.test(x)) return m;
      return ', ' + x + ' ' + conj + ' ' + y;
    });
  }

  // texts: prose text nodes of one assistant message, document order, already
  // filtered (no code/pre/button/blockquote/reasoning, no protected script).
  // Returns the cleaned string for each node.
  function cleanMessageTexts(texts) {
    if (!texts.length) return [];

    const full = texts.join('');
    const starts = [];
    let off = 0;
    for (const t of texts) { starts.push(off); off += t.length; }

    const plan = planDashes(full);
    const outputs = [];
    let openPending = false;

    for (let k = 0; k < texts.length; k++) {
      const original = texts[k];
      const out = [];
      const trimPrevSpace = () => {
        if (!outputs.length) return;
        outputs[outputs.length - 1] = outputs[outputs.length - 1].replace(/ +$/, '');
      };

      for (let i = 0; i < original.length; i++) {
        const c = original[i];
        const gi = starts[k] + i;
        if (DASH_RE.test(c)) {
          const kind = plan.get(gi) || 'standalone';
          const gp = gi > 0 ? full[gi - 1] : undefined;
          const gn = gi + 1 < full.length ? full[gi + 1] : undefined;
          if (kind === 'range') {
            out.push('–');                 // keep numeric ranges, just normalise the dash
            openPending = false;
          } else if (kind === 'open') {
            if (isWord(gp)) out.push(' ');
            out.push('(');
            openPending = true;
          } else if (kind === 'close') {
            if (out.length && out[out.length - 1] === ' ') out.pop();
            if (!out.length && gp === ' ') trimPrevSpace();
            out.push(')');
            if (isWord(gn)) out.push(' ');
            openPending = false;
          } else {                          // standalone: "A — B" -> "A: B"
            if (gp === ' ' && gn === ' ') {
              if (out.length && out[out.length - 1] === ' ') out.pop();
              if (!out.length && gp === ' ') trimPrevSpace();
              out.push(':');
            } else if (gp !== ' ' && gn !== ' ') {
              out.push(' ');                // supply the single separator ourselves
            }
            openPending = false;
          }
          continue;
        }
        if (c === ' ' && openPending) continue;   // no space right after a converted "("
        if (c !== ' ') openPending = false;
        out.push(c);
      }

      let result = out.join('');
      result = stripOxford(result);
      // collapse only in nodes we actually edited
      if (result !== original) result = result.replace(/ {2,}/g, ' ');
      outputs.push(result);
    }
    return outputs;
  }

  function shouldSkip(node) {
    let el = node.parentElement;
    while (el) {
      const tag = el.tagName;
      if (tag === 'CODE' || tag === 'PRE' || tag === 'BUTTON' || tag === 'BLOCKQUOTE') return true;
      const cls = (el.className || '').split(/\s+/);
      if (cls.indexOf(COT_CLASS) !== -1) return true;
      const hay = (el.className + ' ' + (el.id || '') + ' ' + (el.getAttribute ? (el.getAttribute('data-element-id') || '') : '')).toLowerCase();
      if (SKIP_KEYWORDS.some(k => hay.includes(k))) return true;
      el = el.parentElement;
    }
    return false;
  }

  function processElement(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (shouldSkip(n)) continue;
      if (hasProtectedScript(n.nodeValue)) continue;
      nodes.push(n);
    }
    if (!nodes.length) return;
    const cleaned = cleanMessageTexts(nodes.map(nd => nd.nodeValue));
    for (let i = 0; i < nodes.length; i++) {
      if (cleaned[i] !== nodes[i].nodeValue) nodes[i].nodeValue = cleaned[i];
    }
  }

  const timers = new WeakMap();
  function schedule(msgEl) {
    if (timers.has(msgEl)) clearTimeout(timers.get(msgEl));
    timers.set(msgEl, setTimeout(() => processElement(msgEl), 600));
  }

  // Role gate (v5.02): walk up from the mutated element; the first ancestor
  // carrying a data-element-id decides the role. Assistant prose lives inside
  // ai-response (within a per-message response-block wrapper); user bubbles
  // carry user-message, thoughts carry thinking-block, and every other UI
  // node carries its own id. Only ai-response qualifies; everything else is
  // ignored (default-deny).
  function findAssistantBlock(el) {
    while (el) {
      const id = el.getAttribute ? el.getAttribute('data-element-id') : null;
      if (id) {
        if (id !== AI_CONTENT_ID) return null;
        let up = el.parentElement;
        while (up) {
          const upId = up.getAttribute ? up.getAttribute('data-element-id') : null;
          if (upId === MESSAGE_BLOCK_ID) return up;
          up = up.parentElement;
        }
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      let el = mut.target;
      if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
      const msg = (el && el.getAttribute) ? findAssistantBlock(el) : null;
      if (msg) schedule(msg);
    }
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
