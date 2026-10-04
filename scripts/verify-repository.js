import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const forbiddenNames = [/^\.env$/i, /\.sqlite(?:-wal|-shm)?$/i, /\.session(?:-journal)?$/i, /\.log(?:\.\d+)?$/i, /\.dump(?:\.enc)?$/i];
const ignored = new Set(['.git', 'node_modules']);
const findings = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      if (forbiddenNames.some(pattern => pattern.test(entry.name))) findings.push(path);
      if (statSync(path).size <= 2_000_000 && !['package-lock.json'].includes(basename(path))) {
        const text = readFileSync(path, 'utf8');
        if (/\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/.test(text)) findings.push(`${path}:telegram-token`);
      }
    }
  }
}
walk('.');
if (findings.length) {
  process.stderr.write(`REPOSITORY_POLICY_FAILED\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write('REPOSITORY_POLICY_OK\n');
