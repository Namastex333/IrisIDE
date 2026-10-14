// Draws the Iris app icon (an eye's iris) and writes it to resources/icon.png.
// Pure Node, no image libraries. Run with: npm run icon
import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const SAMPLES = 3 // supersampling per axis, for smooth edges

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

const RIM = hex('#1b1b2a')
const IRIS_INNER = hex('#7dd3fc')
const IRIS_OUTER = hex('#6d5df6')
const PUPIL = hex('#0d0d14')

// Returns [r, g, b, a] for a point in unit coordinates (the icon spans -1..1).
function colorAt(x, y) {
  const r = Math.hypot(x, y)
  if (r > 1) return [0, 0, 0, 0]

  let rgb
  if (r > 0.92) {
    rgb = RIM
  } else if (r > 0.42) {
    const streaks = 1 + 0.07 * Math.sin(Math.atan2(y, x) * 36)
    rgb = mix(IRIS_INNER, IRIS_OUTER, (r - 0.42) / 0.5).map((v) => Math.min(255, v * streaks))
  } else {
    rgb = PUPIL
  }

  if (Math.hypot(x + 0.2, y + 0.22) < 0.12) rgb = mix(rgb, [255, 255, 255], 0.9)
  return [...rgb, 255]
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let py = 0; py < SIZE; py++) {
  const row = py * (SIZE * 4 + 1)
  raw[row] = 0 // PNG filter type: none
  for (let px = 0; px < SIZE; px++) {
    const sum = [0, 0, 0, 0]
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const x = ((px + (sx + 0.5) / SAMPLES) / SIZE) * 2 - 1
        const y = ((py + (sy + 0.5) / SAMPLES) / SIZE) * 2 - 1
        const [r, g, b, a] = colorAt(x * 1.03, y * 1.03)
        sum[0] += r * a
        sum[1] += g * a
        sum[2] += b * a
        sum[3] += a
      }
    }
    const offset = row + 1 + px * 4
    const alpha = sum[3] / (SAMPLES * SAMPLES)
    raw[offset] = sum[3] ? Math.round(sum[0] / sum[3]) : 0
    raw[offset + 1] = sum[3] ? Math.round(sum[1] / sum[3]) : 0
    raw[offset + 2] = sum[3] ? Math.round(sum[2] / sum[3]) : 0
    raw[offset + 3] = Math.round(alpha)
  }
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header[8] = 8 // bit depth
header[9] = 6 // color type: RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../resources/icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`Wrote ${out}`)
