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

  function cleanText(text) {
    if (!text || hasProtectedScript(text)) return text;
    // Convert only em dash and horizontal bar (en dash and minus are preserved)
    text = text.replace(/[—―]/g, (m, offset, str) => {
      const before = str[offset - 1];
      const after = str[offset + 1];
      return (before === ' ' && after === ' ') ? ': ' : ' ';
    });
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
