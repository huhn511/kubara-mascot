// Writers for STL / 3MF and small mesh helpers shared by the build.
import { writeFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';

/** Binary STL from {vertProperties, numProp, triVerts}. */
export function writeSTL(path, mesh, name = 'kubara') {
  const { vertProperties: vp, numProp: np, triVerts: tv } = mesh;
  const nTri = tv.length / 3;
  const buf = Buffer.alloc(84 + nTri * 50);
  buf.write(name.padEnd(80, ' ').slice(0, 80), 0, 'ascii');
  buf.writeUInt32LE(nTri, 80);
  let o = 84;
  for (let t = 0; t < nTri; t++) {
    const a = tv[3 * t] * np, b = tv[3 * t + 1] * np, c = tv[3 * t + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const wx = vp[c] - vp[a], wy = vp[c + 1] - vp[a + 1], wz = vp[c + 2] - vp[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / l, o); buf.writeFloatLE(ny / l, o + 4); buf.writeFloatLE(nz / l, o + 8);
    o += 12;
    for (const v of [a, b, c]) {
      buf.writeFloatLE(vp[v], o); buf.writeFloatLE(vp[v + 1], o + 4); buf.writeFloatLE(vp[v + 2], o + 8);
      o += 12;
    }
    buf.writeUInt16LE(0, o); o += 2;
  }
  writeFileSync(path, buf);
}

// 6 decimals (1 nm): rounding never collapses a triangle or merges two vertices of the source mesh
const f = (v) => (Math.abs(v) < 5e-7 ? '0' : v.toFixed(6).replace(/\.?0+$/, ''));

/**
 * Multi-part 3MF that Bambu Studio / OrcaSlicer import as ONE object with
 * several named parts (one per colour), each pre-assigned to a filament slot.
 * parts: [{name, color:'#RRGGBB', extruder, mesh}]
 */
export function write3MF(path, parts, { title = 'kubara', bedCenter = [128, 128], filamentType = 'PLA' } = {}) {
  const baseId = 1;
  const cgId = 2 + parts.length + 1; // colour group id (after the objects + assembly ids)
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n`;
  xml += ` <metadata name="Title">${title}</metadata>\n <metadata name="Designer">kubara mascot pipeline</metadata>\n`;
  xml += ` <resources>\n  <basematerials id="${baseId}">\n`;
  for (const p of parts) xml += `   <base name="${p.name}" displaycolor="${p.color.toUpperCase()}FF"/>\n`;
  xml += `  </basematerials>\n`;
  // materials-extension colour group: Bambu Studio picks this up as per-part colours ("process group colors")
  xml += `  <m:colorgroup id="${cgId}">\n`;
  for (const p of parts) xml += `   <m:color color="${p.color.toUpperCase()}FF"/>\n`;
  xml += `  </m:colorgroup>\n`;
  const chunks = [xml];
  parts.forEach((p, i) => {
    const id = i + 2;
    p.id = id;
    const { vertProperties: vp, numProp: np, triVerts: tv } = p.mesh;
    const out = [`  <object id="${id}" type="model" name="${p.name}" pid="${cgId}" pindex="${i}">\n   <mesh>\n    <vertices>\n`];
    for (let v = 0; v < vp.length / np; v++) out.push(`     <vertex x="${f(vp[v * np])}" y="${f(vp[v * np + 1])}" z="${f(vp[v * np + 2])}"/>\n`);
    out.push('    </vertices>\n    <triangles>\n');
    for (let t = 0; t < tv.length; t += 3) out.push(`     <triangle v1="${tv[t]}" v2="${tv[t + 1]}" v3="${tv[t + 2]}"/>\n`);
    out.push('    </triangles>\n   </mesh>\n  </object>\n');
    chunks.push(out.join(''));
  });
  const asmId = parts.length + 2;
  let tail = `  <object id="${asmId}" type="model" name="${title}">\n   <components>\n`;
  for (const p of parts) tail += `    <component objectid="${p.id}"/>\n`;
  tail += `   </components>\n  </object>\n </resources>\n <build>\n`;
  tail += `  <item objectid="${asmId}" transform="1 0 0 0 1 0 0 0 1 ${bedCenter[0]} ${bedCenter[1]} 0"/>\n </build>\n</model>\n`;
  chunks.push(tail);

  let cfg = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="${asmId}">\n    <metadata key="name" value="${title}"/>\n    <metadata key="extruder" value="1"/>\n`;
  for (const p of parts) {
    cfg += `    <part id="${p.id}" subtype="normal_part">\n      <metadata key="name" value="${p.name}"/>\n      <metadata key="extruder" value="${p.extruder}"/>\n    </part>\n`;
  }
  cfg += `  </object>\n</config>\n`;

  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Override PartName="/Metadata/model_settings.config" ContentType="text/xml"/>\n <Override PartName="/Metadata/project_settings.config" ContentType="application/json"/>\n</Types>\n`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`),
    '3D/3dmodel.model': strToU8(chunks.join('')),
    'Metadata/model_settings.config': strToU8(cfg),
    // Bambu Studio / OrcaSlicer read the filament list (count + colours) from the project config; without it
    // they load one default filament and the user has to create slots 2-4 by hand.
    'Metadata/project_settings.config': strToU8(JSON.stringify(projectSettings(parts, filamentType), null, 4) + '\n'),
  };
  // fixed timestamps -> byte-reproducible 3MF
  const mtime = new Date('2020-01-01T00:00:00Z');
  writeFileSync(path, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { mtime }]])), { level: 6, mtime }));
}

/** Minimal Bambu/Orca project settings: one filament per extruder slot used by the parts, with its colour. */
function projectSettings(parts, filamentType) {
  const n = Math.max(...parts.map((p) => p.extruder));
  const colour = Array.from({ length: n }, (_, i) => (parts.find((p) => p.extruder === i + 1)?.color ?? '#FFFFFF').toUpperCase());
  return {
    filament_colour: colour,
    filament_type: Array(n).fill(filamentType),
    filament_settings_id: Array(n).fill('Generic PLA'),
    filament_vendor: Array(n).fill('Generic'),
  };
}

/** sRGB hex -> linear RGB (glTF baseColorFactor is linear). */
export function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}
