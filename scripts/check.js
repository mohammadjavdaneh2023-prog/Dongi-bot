import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) checkDirectory(path);
    else if (path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0 || result.error) process.exitCode = 1;
    }
  }
}
for (const directory of ['src', 'tests', 'scripts']) checkDirectory(directory);
