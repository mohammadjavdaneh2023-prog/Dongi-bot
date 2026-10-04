const issues = [];
if (Number(process.versions.node.split('.')[0]) !== 24) issues.push('NODE_VERSION_24_REQUIRED');
const required = ['DATABASE_URL', 'APP_ENCRYPTION_KEY', 'TELEGRAM_BOT_TOKEN', 'OWNER_TELEGRAM_ID', 'OWNER_NAME'];
for (const name of required) if (!process.env[name]?.trim()) issues.push(`${name}: MISSING`);
if (process.env.DATABASE_URL && !/^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL)) issues.push('DATABASE_URL: INVALID');
if (process.env.OWNER_TELEGRAM_ID && !/^[1-9]\d*$/.test(process.env.OWNER_TELEGRAM_ID)) issues.push('OWNER_TELEGRAM_ID: INVALID');
if (process.env.APP_ENCRYPTION_KEY && !/^[a-f0-9]{64}$/i.test(process.env.APP_ENCRYPTION_KEY)) issues.push('APP_ENCRYPTION_KEY: INVALID');
console.log(JSON.stringify({ ready: issues.length === 0, issues }, null, 2));
process.exitCode = issues.length ? 1 : 0;
