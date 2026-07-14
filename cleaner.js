// TypingMind Extension: clean the assistant's FINAL response only.
// Skips chain-of-thought, tool usage, code blocks and non-Latin scripts.
(function () {
  const ASSISTANT_SELECTOR = '[data-element-id="response-block"]';

  const SKIP_KEYWORDS = ['reason', 'think', 'chain', 'cot', 'reasoning', 'thinking'];
  const COT_CLASS = 'border-l-2';

  // Preserve text containing non-Latin scripts (CJK, Japanese, Korean,
  // Arabic, Cyrillic, Devanagari, Thai, Hangul, etc.) so meaning is never lost.
  function hasProtectedScript(text) {
    return /[\u0400-\u04FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u097F\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(text);
  }

  // Convert em dashes and horizontal bars. Paired dashes become parentheses;
  // a lone (unpaired) dash becomes a colon if space-surrounded, else a space.
  function convertDashes(text) {
    const chars = [...text];
    const total = chars.filter(c => c === '—' || c === '―').length;
    let dashCount = 0;
    const out = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === '—' || c === '―') {
        dashCount++;
        if (dashCount === total && total % 2 === 1) {
          const before = chars[i - 1];
          const after = chars[i + 1];
          out.push((before === ' ' && after === ' ') ? ': ' : ' ');
        } else if (dashCount % 2 === 1) {
          out.push('(');
        } else {
          if (out.length && out[out.length - 1] === ' ') out.pop();
          out.push(')');
        }
      } else {
        out.push(c);
      }
    }
    return out.join('');
  }

  function cleanText(text) {
    if (!text || hasProtectedScript(text)) return text;
    text = convertDashes(text);
    // Conservative Oxford-comma strip (English only, by conjunction match)
    text = text.replace(
      /,(\s+)([A-Za-z0-9][\w'-]*),(\s+)(and|or)\s+([A-Za-z0-9][\w'-]*)/g,
      (_, s1, a, s2, conj, b) => `,${s1}${a}${s2}${conj} ${b}`
    );
    return text.replace(/ {2,}/g, ' ');
  }

  function shouldSkip(node) {
    let el = node.parentElement;
    while (el) {
      const tag = el.tagName;
      if (tag === 'CODE' || tag === 'PRE' || tag === 'BUTTON') return true;
      const cls = (el.className || '').split(/\s+/);
      if (cls.indexOf(COT_CLASS) !== -1) return true;
      const hay = (el.className + ' ' + (el.id || '') + ' ' +
        (el.getAttribute ? (el.getAttribute('data-element-id') || '') : '')).toLowerCase();
      if (SKIP_KEYWORDS.some(k => hay.includes(k))) return true;
      el = el.parentElement;
    }
    return false;
  }

  function processElement(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      if (shouldSkip(node)) continue;
      const cleaned = cleanText(node.nodeValue);
      if (cleaned !== node.nodeValue) node.nodeValue = cleaned;
    }
  }

  const timers = new WeakMap();
  function schedule(msgEl) {
    if (timers.has(msgEl)) clearTimeout(timers.get(msgEl));
    timers.set(msgEl, setTimeout(() => processElement(msgEl), 600));
  }

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      let el = mut.target;
      if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
      const msg = (el && el.closest) ? el.closest(ASSISTANT_SELECTOR) : null;
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
