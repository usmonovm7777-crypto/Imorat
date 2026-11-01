import { deflateSync } from "node:zlib";

/* Test fixtures for the 3D feature: a tiny PNG and a valid binary glTF (a textured box, the kind of answer an image-to-3D
   service returns: positions, normals, UVs, 16-bit indices, a base-colour texture embedded in the buffer, a node transform). */
const crc32 = buf => { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
export function pngRGBA(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b, a] = px(x, y); raw.set([r, g, b, a], y * (w * 4 + 1) + 1 + x * 4); } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/* a box w×h×d (metres) whose faces carry a two-colour label texture, like a bag of cement */
export function boxGlb({ w = 0.4, h = 0.6, d = 0.15, tex: texIn = null, mime = "image/png" } = {}) {
  const tex = texIn || pngRGBA(64, 64, (x, y) => (y > 24 && y < 40 ? [232, 122, 40, 255] : (x + y) % 16 < 8 ? [238, 230, 210, 255] : [220, 210, 186, 255]));
  const F = [ // face: normal, 4 corners
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]], [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]], [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]]];
  const pos = [], nrm = [], uv = [], idx = [];
  F.forEach(([n, cs], f) => { cs.forEach(([x, y, z], i) => { pos.push(x * w / 2, y * h / 2, z * d / 2); nrm.push(...n); uv.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 0 : 1); }); idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3); });
  const P = Buffer.from(new Float32Array(pos).buffer), N = Buffer.from(new Float32Array(nrm).buffer), U = Buffer.from(new Float32Array(uv).buffer), I = Buffer.from(new Uint16Array(idx).buffer);
  const pad4 = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const parts = [P, N, U, pad4(I), pad4(tex)], offs = []; let o = 0; for (const p of parts) { offs.push(o); o += p.length; }
  const bin = Buffer.concat(parts);
  const json = {
    asset: { version: "2.0", generator: "imorat-test" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [0, h / 2, 0], rotation: [0, 0.2588, 0, 0.9659] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987 }], images: [{ bufferView: 4, mimeType: mime }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: offs[0], byteLength: P.length, target: 34962 }, { buffer: 0, byteOffset: offs[1], byteLength: N.length, target: 34962 }, { buffer: 0, byteOffset: offs[2], byteLength: U.length, target: 34962 }, { buffer: 0, byteOffset: offs[3], byteLength: I.length, target: 34963 }, { buffer: 0, byteOffset: offs[4], byteLength: tex.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] }, { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" }, { bufferView: 2, componentType: 5126, count: 24, type: "VEC2" }, { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" }]
  };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]);
}
