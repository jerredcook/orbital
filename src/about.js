// about.js — "what is this?" in the detail panel: a real photo where one
// exists, a one-line description, what the satellite is or was for, when it is
// believed to have stopped working, and a link to read more.
//
// The data is data/about.json — gathered daily from Wikidata and GCAT and
// served with the site (tools/about-data.mjs); loaded the first time something
// is selected.  Photos themselves come from Wikimedia Commons when shown, each
// with its author and licence and a link to its page there.
//
// Everything is written with textContent and fixed-origin URLs: the text comes
// from public, editable sources and is never trusted as markup.

import { loadAbout } from './data.js';
import { decodeAbout, factsText, sentence, commonsImageUrl, commonsPageUrl, wikipediaUrl } from './about-format.js';

export function initAbout({ $ }) {
  const box = $('info-about'), photoLink = $('about-photo-link'), photo = $('about-photo'), credit = $('about-credit');
  let token = 0;   // selections can change while about.json is still loading — only the latest may draw

  function hide() {
    token++;
    box.hidden = true;
    photoLink.hidden = true;
    photo.removeAttribute('src');
  }
  // A photo that fails to load (deleted or renamed on Commons, no connection) just is not shown.
  photo.addEventListener('error', () => { photoLink.hidden = true; credit.textContent = ''; });

  async function show(sat) {
    hide();
    const mine = token;
    const objects = await loadAbout();
    if (mine !== token) return;
    const a = decodeAbout(objects?.[sat.norad]);
    if (!a) return;
    $('about-desc').textContent = sentence(a.desc) ? `${sentence(a.desc)}.` : '';
    $('about-facts').textContent = factsText(a, sat.kind);
    const wiki = $('about-wiki');
    wiki.hidden = !a.wiki;
    if (a.wiki) wiki.href = wikipediaUrl(a.wiki);
    credit.textContent = '';
    if (a.image && a.credit) {
      photo.alt = `Photo of ${sat.name}`;
      photo.src = commonsImageUrl(a.image, 640);
      photoLink.href = commonsPageUrl(a.image);
      photoLink.hidden = false;
      const link = document.createElement('a');
      link.href = commonsPageUrl(a.image); link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Wikimedia Commons';
      credit.append(`Photo: ${a.credit} · `, link);
    }
    // Nothing worth a section (an entry with only an unknown purpose code, say).
    box.hidden = !($('about-desc').textContent || $('about-facts').textContent || a.wiki || !photoLink.hidden);
  }

  return { show, hide };
}
