import process from 'node:process';
// Copies the Human face models the browser needs into apps/web/public/face-models/.
// Run from the web build/dev scripts (pnpm does not run pre* scripts by default).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'apps', 'web');
// The package's exports map is broken, so read it straight from node_modules.
const pkgDir = join(webDir, 'node_modules', '@vladmandic', 'human');
const out = join(webDir, 'public', 'face-models');
mkdirSync(out, { recursive: true });
for (const name of ['blazeface', 'facemesh', 'iris']) {
  for (const ext of ['json', 'bin']) {
    copyFileSync(join(pkgDir, 'models', `${name}.${ext}`), join(out, `${name}.${ext}`));
  }
}
process.stdout.write(`face models copied to ${out}\n`);
