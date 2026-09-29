#!/usr/bin/env node
/**
 * 跑 wrangler，配置文件优先用 wrangler.local.jsonc（本机真实配置，不进仓库），没有就用 wrangler.jsonc。
 *   node scripts/wrangler.mjs deploy
 *   node scripts/wrangler.mjs d1 migrations apply table-db --remote
 * package.json 里的 deploy / migrate / tail 都走这里。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = existsSync(join(ROOT, 'wrangler.local.jsonc')) ? 'wrangler.local.jsonc' : 'wrangler.jsonc';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args, '-c', CONFIG], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  });
  process.exit(r.status ?? 1);
}
