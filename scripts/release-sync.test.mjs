#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'dsh-release-sync-'));
try {
  for (const name of ['agent.cordis.yml', 'governance', 'scripts']) {
    cpSync(path.join(root, name), path.join(temp, name), { recursive: true });
  }
  const script = path.join(temp, 'scripts', 'release-sync.mjs');
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('--verify');

  const hashFile = path.join(temp, 'governance', 'projection-hashes.json');
  const hashes = JSON.parse(readFileSync(hashFile, 'utf8'));
  hashes.spec_sha256 = '0'.repeat(64);
  writeFileSync(hashFile, JSON.stringify(hashes, null, 2) + '\n');
  assert.throws(() => run('--verify'), /spec_sha256 mismatch/u);

  run();
  const agentFile = path.join(temp, 'agent.cordis.yml');
  const agent = readFileSync(agentFile, 'utf8');
  writeFileSync(agentFile, agent.replace('# DSH 协作模式 Planner Persona v4.3（常驻运行投影）', '# DSH 协作模式 Planner Persona v4.3（篡改）'));
  assert.throws(() => run('--verify'), /embedded planner-kernel mismatch/u);
  console.log('release-sync tests: OK');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
