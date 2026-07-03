// palette.js — the display palette shared across the tracker: orbit-regime
// colours for the swarm + legend, the selection highlight, and the conjunction
// red.  CAT_CSS is the same set as CSS strings for the 2D overhead sky chart.

import { Color } from 'cesium';

// Display categories: the four orbit regimes for payloads, DEB for debris.
export const CAT_COLORS = {
  LEO: Color.fromCssColorString('#5EC8E5'),
  MEO: Color.fromCssColorString('#C9A0FF'),
  GEO: Color.fromCssColorString('#FFD166'),
  HEO: Color.fromCssColorString('#FF8C66'),
  DEB: Color.fromCssColorString('#8B93A1'),
};
export const SELECT_COLOR = Color.fromCssColorString('#FFB454');
export const CONJ_COLOR = Color.fromCssColorString('#FF4D5E');
export const CAT_CSS = Object.fromEntries(Object.entries(CAT_COLORS).map(([k, v]) => [k, v.toCssColorString()]));
