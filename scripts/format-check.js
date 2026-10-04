import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let failed = false;
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:js|json|md|sql|yml)$/.test(entry.name)) {
      const text = readFileSync(path, 'utf8');
      if (/[ \t]+$/m.test(text) || !text.endsWith('\n')) {
        process.stderr.write(`FORMAT_CHECK_FAILED: ${path}\n`);
        failed = true;
      }
    }
  }
}
for (const directory of ['src', 'scripts', 'tests', 'docs', '.github']) walk(directory);
if (failed) process.exitCode = 1;
