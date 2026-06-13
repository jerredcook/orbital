// surface.js — landing sites pinned on the body globes.
//
// When you descend to a surface (Mars/Mercury via Treks, the Moon via moon.js,
// Venus via its map), these mark where things have touched down, at their real
// coordinates: crewed missions in gold, rovers in orange, landers in cyan.  The
// markers depth-test against the globe, so far-side sites hide as you rotate.

import {
  Cartesian3, Color, Cartesian2, LabelStyle, VerticalOrigin, NearFarScalar,
} from 'cesium';

const KIND_COLOR = {
  crewed: '#FFD166',   // human landings
  rover: '#FF8C5A',    // mobile robots
  lander: '#6FE0FF',   // stationary landers / sample return / impactors
};

// [name, latitude °, east longitude °, kind].
export const SURFACE = {
  Mars: [
    ['Viking 1', 22.48, 312.05, 'lander'], ['Viking 2', 47.97, 134.26, 'lander'],
    ['Pathfinder', 19.10, 326.75, 'lander'], ['Spirit', -14.57, 175.48, 'rover'],
    ['Opportunity', -1.95, 354.47, 'rover'], ['Phoenix', 68.22, 234.30, 'lander'],
    ['Curiosity', -4.59, 137.44, 'rover'], ['InSight', 4.50, 135.62, 'lander'],
    ['Perseverance', 18.44, 77.45, 'rover'], ['Zhurong', 25.07, 109.93, 'rover'],
  ],
  Moon: [
    ['Apollo 11', 0.67, 23.47, 'crewed'], ['Apollo 12', -3.01, -23.42, 'crewed'],
    ['Apollo 14', -3.65, -17.47, 'crewed'], ['Apollo 15', 26.13, 3.63, 'crewed'],
    ['Apollo 16', -8.97, 15.50, 'crewed'], ['Apollo 17', 20.19, 30.77, 'crewed'],
    ['Luna 2', 29.10, 0.0, 'lander'], ['Surveyor 1', -2.47, -43.34, 'lander'],
    ['Lunokhod 1', 38.24, -35.00, 'rover'], ['Chang’e 3', 44.12, -19.51, 'lander'],
    ['Chang’e 4', -45.45, 177.60, 'lander'], ['Chang’e 5', 43.06, -51.92, 'lander'],
    ['Chandrayaan-3', -69.37, 32.32, 'lander'],
  ],
  Venus: [
    ['Venera 9', 31.01, 291.64, 'lander'], ['Venera 13', -7.50, 303.00, 'lander'],
    ['Venera 14', -13.25, 310.19, 'lander'],
  ],
};

export function addSurfaceMarkers(viewer, ellipsoid, sites) {
  if (!sites) return;
  const R = ellipsoid.maximumRadius;
  const h = R * 0.004;
  const markers = [];
  for (const [name, lat, lon, kind] of sites) {
    const color = Color.fromCssColorString(KIND_COLOR[kind] || KIND_COLOR.lander);
    const position = Cartesian3.fromDegrees(lon, lat, h, ellipsoid);
    const entity = viewer.entities.add({
      name,
      position,
      point: {
        pixelSize: 7, color,
        outlineColor: Color.BLACK.withAlpha(0.6), outlineWidth: 1,
        // Draw on top of the globe (which otherwise depth-occludes surface
        // markers); far-side ones are hidden by the horizon cull below.  Use a
        // large finite distance — Cesium quietly drops Infinity here.
        disableDepthTestDistance: 1e15,
      },
      label: {
        text: name,
        font: '500 12px Inter, system-ui, sans-serif',
        fillColor: color, style: LabelStyle.FILL_AND_OUTLINE,
        outlineColor: Color.fromCssColorString('#05070C').withAlpha(0.9), outlineWidth: 2.5,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -8),
        disableDepthTestDistance: 1e15,
        translucencyByDistance: new NearFarScalar(R * 0.5, 1.0, R * 4, 0.0),
      },
    });
    markers.push({ entity, dir: Cartesian3.normalize(position, new Cartesian3()) });
  }

  // Horizon cull: a surface point is visible when the angle from the sub-camera
  // point is within the horizon, i.e. dot(point̂, camerâ) > R / |camera|.  Hides
  // far-side sites (and their always-on-top labels) as you rotate the globe.
  const camDir = new Cartesian3();
  viewer.scene.preRender.addEventListener(() => {
    const cam = viewer.camera.positionWC;
    const limb = R / Cartesian3.magnitude(cam);
    Cartesian3.normalize(cam, camDir);
    for (const m of markers) m.entity.show = Cartesian3.dot(m.dir, camDir) > limb;
  });
}
