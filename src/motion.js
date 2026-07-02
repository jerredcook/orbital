// motion.js — honour prefers-reduced-motion for the scripted camera flights.
// CSS transitions are already disabled by the media query in style.css, but the
// Cesium flyTo swoops (full-viewport 3D motion, the classic vestibular trigger)
// are scripted with fixed durations; route them through fly() so a reduced-
// motion user gets an instant cut instead.
const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
export const flySeconds = (s) => (mq?.matches ? 0 : s);
