import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONFIG_FILE,
  ROLES,
  hostNameOf,
  isLoopbackAddress,
  catalogRoutes,
  mergeRoleConfig,
  readRoleConfig,
  screenRequest,
  writeRoleConfig,
} from '../host-plugins/dsh-role-route-panel/src/plugin.js';
import { initializeRouteCatalog } from '../dsh-route-catalog/index.mjs';

const ROUTES = [
  { route_id: 'luna6_deep', provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'max', aliases: ['luna6-max'] },
  { route_id: 'kimi_k3_256k', provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high', aliases: ['kimi'] },
  { route_id: 'deepseek_official', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
];

/** 候选来源现在是一份路线清单，与宿主读到的 catalog.json 形状一致。 */
const list = (value = ROUTES) => value;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'role-route-panel-'));
  initializeRouteCatalog(dir, { preset: 'shared', routes: ROUTES, approvalRef: 'test' });
  return dir;
}

test('候选来自目录，未声明强度的路线不带该字段', () => {
  const routes = catalogRoutes(list());
  assert.deepEqual(routes.map((route) => route.route_id), ['luna6_deep', 'kimi_k3_256k', 'deepseek_official']);
  assert.equal(routes[0].reasoningEffort, 'max');
  assert.equal('reasoningEffort' in routes[2], false);
});

test('每个可配置角色都被接受，未注册路线被拒绝而不是忽略', () => {
  for (const role of ROLES) {
    const merged = mergeRoleConfig({ roles: {} }, { [role]: { route_id: 'luna6_deep' } }, catalogRoutes(list()));
    assert.deepEqual(merged.roles[role], { route_id: 'luna6_deep' });
  }
  assert.throws(
    () => mergeRoleConfig({ roles: {} }, { scout: { route_id: 'not_registered' } }, catalogRoutes(list())),
    (error) => error.code === 'ROLE_ROUTE_UNKNOWN_ROUTE',
  );
  assert.throws(
    () => mergeRoleConfig({ roles: {} }, { not_a_role: { route_id: 'luna6_deep' } }, catalogRoutes(list())),
    (error) => error.code === 'ROLE_ROUTE_UNKNOWN_ROLE',
  );
  assert.throws(
    () => mergeRoleConfig({ roles: {} }, { scout: { route_id: 42 } }, catalogRoutes(list())),
    (error) => error.code === 'ROLE_ROUTE_INVALID',
  );
});

test('merge 保留未提及的角色，null 表示恢复未配置', () => {
  const current = { version: 1, roles: { scout: { route_id: 'luna6_deep' }, reviewer: { route_id: 'kimi_k3_256k' } } };
  const merged = mergeRoleConfig(current, { reviewer: null, executor: { route_id: 'luna6_deep' } }, catalogRoutes(list()));
  assert.deepEqual(merged.roles, { scout: { route_id: 'luna6_deep' }, executor: { route_id: 'luna6_deep' } });
});

test('读写往返：0600、原子、且缺失即空配置', () => {
  const dir = fixture();
  try {
    assert.deepEqual(readRoleConfig(dir).roles, {});
    writeRoleConfig(dir, { version: 1, updated_at: '2026-09-23T00:00:00.000Z', roles: { scout: { route_id: 'kimi_k3_256k' } } });
    const file = path.join(dir, CONFIG_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readRoleConfig(dir).roles, { scout: { route_id: 'kimi_k3_256k' } });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏的配置报错，而不是被当成空配置', () => {
  const dir = fixture();
  try {
    const file = path.join(dir, CONFIG_FILE);
    writeFileSync(file, '{ not json', { mode: 0o600 });
    assert.throws(() => readRoleConfig(dir), (error) => error.code === 'ROLE_ROUTE_INVALID');
    writeFileSync(file, JSON.stringify({ version: 1 }), { mode: 0o600 });
    assert.throws(() => readRoleConfig(dir), (error) => error.code === 'ROLE_ROUTE_INVALID');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('权限过宽的配置文件被拒绝，不当作真源', () => {
  const dir = fixture();
  try {
    const file = path.join(dir, CONFIG_FILE);
    writeFileSync(file, JSON.stringify({ version: 1, roles: {} }), { mode: 0o644 });
    assert.throws(() => readRoleConfig(dir), (error) => error.code === 'ROLE_ROUTE_UNSAFE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回环判断只认精确地址，以 127. 开头的域名一律拒绝', () => {
  // 本机形式必须通过，否则每个本机请求都会被拒。
  for (const ok of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', 'localhost']) {
    assert.equal(isLoopbackAddress(ok), true, `${ok} should be loopback`);
  }
  // 以 127. 开头的域名曾经在这里通过——那等于把 API 交给任意网页。
  for (const bad of ['127.attacker.tld', '127.0.0.1.nip.io', '127.evil.com', '10.0.0.9', '::ffff:10.0.0.9', '', 'not-an-address', '127.0.0.1:3080']) {
    assert.equal(isLoopbackAddress(bad), false, `${bad} must not be loopback`);
  }
  assert.equal(hostNameOf('[::1]:3080'), '::1');
  assert.equal(hostNameOf('127.0.0.1:3080'), '127.0.0.1');
  assert.equal(hostNameOf('127.attacker.tld'), '127.attacker.tld');
});

test('只接受回环来源，非 GET/PUT/POST 一律拒绝', () => {
  const local = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } };
  assert.equal(screenRequest(local), undefined);
  assert.equal(screenRequest({ ...local, socket: { remoteAddress: '10.0.0.9' } }).status, 403);
  assert.equal(screenRequest({ ...local, headers: { host: 'evil.example.com' } }).status, 403);
  assert.equal(screenRequest({ ...local, headers: { host: '127.attacker.tld' } }).status, 403);
  assert.equal(screenRequest({ ...local, headers: { host: '127.0.0.1.nip.io:3080' } }).status, 403);
  assert.equal(screenRequest({ ...local, headers: { host: 'localhost:3080' } }), undefined);
  assert.equal(screenRequest({ ...local, method: 'DELETE' }).status, 405);
});
