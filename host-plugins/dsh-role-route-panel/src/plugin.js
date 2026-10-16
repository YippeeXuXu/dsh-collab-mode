/**
 * 角色默认路由面板 —— 宿主半。
 *
 * 面板为每个子代理角色选定一条**已注册路线**（模型 + 思考强度），结果写进
 * 共享 route catalog 目录下的 `role-route.json`。运行时那一侧由
 * `r21-route-binding` 读同一个文件：派发标签带 `[role=…]` 且该角色已配置时，
 * 它用这条路线覆盖 provider/model/effort；未配置或文件损坏则退回预设默认。
 *
 * ## 为什么必须由目录校验后才允许落盘
 *
 * 写错一个 route_id 不会报错：运行时那侧找不到路线就静默退回预设默认，于是
 * 面板显示 Kimi、实际跑 Luna，而没有任何地方报错。所以这里在**写入前**逐项
 * 对 catalog 校验角色名与 route_id，宁可这次保存失败，也不存进一份看起来
 * 正常、实际不生效的配置。
 *
 * ## 边界
 *
 * 只服务回环请求（面板与宿主同机）；不接受目录外的路径；不接触任何凭据。
 *
 * @module dsh-role-route-panel
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const name = 'role-route-panel';
export const inject = ['webServer'];

/** 面板可配置的角色，与 route-binding 的角色白名单逐字一致。 */
export const ROLES = [
  'scout',
  'scout_flash',
  'executor',
  'executor_flash',
  'reviewer',
  'reviewer_qwen',
  'reviewer_vl',
];

export const BASE_PATH = '/api/role-route';
export const CONFIG_FILE = 'role-route.json';

const WEB_SERVER_NAMES = ['webServer', 'httpServer'];
const MAX_BODY_BYTES = 64 * 1024;
const CLIENT_ERRORS = new Set([
  'ROLE_ROUTE_INVALID',
  'ROLE_ROUTE_UNKNOWN_ROLE',
  'ROLE_ROUTE_UNKNOWN_ROUTE',
  'ROLE_ROUTE_UNSAFE',
]);

function roleRouteError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

/**
 * 读共享 route catalog（只读）。
 *
 * 这里刻意**不**导入 `dsh-route-catalog` 模块：它只是预设目录里的一个 `.mjs`，
 * 不是可解析的包，从一个 profile bundle 里 import 它需要知道预设目录长什么样，
 * 那个耦合比读一个文件更脆。目录的写入与校验规则属于 route-binding，这里只把
 * 它当作**已注册路线的只读清单**——形状不对就当作没有候选，而不是自己解释它。
 */
export function loadCatalog(dir) {
  const file = path.join(dir, 'catalog.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw roleRouteError('ROLE_ROUTE_CATALOG_UNAVAILABLE', `${file} is not readable JSON (${error?.code ?? error?.message ?? error})`);
  }
  const routes = parsed?.routes;
  if (!Array.isArray(routes)) throw roleRouteError('ROLE_ROUTE_CATALOG_UNAVAILABLE', `${file} has no routes array`);
  for (const route of routes) {
    if (typeof route?.route_id !== 'string' || typeof route?.provider !== 'string' || typeof route?.model !== 'string') {
      throw roleRouteError('ROLE_ROUTE_CATALOG_UNAVAILABLE', `${file} has a malformed route entry`);
    }
  }
  return routes;
}

/**
 * 共享 route catalog 目录。
 *
 * 面板与 route-binding 必须指向**同一个**目录，否则面板写下去的配置运行时根本
 * 看不见——而且不会报错，只会表现成“改了没反应”。所以这里不接受侥幸：逐个候选
 * 目录实际读一次，只有读得出路线清单的才算数。
 */
export function resolveCatalogDir(config = {}, env = process.env) {
  const candidates = [
    config.catalogDir,
    env.DSH_ROLE_ROUTE_CATALOG_DIR,
    path.join(env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'route-catalog', 'shared'),
  ].filter((value) => typeof value === 'string' && path.isAbsolute(value));
  for (const candidate of candidates) {
    try {
      loadCatalog(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw roleRouteError('ROLE_ROUTE_CATALOG_UNAVAILABLE', `no readable route catalog among ${candidates.join(', ') || '(none)'}`);
}

/**
 * 目录里不是每个文件都能当作配置读。
 *
 * 该目录由 route-binding 以 0700/0600 建起并逐文件断言私有权限；这里沿用同一
 * 约定：非普通文件或权限过宽都不接受，免得把一份可被他人替换的文件当成路由真源。
 */
function assertPrivateFile(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile()) throw roleRouteError('ROLE_ROUTE_UNSAFE', `${file} is not a regular file`);
  if ((stat.mode & 0o777) !== 0o600) throw roleRouteError('ROLE_ROUTE_UNSAFE', `${file} must be private (0600)`);
  return true;
}

/**
 * 读配置。文件缺失返回空配置（面板显示“未配置”），文件损坏则明确报错——两者
 * 要区分：缺失是正常状态，损坏是有人动过它、需要被看见。
 */
export function readRoleConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  if (!assertPrivateFile(file)) return { version: 1, roles: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw roleRouteError('ROLE_ROUTE_INVALID', `${CONFIG_FILE} is not valid JSON`);
  }
  const roles = parsed?.roles;
  if (roles === undefined || roles === null || typeof roles !== 'object' || Array.isArray(roles)) {
    throw roleRouteError('ROLE_ROUTE_INVALID', `${CONFIG_FILE} has no roles object`);
  }
  return {
    version: 1,
    ...(parsed.updated_at === undefined ? {} : { updated_at: parsed.updated_at }),
    ...(parsed.note === undefined ? {} : { note: parsed.note }),
    roles,
  };
}

/** 面板的候选来源：目录里每条已注册路线。 */
export function catalogRoutes(routes) {
  return routes.map((route) => ({
    route_id: route.route_id,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    ...(Array.isArray(route.aliases) ? { aliases: route.aliases } : {}),
  }));
}

/**
 * 校验并合并一次写入。
 *
 * 未知的角色名与未注册的 route_id 一律拒绝，而不是忽略：静默丢弃一个拼错的
 * 角色名，与静默退回默认是同一种失败。`null` 是显式的“恢复未配置”。
 */
export function mergeRoleConfig(current, patch, routes) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw roleRouteError('ROLE_ROUTE_INVALID', 'patch must be an object');
  }
  const known = new Set(ROLES);
  const knownRoutes = new Set(routes.map((route) => route.route_id));
  const roles = { ...(current.roles ?? {}) };
  for (const [role, value] of Object.entries(patch)) {
    if (!known.has(role)) throw roleRouteError('ROLE_ROUTE_UNKNOWN_ROLE', `unknown role "${role}"`);
    if (value === null) {
      delete roles[role];
      continue;
    }
    const routeId = value?.route_id;
    if (typeof routeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(routeId)) {
      throw roleRouteError('ROLE_ROUTE_INVALID', `role "${role}" has no usable route_id`);
    }
    if (!knownRoutes.has(routeId)) {
      throw roleRouteError('ROLE_ROUTE_UNKNOWN_ROUTE', `route "${routeId}" is not registered`);
    }
    roles[role] = { route_id: routeId };
  }
  return { version: 1, updated_at: new Date().toISOString(), roles };
}

/**
 * 原子落盘。
 *
 * 运行时每次派发都重读这个文件，读到半个文件就等于那次派发退回默认，所以先写
 * 临时文件再 rename，并保证 0600。
 */
export function writeRoleConfig(dir, config) {
  const file = path.join(dir, CONFIG_FILE);
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  return file;
}

/**
 * 回环判断。**逐字对齐 `dsh-tokenledger/src/http.js` 的既有实现**。
 *
 * 早先这里写的是 `address.startsWith('127.')`，那是错的：`127.attacker.tld`
 * 这类**域名**也以 `127.` 开头，于是配合 DNS rebinding 与一个不过预检的
 * simple POST，任意网页就能读写本 API。用锚定的点分四段正则，域名一律不匹配。
 *
 * `::ffff:127.0.0.1` 是双栈监听下 Node 实际报出来的形式，必须识别，否则每个
 * 本机请求都会被当成外部来源拒掉。
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (bare === '::1' || bare === 'localhost') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Host 头去掉端口，容忍方括号包裹的 IPv6 字面量。 */
export function hostNameOf(header) {
  if (typeof header !== 'string' || header === '') return '';
  if (header.startsWith('[')) return header.slice(1, header.indexOf(']'));
  const colon = header.lastIndexOf(':');
  return colon === -1 ? header : header.slice(0, colon);
}

function hostParts(header) {
  if (typeof header !== 'string' || header === '') return null;
  if (header.startsWith('[')) {
    const end = header.indexOf(']');
    if (end === -1) return null;
    const rest = header.slice(end + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return null;
    return { hostname: header.slice(1, end), port: rest === '' ? '' : rest.slice(1) };
  }
  const firstColon = header.indexOf(':');
  const lastColon = header.lastIndexOf(':');
  if (firstColon !== lastColon) return null;
  return firstColon === -1
    ? { hostname: header, port: '' }
    : (/^:\d+$/.test(header.slice(firstColon))
      ? { hostname: header.slice(0, firstColon), port: header.slice(firstColon + 1) }
      : null);
}

function sameOriginAsHost(origin, hostHeader) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = hostParts(hostHeader);
  if (host === null) return false;
  const originHostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  if (originHostname.toLowerCase() !== host.hostname.toLowerCase()) return false;
  const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
  return (parsed.port || defaultPort) === (host.port || defaultPort);
}

/** 只服务本机面板；写请求必须是面板使用的 PUT JSON，跨站来源一律 403。 */
export function screenRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress) || !isLoopbackAddress(hostNameOf(req?.headers?.host))) {
    return { status: 403, body: { ok: false, error: 'forbidden' } };
  }
  const origin = req?.headers?.origin;
  if (origin !== undefined && !sameOriginAsHost(origin, req?.headers?.host)) {
    return { status: 403, body: { ok: false, error: 'forbidden' } };
  }
  const method = req?.method;
  if (method === 'GET') return undefined;
  if (method !== 'PUT') {
    return { status: 405, body: { ok: false, error: 'method-not-allowed' } };
  }
  const contentType = req?.headers?.['content-type'];
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return { status: 415, body: { ok: false, error: 'unsupported-media-type' } };
  }
  return undefined;
}

function send(res, status, body) {
  res?.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res?.end?.(`${JSON.stringify(body)}\n`);
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw roleRouteError('ROLE_ROUTE_INVALID', 'request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw roleRouteError('ROLE_ROUTE_INVALID', 'request body is not valid JSON');
  }
}

export function apply(ctx, config = {}) {
  const dir = resolveCatalogDir(config);
  const logger = ctx.logger;
  // 选错目录不会报错，只会表现成“面板改了没反应”，所以把实际选中的目录写进日志。
  logger?.info?.('role-route-panel: using catalog dir %s', dir);

  const snapshot = () => ({
    ok: true,
    path: path.join(dir, CONFIG_FILE),
    roles: ROLES,
    routes: catalogRoutes(loadCatalog(dir)),
    config: readRoleConfig(dir),
  });

  const handle = async (req, res) => {
    const refused = screenRequest(req);
    if (refused !== undefined) return send(res, refused.status, refused.body);
    try {
      if (req.method === 'GET') return send(res, 200, snapshot());
      const merged = mergeRoleConfig(readRoleConfig(dir), (await readBody(req))?.roles ?? {}, catalogRoutes(loadCatalog(dir)));
      const file = writeRoleConfig(dir, merged);
      logger?.info?.('role-route-panel: wrote %s', file);
      return send(res, 200, snapshot());
    } catch (error) {
      const code = error?.code ?? 'ROLE_ROUTE_FAILED';
      logger?.warn?.('role-route-panel: %s %s', code, error?.message ?? error);
      return send(res, CLIENT_ERRORS.has(code) ? 400 : 500, { ok: false, error: code, detail: String(error?.message ?? error) });
    }
  };

  let attached = false;
  const attach = (scoped, serverName) => {
    const server = scoped?.[serverName];
    if (attached || server === undefined || typeof server.register !== 'function') return;
    attached = true;
    clearTimeout(nagging);
    ctx.effect(
      () => server.register({ kind: 'exact', path: BASE_PATH, handler: handle }),
      'role-route panel route',
    );
    logger?.info?.('role-route-panel: serving %s via %s', BASE_PATH, serverName);
  };

  const nagging = setTimeout(() => {
    if (attached) return;
    logger?.warn?.('role-route-panel: still no web server after 10s — the panel will 404 (%s)', BASE_PATH);
  }, config.routeWaitMs ?? 10_000);
  nagging.unref?.();

  for (const serviceName of WEB_SERVER_NAMES) {
    // 已经存在的服务直接接上；否则等它出现。两个名字都真实存在，只问其中
    // 一个是面板一直 404 的老路。
    const immediate = typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined;
    if (immediate !== undefined && typeof immediate.register === 'function') {
      attach(ctx, serviceName);
      continue;
    }
    ctx.inject([serviceName], (scoped) => attach(scoped, serviceName));
  }
}
