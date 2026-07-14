// TypingMind Extension: clean the assistant's FINAL response only.
// Skips chain-of-thought, tool usage and code blocks.
(function () {
  // Verified from the TypingMind DOM: assistant replies use response-block.
  const ASSISTANT_SELECTOR = '[data-element-id="response-block"]';

  // Keywords that mark reasoning / chain-of-thought / thinking elements.
  const SKIP_KEYWORDS = ['reason', 'think', 'chain', 'cot', 'reasoning', 'thinking'];

  // TypingMind renders the chain-of-thought block with this class.
  const COT_CLASS = 'border-l-2';

  function cleanText(text) {
    if (!text) return text;
    // Normalize em/en/horizontal-bar/minus to a colon (if spaced) or space
    text = text.replace(/[—–―−]/g, (m, offset, str) => {
      const before = str[offset - 1];
      const after = str[offset + 1];
      return (before === ' ' && after === ' ') ? ': ' : ' ';
    });
    // Conservative Oxford-comma strip: only the final comma of a series
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
      if (tag === 'CODE' || tag === 'PRE' || tag === 'BUTTON') return true; // code, tool output, tool calls
      const cls = (el.className || '').split(/\s+/);
      if (cls.indexOf(COT_CLASS) !== -1) return true; // chain-of-thought
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
      if (cleaned !== node.nodeValue) node.nodeValue = cleaned; // idempotent
    }
  }

  // Debounce per message so we only act after streaming settles
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
