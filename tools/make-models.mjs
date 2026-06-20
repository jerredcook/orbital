// make-models.mjs — generates the generic spacecraft GLBs in public/models/.
//
//   node tools/make-models.mjs
//
// Real spacecraft (ISS, Hubble, Terra, …) use NASA's published models;
// everything else gets a class-appropriate generic built here: a comms/EO
// bus with solar wings, a Starlink-style flat-panel, a spent rocket stage,
// and a debris fragment.  Output is binary glTF 2.0 with embedded
// procedurally-generated PBR textures — crinkled MLI foil, solar-cell
// grids, brushed metal — so the close-up view reads as hardware, not
// blocks.  Y-up, meters.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- png ------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function pngEncode(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- textures ----

const TEX_SIZE = 512;

// Seamless multi-octave value noise on a wrapping grid.
function makeFbm(seed, gridN = 8) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const grids = [];
  for (let o = 0; o < 4; o++) {
    const n = gridN << o;
    const g = new Float64Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    grids.push({ n, g });
  }
  const sample = ({ n, g }, u, v) => {
    const x = ((u % 1) + 1) % 1 * n, y = ((v % 1) + 1) % 1 * n;
    const x0 = Math.floor(x) % n, y0 = Math.floor(y) % n;
    const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const fx = x - Math.floor(x), fy = y - Math.floor(y);
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = g[y0 * n + x0] * (1 - sx) + g[y0 * n + x1] * sx;
    const b = g[y1 * n + x0] * (1 - sx) + g[y1 * n + x1] * sx;
    return a * (1 - sy) + b * sy;
  };
  return (u, v) => {
    let acc = 0, amp = 0.5;
    for (const grid of grids) { acc += amp * sample(grid, u, v); amp /= 2; }
    return acc / 0.9375; // normalize to ~[0,1]
  };
}

function genTexture(fn) {
  const w = TEX_SIZE, h = TEX_SIZE;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y, x / w, y / h);
      const i = (y * w + x) * 4;
      rgba[i] = Math.max(0, Math.min(255, r));
      rgba[i + 1] = Math.max(0, Math.min(255, g));
      rgba[i + 2] = Math.max(0, Math.min(255, b));
      rgba[i + 3] = 255;
    }
  }
  return pngEncode(w, h, rgba);
}

// Gold multi-layer insulation: shiny crinkled foil.  Real MLI is a reflective
// gold sheet that puckers into a web of folds, each crease throwing a bright
// specular glint — not a flat brown blanket.  Broad slow shading sets the lay
// of the sheet; sharp ridged noise carves the fold lines and spikes their
// brightness; a fine octave adds the crinkle.  Highlights desaturate toward
// pale gold the way thin metal does.
const foilPng = (() => {
  const lay = makeFbm(1234, 6);
  const folds = makeFbm(5678, 22);
  const crinkle = makeFbm(4321, 44);
  return genTexture((x, y, u, v) => {
    const shade = 0.5 + 0.95 * (lay(u * 1.7, v * 1.7) - 0.5);    // sheet undulation
    const fr = Math.abs(2 * folds(u * 5.2, v * 5.2) - 1);        // 0 along a fold
    const ridge = Math.pow(1 - fr, 5);                           // bright glint at folds
    const valley = Math.pow(fr, 2.2);                            // shadowed flats between folds
    const fine = 0.16 * (crinkle(u * 11, v * 11) - 0.5);
    let l = 0.5 + 0.5 * shade + 0.85 * ridge - 0.2 * valley + fine;
    l = Math.max(0.16, Math.min(1.5, l));
    return [205 * l + 56 * ridge, 158 * l + 44 * ridge, 70 * l + 24 * ridge];
  });
})();

// Solar array: cell grid with silver gridlines, busbars, per-cell sheen.
const solarPng = (() => {
  const fbm = makeFbm(31415);
  const CELL = 32;
  return genTexture((x, y) => {
    const cx = x % CELL, cy = y % CELL;
    if (cx < 2 || cy < 2) return [128, 136, 152];          // gridline
    if (cx === Math.floor(CELL / 2)) return [88, 94, 112]; // busbar
    const cellId = Math.floor(x / CELL) + Math.floor(y / CELL) * 8;
    const jitter = 0.9 + 0.2 * ((cellId * 2654435761 >>> 16 & 255) / 255);
    const sheen = 1 + 0.5 * ((cx + cy) / (2 * CELL));
    const n = 0.92 + 0.16 * fbm(x / TEX_SIZE * 4, y / TEX_SIZE * 4);
    const k = jitter * sheen * n;
    return [11 * k, 19 * k, 52 * k * 1.15];
  });
})();

// Painted radiator white with faint panel seams.
const whitePng = (() => {
  const fbm = makeFbm(2718);
  return genTexture((x, y, u, v) => {
    if (x % 64 === 0 || y % 64 === 0) return [196, 200, 206];
    const n = 0.97 + 0.06 * fbm(u * 6, v * 6);
    return [223 * n, 227 * n, 231 * n];
  });
})();

// Brushed aluminum, streaks along U.
const metalPng = (() => {
  const fbm = makeFbm(1618, 16);
  return genTexture((x, y, u, v) => {
    const streak = fbm(u * 1.2, v * 24);
    const n = 0.82 + 0.3 * streak;
    return [172 * n, 177 * n, 184 * n];
  });
})();

// Scorched nozzle: blotchy heat discoloration.
const scorchPng = (() => {
  const fbm = makeFbm(9092);
  return genTexture((x, y, u, v) => {
    const blotch = fbm(u * 3, v * 3);
    const hot = Math.max(0, blotch - 0.62) * 2.2;     // bluish heat tint
    const n = 0.55 + 0.7 * blotch;
    return [74 * n + 22 * hot, 64 * n + 14 * hot, 58 * n + 34 * hot];
  });
})();

const TEXTURES = [
  { name: 'foil', png: foilPng },
  { name: 'solar', png: solarPng },
  { name: 'white', png: whitePng },
  { name: 'metal', png: metalPng },
  { name: 'scorch', png: scorchPng },
];
const TEX_INDEX = Object.fromEntries(TEXTURES.map((t, i) => [t.name, i]));

// ------------------------------------------------------------ palette ------
// tex is a texture name or null; color multiplies the texture (tinting lets
// the brushed-metal texture serve both bright alu and dark structure).

const MATERIALS = [
  { name: 'mli-foil', tex: 'foil', color: [1, 1, 1], metallic: 0.55, roughness: 0.3 },
  { name: 'alu', tex: 'metal', color: [1, 1, 1], metallic: 0.8, roughness: 0.38 },
  { name: 'solar-cell', tex: 'solar', color: [1, 1, 1], metallic: 0.45, roughness: 0.24, emissive: [0.012, 0.02, 0.05] },
  { name: 'radiator', tex: 'white', color: [1, 1, 1], metallic: 0.06, roughness: 0.6 },
  { name: 'dark-metal', tex: 'metal', color: [0.3, 0.31, 0.34], metallic: 0.95, roughness: 0.55 },
  { name: 'scorched', tex: 'scorch', color: [1, 1, 1], metallic: 0.5, roughness: 0.78 },
];
const M = Object.fromEntries(MATERIALS.map((m, i) => [m.name, i]));

// Texture repeats once per this many meters (solar pitch ≈ 8 cells/repeat).
const TEX_METERS = { foil: 1.1, solar: 1.5, white: 2.2, metal: 1.6, scorch: 1.0 };
const texMeters = (mat) => TEX_METERS[MATERIALS[mat].tex] ?? 1;

// ---------------------------------------------------------- mesh builder ---

class Builder {
  constructor() { this.prims = new Map(); }

  prim(mat) {
    if (!this.prims.has(mat)) this.prims.set(mat, { pos: [], nrm: [], uv: [], idx: [] });
    return this.prims.get(mat);
  }

  tri(mat, a, b, c, uvs) {
    const p = this.prim(mat);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const base = p.pos.length / 3;
    const k = texMeters(mat);
    const fallback = [[a[0] / k, a[2] / k], [b[0] / k, b[2] / k], [c[0] / k, c[2] / k]];
    [a, b, c].forEach((v, i) => {
      p.pos.push(...v);
      p.nrm.push(nx, ny, nz);
      p.uv.push(...(uvs?.[i] ?? fallback[i]));
    });
    p.idx.push(base, base + 1, base + 2);
  }

  quad(mat, a, b, c, d, uvs) {
    this.tri(mat, a, b, c, uvs && [uvs[0], uvs[1], uvs[2]]);
    this.tri(mat, a, c, d, uvs && [uvs[0], uvs[2], uvs[3]]);
  }

  // Quad with UVs sized from its world dimensions, so texel density is
  // uniform regardless of face size.
  quadAuto(mat, a, b, c, d) {
    const k = texMeters(mat);
    const w = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / k;
    const h = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]) / k;
    this.quad(mat, a, b, c, d, [[0, 0], [w, 0], [w, h], [0, h]]);
  }

  box(mat, [cx, cy, cz], [w, h, d]) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    this.quadAuto(mat, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
    this.quadAuto(mat, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -Z
    this.quadAuto(mat, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +X
    this.quadAuto(mat, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
    this.quadAuto(mat, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +Y
    this.quadAuto(mat, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -Y
  }

  // Cylinder along +Y, radii r0 (bottom) → r1 (top), smooth side normals.
  cylinder(mat, [cx, cy, cz], r0, r1, y0, y1, seg = 32) {
    const p = this.prim(mat);
    const k = texMeters(mat);
    const ring = (y, r) => Array.from({ length: seg + 1 }, (_, i) => {
      const t = (i / seg) * Math.PI * 2;
      return [cx + r * Math.cos(t), cy + y, cz + r * Math.sin(t)];
    });
    const bot = ring(y0, r0), top = ring(y1, r1);
    const slope = Math.atan2(r0 - r1, y1 - y0);
    const circ = Math.PI * (r0 + r1);
    for (let i = 0; i < seg; i++) {
      const base = p.pos.length / 3;
      const verts = [bot[i], bot[i + 1], top[i + 1], top[i]];
      const us = [i / seg, (i + 1) / seg, (i + 1) / seg, i / seg];
      const vs = [y0 / k, y0 / k, y1 / k, y1 / k];
      verts.forEach((vert, j) => {
        const t = ((j === 1 || j === 2 ? i + 1 : i) / seg) * Math.PI * 2;
        p.nrm.push(Math.cos(t) * Math.cos(slope), Math.sin(slope), Math.sin(t) * Math.cos(slope));
        p.pos.push(...vert);
        p.uv.push(us[j] * circ / k, vs[j]);
      });
      p.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    for (let i = 1; i < seg - 1; i++) {
      this.tri(mat, [cx, cy + y1, cz], top[i + 1], top[i]);
      this.tri(mat, [cx, cy + y0, cz], bot[i], bot[i + 1]);
    }
  }

  // Jagged fragment: icosahedron with seeded radial displacement, flat faces.
  fragment(mat, [cx, cy, cz], r, seed, rough = 0.5) {
    let s = seed;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const t = (1 + Math.sqrt(5)) / 2;
    const raw = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ].map((v) => {
      const l = Math.hypot(...v);
      const k = (r / l) * (1 - rough / 2 + rand() * rough);
      return [cx + v[0] * k * (0.6 + rand() * 0.5), cy + v[1] * k, cz + v[2] * k * (0.7 + rand() * 0.4)];
    });
    const F = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2],
      [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5],
      [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for (const [a, b, c] of F) this.tri(mat, raw[a], raw[b], raw[c]);
  }

  // A solar panel segment: cell face both sides, silver frame, rear struts.
  solarPanel(center, [w, d], frame = 0.05) {
    const [cx, cy, cz] = center;
    const t = 0.024;                               // panel thickness
    this.box(M['solar-cell'], center, [w, t, d]);
    const f = M.alu;
    this.box(f, [cx - w / 2 + frame / 2, cy, cz], [frame, t * 1.6, d]);
    this.box(f, [cx + w / 2 - frame / 2, cy, cz], [frame, t * 1.6, d]);
    this.box(f, [cx, cy, cz - d / 2 + frame / 2], [w - 2 * frame, t * 1.6, frame]);
    this.box(f, [cx, cy, cz + d / 2 - frame / 2], [w - 2 * frame, t * 1.6, frame]);
    this.box(M['dark-metal'], [cx, cy - t, cz], [0.05, 0.02, d * 0.9]); // rear stiffener
  }
}

// -------------------------------------------------------------- writer -----

function writeGlb(path, builder) {
  const json = {
    asset: { version: '2.0', generator: 'orbital make-models' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [] }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [],
    textures: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };

  const chunks = [];
  let byteOffset = 0;
  const addView = (buf, target) => {
    const pad = (4 - (byteOffset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); byteOffset += pad; }
    const view = { buffer: 0, byteOffset, byteLength: buf.length };
    if (target) view.target = target;
    json.bufferViews.push(view);
    chunks.push(buf); byteOffset += buf.length;
    return json.bufferViews.length - 1;
  };

  // Embed only the materials this model actually uses, and only the textures
  // those materials reference — each GLB otherwise carries all five 512² maps
  // (≈0.6 MB of dead weight) whether or not it uses them.
  const usedMats = [...builder.prims.keys()];
  const texLocal = {};
  for (const name of [...new Set(usedMats.map((i) => MATERIALS[i].tex).filter(Boolean))]) {
    json.images.push({ bufferView: addView(TEXTURES[TEX_INDEX[name]].png), mimeType: 'image/png', name });
    json.textures.push({ source: json.images.length - 1, sampler: 0 });
    texLocal[name] = json.textures.length - 1;
  }
  const matLocal = {};
  for (const gi of usedMats) {
    const m = MATERIALS[gi];
    json.materials.push({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...m.color, 1],
        ...(m.tex != null ? { baseColorTexture: { index: texLocal[m.tex] } } : {}),
        metallicFactor: m.metallic,
        roughnessFactor: m.roughness,
      },
      ...(m.emissive ? { emissiveFactor: m.emissive } : {}),
    });
    matLocal[gi] = json.materials.length - 1;
  }

  for (const [mat, p] of builder.prims) {
    const pos = new Float32Array(p.pos), nrm = new Float32Array(p.nrm), uv = new Float32Array(p.uv);
    const idx = pos.length / 3 > 65535 ? new Uint32Array(p.idx) : new Uint16Array(p.idx);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (pos[i + k] < min[k]) min[k] = pos[i + k];
        if (pos[i + k] > max[k]) max[k] = pos[i + k];
      }
    }
    const acc = (view, componentType, count, type, extra = {}) =>
      json.accessors.push({ bufferView: view, componentType, count, type, ...extra }) - 1;
    json.meshes[0].primitives.push({
      attributes: {
        POSITION: acc(addView(Buffer.from(pos.buffer), 34962), 5126, pos.length / 3, 'VEC3', { min: [...min], max: [...max] }),
        NORMAL: acc(addView(Buffer.from(nrm.buffer), 34962), 5126, nrm.length / 3, 'VEC3'),
        TEXCOORD_0: acc(addView(Buffer.from(uv.buffer), 34962), 5126, uv.length / 2, 'VEC2'),
      },
      indices: acc(addView(Buffer.from(idx.buffer), 34963), idx instanceof Uint32Array ? 5125 : 5123, idx.length, 'SCALAR'),
      material: matLocal[mat],
    });
  }

  const bin = Buffer.concat(chunks);
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4);
  json.buffers.push({ byteLength: bin.length + binPad.length });
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);

  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + jsonBuf.length + 8 + bin.length + binPad.length, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(bin.length + binPad.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  writeFileSync(path, Buffer.concat([head, jsonBuf, binHead, bin, binPad]));
  console.log(path.split('/').pop(), `${((20 + jsonBuf.length + 8 + bin.length) / 1024).toFixed(0)} kB`);
}

// -------------------------------------------------------------- models -----

// Generic bus: MLI-wrapped body with edge rails, twin three-segment solar
// wings on ±Z, gimballed dish, radiator, star tracker, omni whip.
{
  const b = new Builder();
  b.box(M['mli-foil'], [0, 0, 0], [1.9, 1.7, 2.3]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(M.alu, [sx * 0.93, 0, sz * 1.13], [0.06, 1.74, 0.06]);     // edge rails
  }
  b.box(M.radiator, [0.965, 0, 0], [0.04, 1.3, 1.7]);                // side radiator
  b.box(M.radiator, [0, 0.86, 0.4], [1.5, 0.05, 1.2]);               // top radiator
  for (const side of [-1, 1]) {
    b.cylinder(M.alu, [0, 0, 0], 0.05, 0.05, side * 1.15, side * 1.55, 12); // yoke boom
    for (let s = 0; s < 3; s++) {
      const z = side * (2.3 + s * 1.48);
      b.solarPanel([0, 0, z], [2.3, 1.38]);
      b.box(M.alu, [0, 0, z - side * 0.74], [0.07, 0.07, 0.1]);      // hinge
    }
  }
  b.cylinder(M.radiator, [0, 1.0, -0.5], 0.55, 0.34, -0.12, 0.18, 32); // dish (outer)
  b.cylinder(M['dark-metal'], [0, 1.02, -0.5], 0.3, 0.06, 0.1, 0.34, 24); // feed horn
  b.cylinder(M.alu, [0.55, 1.0, 0.55], 0.04, 0.04, -0.15, 0.55, 10);  // omni whip
  b.cylinder(M['dark-metal'], [-0.6, 0.86, 0.7], 0.09, 0.07, 0, 0.22, 16); // star tracker
  b.box(M['scorched'], [0, -0.9, 0], [0.42, 0.1, 0.42]);              // thruster plate
  b.cylinder(M.scorched, [0, -0.97, 0], 0.1, 0.16, -0.12, 0, 20);     // main thruster bell
  writeGlb(join(OUT, 'generic-sat.glb'), b);
}

// Starlink v1.5-style: flat silver chassis, white phased-array face, four
// dishes, single long cell-gridded wing with frame and diagonal strut.
{
  const b = new Builder();
  b.box(M.alu, [0, 0, 0], [2.8, 0.12, 1.4]);
  b.box(M.radiator, [0, -0.085, 0], [2.6, 0.05, 1.2]);               // antenna face
  for (const x of [-0.95, -0.32, 0.32, 0.95]) {
    b.cylinder(M.radiator, [x, -0.16, 0], 0.17, 0.17, -0.045, 0.045, 24);
  }
  b.box(M['dark-metal'], [1.3, 0.1, 0.55], [0.18, 0.14, 0.2]);       // thruster block
  b.box(M.alu, [0, 0.38, -0.6], [0.16, 0.72, 0.09]);                 // wing yoke
  b.box(M.alu, [0.5, 0.32, -0.45], [0.05, 0.62, 0.05]);              // diagonal strut
  b.box(M['solar-cell'], [0, 3.7, -0.63], [2.6, 6.6, 0.045]);        // vertical wing
  for (const y of [0.5, 3.7, 6.9]) {
    b.box(M.alu, [0, y, -0.66], [2.64, 0.07, 0.03]);                 // wing cross-frames
  }
  writeGlb(join(OUT, 'starlink.glb'), b);
}

// Spent upper stage: brushed tank with weld lands, interstage ring,
// stringers, scorched engine bell.
{
  const b = new Builder();
  b.cylinder(M.alu, [0, 0, 0], 1.55, 1.55, -4.6, 4.0, 40);
  b.cylinder(M.alu, [0, 0, 0], 1.0, 1.55, 4.0, 4.9, 40);             // forward taper
  b.cylinder(M['dark-metal'], [0, 0, 0], 1.57, 1.57, -3.0, -2.62, 40); // interstage band
  b.cylinder(M['dark-metal'], [0, 0, 0], 1.565, 1.565, 1.2, 1.32, 40); // weld land
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    b.box(M['dark-metal'], [Math.cos(t) * 1.57, -3.8, Math.sin(t) * 1.57], [0.06, 1.6, 0.06]);
  }
  b.cylinder(M.scorched, [0, 0, 0], 0.95, 0.55, -5.6, -4.6, 36);     // engine bell
  b.cylinder(M.scorched, [0, 0, 0], 0.55, 0.4, -4.6, -4.3, 24);      // throat
  b.cylinder(M['dark-metal'], [1.0, -4.4, 0], 0.1, 0.1, -0.3, 0.3, 12); // vernier
  writeGlb(join(OUT, 'rocketbody.glb'), b);
}

// Navigation satellite (Galileo / GPS / BeiDou, MEO): a compact MLI bus with
// twin long solar wings and — the giveaway, no comms dish — a nadir L-band
// antenna farm, a backplane studded with helical element cans aimed at the
// ground, plus a zenith radiator and apogee-motor nozzle.
{
  const b = new Builder();
  b.box(M['mli-foil'], [0, 0, 0], [1.3, 1.2, 2.7]);                 // bus body
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(M.alu, [sx * 0.62, 0, sz * 1.33], [0.05, 1.22, 0.05]);    // edge rails
  }
  b.box(M.radiator, [0, 0.62, 0], [1.05, 0.04, 2.4]);               // +Y zenith radiator
  b.box(M['dark-metal'], [0, -0.64, 0], [1.05, 0.08, 2.3]);         // -Y antenna backplane
  for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) {
    b.cylinder(M.alu, [j * 0.36, -0.7, i * 0.46], 0.075, 0.075, -0.18, 0, 12); // helix can
  }
  for (const side of [-1, 1]) {                                     // twin wings along ±Z
    b.box(M.alu, [0, 0, side * 1.6], [0.07, 0.07, 0.5]);            // yoke boom
    for (let s = 0; s < 2; s++) {
      const z = side * (2.6 + s * 2.7);
      b.solarPanel([0, 0, z], [1.7, 2.6]);
      b.box(M.alu, [0, 0, z - side * 1.35], [0.06, 0.06, 0.08]);    // hinge
    }
  }
  b.cylinder(M.scorched, [0, 0.66, 0], 0.12, 0.18, 0, 0.22, 20);    // apogee motor
  writeGlb(join(OUT, 'navsat.glb'), b);
}

// Earth-observation / SAR bus (Sentinel-1/2/3): MLI body, a single solar wing
// on +Z, and the signature long flat C-band SAR antenna spanning ±X, its
// panels facing the ground; a nadir instrument box and a small zenith
// data-relay dish round it out.
{
  const b = new Builder();
  b.box(M['mli-foil'], [0, 0, 0], [1.4, 1.3, 2.6]);                 // body
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(M.alu, [sx * 0.67, 0, sz * 1.28], [0.05, 1.32, 0.05]);    // edge rails
  }
  b.box(M.radiator, [0, 0, -1.32], [1.2, 1.1, 0.04]);               // -Z radiator
  for (const sx of [-1, 1]) {                                       // SAR antenna along ±X
    b.box(M.alu, [sx * 0.7, 0, 0], [0.1, 0.1, 0.4]);                // root hinge
    for (let s = 0; s < 2; s++) {
      const x = sx * (1.55 + s * 2.7);
      b.box(M['dark-metal'], [x, -0.45, 0], [2.6, 0.05, 0.92]);     // SAR panel
      b.box(M.alu, [x, -0.45, 0.5], [2.6, 0.06, 0.04]);             // edge frame
      b.box(M.alu, [x, -0.45, -0.5], [2.6, 0.06, 0.04]);
    }
  }
  b.box(M.alu, [0, 0, 1.5], [0.07, 0.07, 0.5]);                     // wing yoke
  for (let s = 0; s < 3; s++) {                                     // single solar wing +Z
    const z = 2.4 + s * 1.5;
    b.solarPanel([0, 0, z], [1.6, 1.4]);
    b.box(M.alu, [0, 0, z - 0.75], [0.06, 0.06, 0.08]);            // hinge
  }
  b.box(M['dark-metal'], [0, -0.72, 0.7], [0.5, 0.22, 0.5]);        // nadir instrument
  b.cylinder(M.radiator, [0.4, 0.78, -0.5], 0.34, 0.2, 0, 0.22, 24); // zenith relay dish
  writeGlb(join(OUT, 'sar.glb'), b);
}

// Debris: two jagged shards, foil + structure metal.
{
  const b = new Builder();
  b.fragment(M['dark-metal'], [0, 0, 0], 0.85, 1337, 0.8);
  b.fragment(M['mli-foil'], [0.7, 0.4, -0.3], 0.35, 4242, 0.9);
  writeGlb(join(OUT, 'debris.glb'), b);
}
