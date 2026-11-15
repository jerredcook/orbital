// palette.js — the display palette shared across the tracker: orbit-regime
// colours for the swarm + legend, the selection highlight, and the conjunction
// red.  CAT_CSS is the same set as CSS strings for the 2D overhead sky chart.

import { Color } from 'cesium';

// Display categories (catalog-parse.js categoryOf): the four orbit regimes for
// ACTIVE satellites, then what else is up there — inactive satellites, spent
// rocket bodies, debris.  The last three are deliberately quieter than the
// regime colours: they are the background the working satellites fly through.
export const CAT_COLORS = {
  LEO: Color.fromCssColorString('#5EC8E5'),
  MEO: Color.fromCssColorString('#C9A0FF'),
  GEO: Color.fromCssColorString('#FFD166'),
  HEO: Color.fromCssColorString('#FF8C66'),
  DEAD: Color.fromCssColorString('#D98BA5'),
  RB: Color.fromCssColorString('#9BB86F'),
  DEB: Color.fromCssColorString('#8B93A1'),
};
// Dot size in the swarm, by category.
export const CAT_SIZE = { LEO: 2.2, MEO: 2.2, GEO: 2.2, HEO: 2.2, DEAD: 1.9, RB: 1.9, DEB: 1.7 };
export const SELECT_COLOR = Color.fromCssColorString('#FFB454');
export const CONJ_COLOR = Color.fromCssColorString('#FF4D5E');
export const CAT_CSS = Object.fromEntries(Object.entries(CAT_COLORS).map(([k, v]) => [k, v.toCssColorString()]));
