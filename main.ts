// token-radar-01 — Tide Table. A Node 22 entry, standard library only.
//
// The sealed snapshot is read from /input/snapshot.json (or --input <file|dir>). Every protocol whose
// DefiLlama record carries no token is scored by the fitted model in lib/model.ts, ranked by implied
// value and given a costed farm plan. The program writes /output/board.json, /output/data.js, copies
// dashboard/ and screenshots/ into /output, and finally writes /output/dossier.json with the vendored
// make.fun library, so the judge sees exactly what the gate sees.
//
// Outside the grader: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
// All output is a pure function of the snapshot and the repository files: no clock, no randomness, no
// network. Two runs produce byte-identical files.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The gate's caps: only text_max_bytes shapes the dossier's bytes; the others refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> or --name=<value>, with a fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const equals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return equals === undefined ? fallback : equals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}; pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy every regular file of a directory tree into `to`, skipping dot names. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  const walk = (dir: string, target: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const path = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const st = statSync(path);
      if (st.isDirectory()) {
        walk(path, join(target, name), rel);
      } else if (st.isFile()) {
        copyFileSync(path, join(target, name));
        copied.push(rel);
      }
    }
  };
  walk(from, to, '');
  return copied;
}

const dashFiles = copyTree(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyTree(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images; hand in 3 or 4 (board, detail, filtered)\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name.split('/').pop() ?? '')) {
    process.stderr.write(`token radar: screenshots/${name}: a file name is letters, digits and . _ -\n`);
    process.exit(1);
  }
}

/** PNG and JPEG signatures, so a screenshot that is not a whole image is caught before the gate is. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** A big-endian 32-bit read from a byte array, without an image library. */
function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

/** Read the width and height of a PNG (IHDR) or JPEG (SOF), without any image library. */
function imageSize(bytes: Uint8Array, png: boolean): { w: number; h: number } | null {
  if (png) {
    if (bytes.length < 24) return null;
    return { w: u32(bytes, 16), h: u32(bytes, 20) };
  }
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { w: (bytes[i + 7]! << 8) | bytes[i + 8]!, h: (bytes[i + 5]! << 8) | bytes[i + 6]! };
    }
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/**
 * Check the gate's asset invariants locally: whole images of the right shape and size, and no
 * network address anywhere in the dashboard's source. Catching these here avoids a refused entry.
 */
function guardAssets(): string[] {
  const warnings: string[] = [];
  for (const rel of shots) {
    const bytes = readFileSync(join(out, 'screenshots', rel));
    const png = PNG_MAGIC.every((b, i) => bytes[i] === b);
    const jpeg = JPEG_MAGIC.every((b, i) => bytes[i] === b);
    if (!png && !jpeg) throw new Error(`screenshots/${rel}: not a whole PNG or JPEG`);
    if (bytes.length > SCREENSHOT_CAPS.max_bytes) throw new Error(`screenshots/${rel}: ${bytes.length} bytes over the cap`);
    if (bytes.length < 300 * 1024 || bytes.length > 350 * 1024) warnings.push(`screenshots/${rel}: ${bytes.length} bytes outside the 300-350 KB target`);
    const size = imageSize(bytes, png);
    if (size === null) throw new Error(`screenshots/${rel}: could not read the image dimensions`);
    if (Math.max(size.w, size.h) > 1440 || Math.min(size.w, size.h) < 800) {
      throw new Error(`screenshots/${rel}: ${size.w}x${size.h} outside the gate's bounds`);
    }
  }
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        const source = readFileSync(path, 'utf8');
        if (/https?:\/\//.test(source)) throw new Error(`${path} names a network address`);
      }
    }
  };
  walk(join(out, 'dashboard'));
  return warnings;
}

for (const warning of guardAssets()) process.stderr.write(`token radar: warning: ${warning}\n`);

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossier = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS });
writeFileSync(join(out, 'dossier.json'), dossier);

/** Re-read the artefacts and prove the three derived files still agree with the model and each other. */
function verifyOutputs(): void {
  const written = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')) as {
    rows: Array<{ rank: number; slug: string; implied_value_usd: number }>;
  };
  if (!Array.isArray(written.rows) || written.rows.length !== board.length) throw new Error('board.json lost rows');
  for (let i = 0; i < written.rows.length; i++) {
    const row = written.rows[i]!;
    if (row.rank !== i + 1) throw new Error(`board.json rank ${i + 1} is ${row.rank}`);
    if (row.slug !== board[i]!.slug || row.implied_value_usd !== board[i]!.implied_value_usd) {
      throw new Error(`board.json row ${i + 1} disagrees with the model`);
    }
  }
  const script = readFileSync(join(out, 'data.js'), 'utf8');
  if (!script.startsWith('window.RADAR=')) throw new Error('data.js does not publish window.RADAR');
  if (!script.includes(`"rank":${board.length}`)) throw new Error('data.js does not carry the full board');
  const rebuilt = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS });
  if (Buffer.compare(Buffer.from(rebuilt), Buffer.from(dossier)) !== 0) {
    throw new Error('dossier.json is not what buildDossier writes from this /output');
  }
}
verifyOutputs();

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlisted, ${board.length} rows ranked ` +
    `(${radar.counts.early} early, ${radar.counts.live} in the calibration set)\n` +
  `token radar: model ${radar.validation.cv.r2} cross-validated R2, ${radar.validation.walk.r2} walk-forward R2, ` +
    `${radar.validation.cv.factor}x median out-of-fold error, blend ${radar.model.blend}\n` +
  `token radar: wrote board.json, data.js, dashboard (${dashFiles.length} files), screenshots (${shots.length} images), dossier.json (${dossier.length} bytes)\n`,
);
