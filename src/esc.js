// esc.js — HTML-escape a string before it goes into innerHTML.  Satellite names
// and other catalog fields come from an external feed (CelesTrak); if that feed
// were ever poisoned, a name like `<img onerror=…>` would otherwise execute on
// our origin.  Info-panel fields use textContent and don't need this; the list
// rows and toasts build markup by hand and do.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
