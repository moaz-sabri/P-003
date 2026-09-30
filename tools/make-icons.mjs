// Renders the PNG icons from the same geometry as the SVG ones.
//
// Why a script instead of committed binaries: the icons are two shapes — a
// rounded (or full-bleed) rectangle and a three-point tick — and keeping their
// coordinates in ONE place means the SVG and the PNG can never drift into two
// different apps on two different home screens. `npm run icons` rewrites the
// four PNGs; they are committed so a deployment never needs to run it.
//
// The encoder is written out rather than pulled in as a dependency: a build
// step that produces the app's own icons is the worst place to add a package
// that has to be audited, and PNG is a format simple enough to emit here in
// forty lines. zlib comes from Node.
//
// Run: node tools/make-icons.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT_DIR = fileURLToPath(new URL("../app/icons/", import.meta.url));

const BG = [0x14, 0x1a, 0x20];
const FG = [0x7c, 0xc0, 0xff];

// Every icon is the same drawing at a different size, so it is described ONCE in
// a 512-unit space and scaled. `radius: 512` means "no rounding" — iOS and the
// maskable icon both supply their own shape, and a rounded background inside
// them reads as a second, smaller rounded square.
const GLYPH = {
    points: [[150, 268], [228, 344], [366, 190]],
    stroke: 46
};

const ICONS = [
    { file: "icon-192.png", size: 192, radius: 112, glyph: GLYPH },
    { file: "icon-512.png", size: 512, radius: 112, glyph: GLYPH },
    { file: "maskable-512.png", size: 512, radius: 512, glyph: { points: [[186, 262], [242, 318], [336, 208]], stroke: 40 } },
    { file: "apple-touch-icon.png", size: 180, radius: 512, glyph: { points: [[53 * (512 / 180), 94 * (512 / 180)], [80 * (512 / 180), 121 * (512 / 180)], [129 * (512 / 180), 67 * (512 / 180)]], stroke: 18 * (512 / 180) } }
];

/* ------------------------------- geometry -------------------------------- */

// Signed distance to a segment, in the 512-space. The tick is drawn as three
// round caps and two round joins, which is exactly what `stroke-linecap` and
// `stroke-linejoin: round` mean in the SVG: a point is inside the stroke if it
// is within half a stroke width of any segment, and the joins come free because
// two segments meeting at a vertex each cover a disc centred on that vertex.
function distanceToSegment(px, py, [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Coverage of the rounded rectangle. Signed distance: negative inside.
function roundedRectDistance(px, py, size, radius) {
    const half = size / 2;
    const qx = Math.abs(px - half) - (half - radius);
    const qy = Math.abs(py - half) - (half - radius);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/* -------------------------------- encoder -------------------------------- */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

// 8-bit RGBA, no interlacing, filter type 0 on every scanline. The image is
// small (a flat glyph on a flat field), so the "wrong" filter choice costs a few
// hundred bytes on a file the browser caches for a month.
function encodePng(width, height, pixels) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // colour type: truecolour with alpha
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0))
    ]);
}

/* -------------------------------- render --------------------------------- */

// 4x4 supersampling. Without it a diagonal edge is a staircase of hard single-
// pixel steps, which is visible on a home screen at every size — the one place
// this icon is ever seen.
const SAMPLES = 4;

function render({ size, radius, glyph }) {
    const scale = size / 512;
    const half = radius * scale / 2;
    const stroke = glyph.stroke * scale;
    const points = glyph.points.map(([x, y]) => [x * scale, y * scale]);
    const pixels = Buffer.alloc(size * size * 4);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let bg = 0;
            let fg = 0;
            for (let sy = 0; sy < SAMPLES; sy++) {
                for (let sx = 0; sx < SAMPLES; sx++) {
                    const px = x + (sx + 0.5) / SAMPLES;
                    const py = y + (sy + 0.5) / SAMPLES;
                    if (roundedRectDistance(px, py, size, half) <= 0) bg++;
                    for (let i = 1; i < points.length; i++) {
                        if (distanceToSegment(px, py, points[i - 1], points[i]) <= stroke / 2) {
                            fg++;
                            break;
                        }
                    }
                }
            }
            const total = SAMPLES * SAMPLES;
            const a = bg / total;
            const f = Math.min(fg / total, a);
            const mix = (i) => Math.round(BG[i] * (1 - f) + FG[i] * f);
            const at = (y * size + x) * 4;
            pixels[at] = mix(0);
            pixels[at + 1] = mix(1);
            pixels[at + 2] = mix(2);
            pixels[at + 3] = Math.round(a * 255);
        }
    }
    return encodePng(size, size, pixels);
}

for (const icon of ICONS) {
    writeFileSync(OUT_DIR + icon.file, render(icon));
    console.log(`wrote app/icons/${icon.file} (${icon.size}x${icon.size})`);
}
