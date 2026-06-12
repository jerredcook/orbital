// fix-models.mjs — strips texture references that have no UV coordinates.
//
//   node tools/fix-models.mjs
//
// Some published GLBs (NASA's Terra, Hubble) bind textures to meshes that
// carry no TEXCOORD attribute.  Cesium generates a shader referencing
// v_texCoord_0, the compile fails, and rendering stops.  This rewrites the
// GLB's JSON chunk with those bindings removed — base color factors remain,
// so the material keeps its tint; the binary chunk is untouched.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');

for (const f of readdirSync(DIR).filter((n) => n.endsWith('.glb'))) {
  const path = join(DIR, f);
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  const rest = buf.subarray(20 + jsonLen); // BIN chunk(s), untouched

  // Which materials are used by a primitive that lacks which UV set?
  const brokenUv = new Map(); // material index -> Set of texCoord ints
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.material == null) continue;
      const mat = gltf.materials[prim.material];
      const pbr = mat.pbrMetallicRoughness ?? {};
      for (const t of [pbr.baseColorTexture, pbr.metallicRoughnessTexture,
                       mat.normalTexture, mat.occlusionTexture, mat.emissiveTexture]) {
        if (!t) continue;
        const uv = t.texCoord ?? 0;
        if (!(`TEXCOORD_${uv}` in prim.attributes)) {
          if (!brokenUv.has(prim.material)) brokenUv.set(prim.material, new Set());
          brokenUv.get(prim.material).add(uv);
        }
      }
    }
  }
  if (brokenUv.size === 0) continue;

  let stripped = 0;
  for (const [mi, uvs] of brokenUv) {
    const mat = gltf.materials[mi];
    const pbr = mat.pbrMetallicRoughness ?? {};
    const strip = (holder, key) => {
      const t = holder[key];
      if (t && uvs.has(t.texCoord ?? 0)) { delete holder[key]; stripped++; }
    };
    strip(pbr, 'baseColorTexture');
    strip(pbr, 'metallicRoughnessTexture');
    strip(mat, 'normalTexture');
    strip(mat, 'occlusionTexture');
    strip(mat, 'emissiveTexture');
  }

  let jsonBuf = Buffer.from(JSON.stringify(gltf));
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const out = Buffer.concat([buf.subarray(0, 12), Buffer.alloc(8), jsonBuf, rest]);
  out.writeUInt32LE(out.length, 8);          // total length
  out.writeUInt32LE(jsonBuf.length, 12);     // JSON chunk length
  out.writeUInt32LE(0x4e4f534a, 16);         // 'JSON'
  writeFileSync(path, out);
  console.log(`${f}: stripped ${stripped} dangling texture binding(s)`);
}
