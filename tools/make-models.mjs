// make-models.mjs — generates the generic spacecraft GLBs in public/models/.
//
//   node tools/make-models.mjs
//
// Real spacecraft (ISS, Hubble) use NASA's published models; everything else
// gets a class-appropriate generic built here: a comms/EO bus with solar
// wings, a Starlink-style flat-panel, a spent rocket stage, and a debris
// fragment.  Output is minimal binary glTF 2.0: one mesh, one primitive per
// material, PBR metallic-roughness, flat or radial normals.  Y-up, meters.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ mesh builder --

class Builder {
  constructor() { this.prims = new Map(); }

  prim(mat) {
    if (!this.prims.has(mat)) this.prims.set(mat, { pos: [], nrm: [], idx: [] });
    return this.prims.get(mat);
  }

  tri(mat, a, b, c) {
    const p = this.prim(mat);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const base = p.pos.length / 3;
    for (const v of [a, b, c]) { p.pos.push(...v); p.nrm.push(nx, ny, nz); }
    p.idx.push(base, base + 1, base + 2);
  }

  quad(mat, a, b, c, d) { this.tri(mat, a, b, c); this.tri(mat, a, c, d); }

  box(mat, [cx, cy, cz], [w, h, d]) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    this.quad(mat, [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]); // +Z
    this.quad(mat, [x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]); // -Z
    this.quad(mat, [x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]); // +X
    this.quad(mat, [x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]); // -X
    this.quad(mat, [x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]); // +Y
    this.quad(mat, [x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]); // -Y
  }

  // Cylinder along +Y from y0 to y1, radii r0 (bottom) → r1 (top), smooth side
  // normals; capped.
  cylinder(mat, [cx, cy, cz], r0, r1, y0, y1, seg = 28) {
    const p = this.prim(mat);
    const ring = (y, r) => Array.from({ length: seg }, (_, i) => {
      const t = (i / seg) * Math.PI * 2;
      return [cx + r * Math.cos(t), cy + y, cz + r * Math.sin(t)];
    });
    const bot = ring(y0, r0), top = ring(y1, r1);
    const slope = Math.atan2(r0 - r1, y1 - y0);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const base = p.pos.length / 3;
      for (const [vx, , vz] of [bot[i], bot[j], top[j], top[i]]) {
        const t = Math.atan2(vz - cz, vx - cx);
        p.nrm.push(Math.cos(t) * Math.cos(slope), Math.sin(slope), Math.sin(t) * Math.cos(slope));
      }
      p.pos.push(...bot[i], ...bot[j], ...top[j], ...top[i]);
      p.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    for (let i = 1; i < seg - 1; i++) {
      this.tri(mat, [cx, cy + y1, cz], top[i + 1], top[i]);       // top cap
      this.tri(mat, [cx, cy + y0, cz], bot[i], bot[i + 1]);       // bottom cap
    }
  }

  // Jagged fragment: icosahedron with seeded radial displacement, flat-shaded.
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
      [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],
      [10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],
      [2,4,11],[6,2,10],[8,6,7],[9,8,1],
    ];
    for (const [a, b, c] of F) this.tri(mat, raw[a], raw[b], raw[c]);
  }
}

// --------------------------------------------------------------- glb writer --

function writeGlb(path, builder, materials) {
  const json = {
    asset: { version: '2.0', generator: 'orbital make-models' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [] }],
    materials: materials.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...m.color, 1],
        metallicFactor: m.metallic,
        roughnessFactor: m.roughness,
      },
      ...(m.emissive ? { emissiveFactor: m.emissive } : {}),
    })),
    accessors: [],
    bufferViews: [],
    buffers: [],
  };

  const chunks = [];
  let byteOffset = 0;
  const addView = (buf, target) => {
    const pad = (4 - (byteOffset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); byteOffset += pad; }
    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target });
    chunks.push(buf); byteOffset += buf.length;
    return json.bufferViews.length - 1;
  };

  for (const [mat, p] of builder.prims) {
    const pos = new Float32Array(p.pos), nrm = new Float32Array(p.nrm);
    const idx = pos.length / 3 > 65535 ? new Uint32Array(p.idx) : new Uint16Array(p.idx);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (pos[i + k] < min[k]) min[k] = pos[i + k];
        if (pos[i + k] > max[k]) max[k] = pos[i + k];
      }
    }
    const posAcc = json.accessors.push({
      bufferView: addView(Buffer.from(pos.buffer), 34962),
      componentType: 5126, count: pos.length / 3, type: 'VEC3',
      min: [...min], max: [...max],
    }) - 1;
    const nrmAcc = json.accessors.push({
      bufferView: addView(Buffer.from(nrm.buffer), 34962),
      componentType: 5126, count: nrm.length / 3, type: 'VEC3',
    }) - 1;
    const idxAcc = json.accessors.push({
      bufferView: addView(Buffer.from(idx.buffer), 34963),
      componentType: idx instanceof Uint32Array ? 5125 : 5123,
      count: idx.length, type: 'SCALAR',
    }) - 1;
    json.meshes[0].primitives.push({
      attributes: { POSITION: posAcc, NORMAL: nrmAcc },
      indices: idxAcc, material: mat,
    });
  }

  const bin = Buffer.concat(chunks);
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4);
  json.buffers.push({ byteLength: bin.length + binPad.length });
  let jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
  jsonBuf = Buffer.concat([jsonBuf, jsonPad]);

  const total = 12 + 8 + jsonBuf.length + 8 + bin.length + binPad.length;
  const head = Buffer.alloc(12 + 8);
  head.writeUInt32LE(0x46546c67, 0);          // 'glTF'
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);         // 'JSON'
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(bin.length + binPad.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);       // 'BIN'
  writeFileSync(path, Buffer.concat([head, jsonBuf, binHead, bin, binPad]));
  console.log(path, `${(total / 1024).toFixed(1)} kB`);
}

// ------------------------------------------------------------------ palette --

const GOLD_MLI = { name: 'mli-foil', color: [0.72, 0.55, 0.20], metallic: 1.0, roughness: 0.32 };
const SILVER = { name: 'alu', color: [0.75, 0.77, 0.80], metallic: 1.0, roughness: 0.40 };
const SOLAR = { name: 'solar-cell', color: [0.04, 0.07, 0.18], metallic: 0.85, roughness: 0.22, emissive: [0.01, 0.02, 0.06] };
const WHITE = { name: 'radiator', color: [0.85, 0.87, 0.90], metallic: 0.1, roughness: 0.55 };
const DARK = { name: 'dark-metal', color: [0.28, 0.29, 0.31], metallic: 0.9, roughness: 0.55 };
const SCORCH = { name: 'scorched', color: [0.16, 0.14, 0.13], metallic: 0.6, roughness: 0.75 };

// ----------------------------------------------------------------- models ----

// Generic bus: gold-foil body, two 3-segment solar wings on ±Z, white dish
// looking +Y (up, repointed by orientation in the app), boom antenna.
{
  const b = new Builder();
  b.box(0, [0, 0, 0], [1.9, 1.7, 2.3]);                       // bus
  b.box(3, [0, 0.88, 0], [1.6, 0.06, 2.0]);                   // top radiator
  for (const side of [-1, 1]) {
    b.cylinder(1, [0, 0, side * 1.35], 0.05, 0.05, -0.05, 0.05, 10); // yoke hub
    b.box(1, [0, 0, side * 1.45], [0.08, 0.08, 0.5]);         // yoke arm
    for (let s = 0; s < 3; s++) {
      const z = side * (1.95 + s * 1.45);
      b.box(2, [0, 0, z], [2.3, 0.045, 1.35]);                // panel segment
      b.box(1, [0, 0, z - side * 0.72], [0.07, 0.07, 0.12]);  // hinge
    }
  }
  b.cylinder(3, [0, 1.05, 0], 0.55, 0.18, -0.18, 0.12, 28);   // dish (truncated)
  b.cylinder(1, [0, 1.0, 0], 0.03, 0.03, 0, 0.45, 8);         // feed mast
  b.cylinder(1, [0.7, -1.2, 0], 0.025, 0.025, -0.7, 0.35, 8); // boom
  b.box(5, [0, -0.88, 0], [0.5, 0.12, 0.5]);                  // thruster plate
  writeGlb(join(OUT, 'generic-sat.glb'), b, [GOLD_MLI, SILVER, SOLAR, WHITE, DARK, SCORCH]);
}

// Starlink-style: flat chassis, single long solar wing canted up behind it.
{
  const b = new Builder();
  b.box(1, [0, 0, 0], [2.8, 0.12, 1.4]);                      // chassis
  b.box(4, [0, -0.09, 0], [2.6, 0.06, 1.2]);                  // antenna face
  for (const x of [-0.9, -0.3, 0.3, 0.9]) {
    b.cylinder(3, [x, -0.18, 0], 0.16, 0.16, -0.04, 0.04, 20); // phased dishes
  }
  b.box(1, [0, 0.35, -0.6], [0.18, 0.7, 0.1]);                // wing yoke
  b.box(2, [0, 3.6, -0.62], [2.6, 6.6, 0.05]);                // solar wing
  writeGlb(join(OUT, 'starlink.glb'), b, [GOLD_MLI, SILVER, SOLAR, WHITE, DARK, SCORCH]);
}

// Spent upper stage: weathered cylinder, engine bell, stringer ring.
{
  const b = new Builder();
  b.cylinder(1, [0, 0, 0], 1.55, 1.55, -4.6, 4.0, 36);        // tank
  b.cylinder(1, [0, 0, 0], 1.0, 1.55, 4.0, 4.9, 36);          // forward taper
  b.cylinder(4, [0, 0, 0], 1.58, 1.58, -3.0, -2.6, 36);       // dark band
  b.cylinder(5, [0, 0, 0], 0.95, 0.55, -5.6, -4.6, 32);       // engine bell
  b.cylinder(5, [0, 0, 0], 0.55, 0.4, -4.6, -4.3, 24);        // throat
  writeGlb(join(OUT, 'rocketbody.glb'), b, [GOLD_MLI, SILVER, SOLAR, WHITE, DARK, SCORCH]);
}

// Debris: two jagged flat-shaded shards.
{
  const b = new Builder();
  b.fragment(4, [0, 0, 0], 0.85, 1337, 0.8);
  b.fragment(1, [0.7, 0.4, -0.3], 0.35, 4242, 0.9);
  writeGlb(join(OUT, 'debris.glb'), b, [GOLD_MLI, SILVER, SOLAR, WHITE, DARK, SCORCH]);
}
