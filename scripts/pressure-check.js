import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--test', 'tests/integration/polling-pressure.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, DONGI_PRESSURE_TEST: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
