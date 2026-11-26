// token-radar-01 entry — Node 22, standard library only.
//
// Reads the sealed snapshot, scores every pre-token protocol with lib/model.ts,
// writes board.json + data.js, copies dashboard/ and screenshots/ into the
// output directory, then writes dossier.json with the vendored make.fun library.
//
// Locally:   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
// In grading: /input/snapshot.json in, /output out (no MAKEFUN_OUTPUT_DIR needed).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BadSnapshot, buildPageData, gateIssue, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
  return fallback;
}

const die = (msg: string): never => {
  process.stderr.write(`radar: ${msg}\n`);
  process.exit(1);
};

// --- input -----------------------------------------------------------------

const inputArg = flag('input', '/input');
const inputPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputPath)) {
  die(`no snapshot at ${inputPath} — pass --input <snapshot.json|dir>`);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

let snap;
try {
  snap = parseSnapshot(readFileSync(inputPath, 'utf8'));
} catch (e) {
  die(e instanceof BadSnapshot ? e.message : String(e));
}

const { board, data } = buildPageData(snap!);
const issue = gateIssue(board, snap!);
if (issue) die(`the model built a board the gate refuses: ${issue}`);

// --- output ----------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board, model: data.model_version, as_of: data.as_of })}\n`);
writeFileSync(join(outDir, 'data.js'), `window.RADAR=${JSON.stringify(data)};\n`);

/** Copy regular top-level files from `from` to `to`, skipping dotfiles. */
function copyDir(from: string, to: string): string[] {
  const made: string[] = [];
  if (!existsSync(from)) return made;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    made.push(name);
  }
  return made;
}

const pageFiles = copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
// Keep a copy of the dataset beside the page too, so index.html loads it
// whether the site serves /output or /output/dashboard as its root. The copy
// is named zz-data.js so it sorts AFTER index.html: the dossier's source text
// shows every file whole until the 64 KB cap, and this one-line dataset is the
// file the cap cuts — never the page's markup.
copyFileSync(join(outDir, 'data.js'), join(outDir, 'dashboard', 'zz-data.js'));
const shots = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));

if (pageFiles.length < 3) die(`dashboard/ holds ${pageFiles.length} files — need index.html plus css and js`);
if (shots.length < 3 || shots.length > 4) die(`screenshots/ holds ${shots.length} — hand in 3 (board, detail, filtered)`);
for (const name of shots) if (!IMAGE_NAME.test(name)) die(`screenshot name refused: ${name}`);

// The dossier is written last, from the finished /output: the scorer rebuilds
// and compares bytes.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES }));

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
process.stdout.write(
  `radar: ${snap!.protocols.length} protocols read, ${snap!.watchlist.length} watchlist, ` +
    `${board.length} board rows (${data.counts.early} early), ${data.counts.live} live, ` +
    `${data.counts.excluded} excluded — ${data.counts.total} accounted for\n` +
    `radar: self-test ${data.self_test.filter((c) => c.pass).length}/${data.self_test.length} checks pass\n` +
    `radar: board.json ${kb(statSync(join(outDir, 'board.json')).size)}, ` +
    `data.js ${kb(statSync(join(outDir, 'data.js')).size)}, dashboard/ ${pageFiles.length} files, ` +
    `screenshots/ ${shots.length}, dossier.json ${kb(statSync(join(outDir, 'dossier.json')).size)}\n`,
);
