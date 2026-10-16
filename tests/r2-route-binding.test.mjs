import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeRouteCatalog } from '../dsh-route-catalog/index.mjs';
import { apply } from '../plugins/route-binding.mjs';

const ROUTES = [
  { route_id: 'luna_primary', provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max', aliases: ['luna'] },
  { route_id: 'sol_deep', provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'max', aliases: ['sol-deep'] },
  { route_id: 'kimi_k3_256k', provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high', aliases: ['kimi'] },
];

const ROUTE_TOOL_NAMES = [
  'route_catalog_list',
  'route_catalog_resolve',
  'route_catalog_propose',
  'route_catalog_confirm',
  'route_auth_context',
  'route_bind_once',
];

function registerTool(registered, definition) {
  assert.ok(definition.output?.schema, `${definition.name} must declare output.schema`);
  assert.equal(typeof definition.output?.render, 'function', `${definition.name} must declare output.render`);
  registered.set(definition.name, definition);
}

function fixture(catalogDir = mkdtempSync(path.join(tmpdir(), 'r21-route-binding-'))) {
  if (!path.isAbsolute(catalogDir)) throw new Error('fixture catalog must be absolute');
  try { initializeRouteCatalog(catalogDir, { preset: 'shared', routes: ROUTES, approvalRef: 'test' }); } catch (error) {
    if (error?.code !== 'ROUTE_CATALOG_EXISTS') throw error;
  }
  const root = {
    id: 'root-agent',
    options: { subagentDepth: 0 },
    session: {
      id: 'root-session',
      header: { id: 'root-session' },
      events: [{ type: 'user/message', id: 'evt-1', seq: 1, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'route luna executor' }] } } }],
    },
  };
  const registered = new Map();
  const listeners = new Map();
  const setups = [];
  const ctx = {
    tools: { register(definition) { registerTool(registered, definition); } },
    subagents: {
      startContinuable: async () => { throw new Error('native start is not called by this unit test'); },
      registerContinuableSetup(setup) { setups.push(setup); return () => {}; },
    },
    llm: {
      async resolveModelInfo(provider, id) { return { provider, id, reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }, { id: 'max' }] } }; },
      listProviders() { return [{ id: 'openai-codex' }]; },
      async listModels() { return [{ id: 'gpt-5.6-luna', name: 'Luna' }]; },
    },
    agents: { currentInitiator() { return root; }, get() { return root; } },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
  };
  apply(ctx, { catalogDir, catalogPreset: 'shared', bindingTtlMs: 60_000 });
  return { catalogDir, root, registered, listeners, setups, ctx };
}

test('all R2.1 route tools satisfy the DSH output contract', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.catalogDir, { recursive: true, force: true }));
  assert.deepEqual([...f.registered.keys()], ROUTE_TOOL_NAMES);
  for (const name of ROUTE_TOOL_NAMES) {
    const rendered = f.registered.get(name).output.render({}, { tool: name, ok: true });
    assert.ok(Array.isArray(rendered), `${name} render must return content blocks`);
    assert.equal(rendered.length, 1, `${name} render must return one content block`);
    assert.equal(rendered[0]?.type, 'text', `${name} render must return a text block`);
    assert.equal(typeof rendered[0]?.text, 'string', `${name} render text must be a string`);
    assert.deepEqual(JSON.parse(rendered[0].text), { tool: name, ok: true });
  }
});

async function bind(fixtureValue, overrides = {}) {
  const tool = fixtureValue.registered.get('route_bind_once');
  return tool.execute({
    user_event_id: 'evt-1',
    quoted_directive: 'route luna executor',
    target_tool: 'subagent_executor',
    dispatch_label: `label-${Math.random()}`,
    route_id: 'luna_primary',
    ...overrides,
  }, { agent: fixtureValue.root, signal: new AbortController().signal });
}

function childRequest(f, label, inherited = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium' }) {
  const childListeners = new Map();
  const child = {
    agent: { session: { events: [{ type: 'subagent/descriptor', data: { label } }] } },
    on(name, listener) { childListeners.set(name, listener); return () => childListeners.delete(name); },
  };
  const disposer = f.setups[0](child);
  return Promise.resolve(childListeners.get('agent/request')({}, async () => inherited)).then((result) => ({ result, disposer }));
}

function plainChildRequest(f, inherited) {
  return childRequest(f, 'ordinary-child', inherited);
}

test('a role prefix picks up the panel-configured default route, and a broken config degrades to the preset default', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.catalogDir, { recursive: true, force: true }));
  const roleConfig = path.join(f.catalogDir, 'role-route.json');
  const writeRoleConfig = (value) => writeFileSync(roleConfig, typeof value === 'string' ? value : JSON.stringify(value));

  const inherited = { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' };

  // No configuration file at all: every role behaves exactly as before.
  const unconfigured = await childRequest(f, '[role=scout] plain scout', inherited);
  assert.deepEqual(unconfigured.result, inherited);

  // One configured role resolves to its route; an unlisted role keeps the preset default.
  writeRoleConfig({ version: 1, roles: { scout: { route_id: 'kimi_k3_256k' } } });
  const configured = await childRequest(f, '[role=scout] graded scout', inherited);
  assert.deepEqual(configured.result, { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high' });
  const unlisted = await childRequest(f, '[role=reviewer] unlisted role', inherited);
  assert.deepEqual(unlisted.result, inherited);

  // A route whose provider/model the effort map does not know still wins, and
  // the inherited effort is cleared rather than carried onto the new route.
  writeRoleConfig({ version: 1, roles: { executor: { route_id: 'sol_deep' } } });
  const otherRoute = await childRequest(f, '[role=executor] other route', { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'low' });  // inherited effort must not survive the switch
  assert.deepEqual(otherRoute.result, { provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'max' });

  // Every failure mode degrades instead of throwing: a role configuration can
  // never break a dispatch.
  for (const broken of [
    '{ not json',
    JSON.stringify({ version: 1, roles: { scout: { route_id: 'route_that_is_not_registered' } } }),
    JSON.stringify({ version: 1, roles: { scout: { route_id: 42 } } }),
    JSON.stringify({ version: 1 }),
  ]) {
    writeRoleConfig(broken);
    const degraded = await childRequest(f, '[role=scout] broken config', inherited);
    assert.deepEqual(degraded.result, inherited);
  }

  // A token binding still outranks a role prefix. The same role is configured
  // to Kimi here, so a result that came back as Kimi would mean the role
  // configuration had overridden an explicit dispatch — which it must not.
  writeRoleConfig({ version: 1, roles: { scout: { route_id: 'kimi_k3_256k' } } });
  const bound = await bind(f, { dispatch_label: 'scout-a', target_tool: 'subagent_scout' });
  const exec = { callId: 'call-role-precedence', name: 'subagent_scout', agent: f.root, arguments: { description: bound.descriptor_label } };
  await f.listeners.get('tools/pre-execute')(exec, () => Promise.resolve({ kind: 'allow' }));
  const boundResult = await f.listeners.get('tools/execute')(exec, async () => (await childRequest(f, bound.descriptor_label, { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high' })).result);
  assert.deepEqual(boundResult, { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' });
});

test('R2.1 direct binding is exact, token-scoped, and cold-resumable', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.catalogDir, { recursive: true, force: true }));
  assert.equal(f.listeners.get('agent/request'), undefined);
  const defaultRequest = await plainChildRequest(f, { provider: 'openai-codex', model: 'gpt-5.6-luna' });
  assert.deepEqual(defaultRequest.result, { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' });
  const kimiRequest = await plainChildRequest(f, { provider: 'kimi-coding', model: 'k3-256k' });
  assert.deepEqual(kimiRequest.result, { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high' });
  const bound = await bind(f, { dispatch_label: 'executor-a' });
  assert.match(bound.descriptor_label, /^r21-route-v1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{24}$/);
  const exec = { callId: 'call-a', name: 'subagent_executor', agent: f.root, arguments: { description: bound.descriptor_label } };
  const gate = await f.listeners.get('tools/pre-execute')(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.deepEqual(gate, { kind: 'allow' });
  const result = await f.listeners.get('tools/execute')(exec, async () => (await childRequest(f, bound.descriptor_label)).result);
  assert.deepEqual(result, { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' });

  const cold = fixture(f.catalogDir);
  t.after(() => rmSync(cold.catalogDir, { recursive: true, force: true }));
  const resumed = await childRequest(cold, bound.descriptor_label);
  assert.deepEqual(resumed.result, { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' });
});

test('heterogeneous concurrent bindings do not cross-wire and wrong scope fails closed', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.catalogDir, { recursive: true, force: true }));
  const [luna, sol] = await Promise.all([
    bind(f, { dispatch_label: 'luna-a' }),
    bind(f, { dispatch_label: 'sol-a', route_id: 'sol_deep', target_tool: 'subagent_executor_flash' }),
  ]);
  const makeExec = (callId, name, bound) => ({ callId, name, agent: f.root, arguments: { description: bound.descriptor_label } });
  const execA = makeExec('call-luna', 'subagent_executor', luna);
  const execB = makeExec('call-sol', 'subagent_executor_flash', sol);
  await f.listeners.get('tools/pre-execute')(execA, () => Promise.resolve({ kind: 'allow' }));
  await f.listeners.get('tools/pre-execute')(execB, () => Promise.resolve({ kind: 'allow' }));
  const [outA, outB] = await Promise.all([
    f.listeners.get('tools/execute')(execA, async () => (await childRequest(f, luna.descriptor_label)).result),
    f.listeners.get('tools/execute')(execB, async () => (await childRequest(f, sol.descriptor_label)).result),
  ]);
  assert.equal(outA.model, 'gpt-5.6-luna');
  assert.equal(outB.model, 'gpt-5.6-sol');
  const wrongTool = makeExec('call-wrong', 'subagent_reviewer', await bind(f, { dispatch_label: 'wrong-tool' }));
  await assert.rejects(
    f.listeners.get('tools/pre-execute')(wrongTool, () => Promise.resolve({ kind: 'allow' })),
    (error) => error.code === 'ROUTE_BINDING_SCOPE_MISMATCH',
  );
});

test('unknown route exposes candidates and publication requires exact confirmation', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.catalogDir, { recursive: true, force: true }));
  const resolve = f.registered.get('route_catalog_resolve');
  const unmatched = await resolve.execute({ query: 'gpt-5.6' }, { agent: f.root });
  assert.equal(unmatched.status, 'unmatched');
  assert.equal(unmatched.discovered_candidates[0].model, 'gpt-5.6-luna');
  await assert.rejects(bind(f, { route_id: 'unknown_route' }), (error) => error.code === 'ROUTE_NOT_FOUND');

  const propose = f.registered.get('route_catalog_propose');
  const proposal = await propose.execute({ route_id: 'new_route', provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' }, { agent: f.root, signal: new AbortController().signal });
  f.root.session.events.push({ type: 'user/message', id: 'evt-2', seq: 2, data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: proposal.confirmation_phrase }] } } });
  const confirm = f.registered.get('route_catalog_confirm');
  const committed = await confirm.execute({ proposal_id: proposal.proposal_id, confirmation_phrase: proposal.confirmation_phrase }, { agent: f.root, signal: new AbortController().signal });
  assert.equal(committed.route.route_id, 'new_route');
});

test('missing snapshot and malformed token never fall back', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.catalogDir, { recursive: true, force: true }));
  const bound = await bind(f, { dispatch_label: 'missing-snapshot' });
  unlinkSync(path.join(f.catalogDir, 'snapshots', `${bound.dispatch_ref}.json`));
  const child = { agent: { session: { events: [{ type: 'subagent/descriptor', data: { label: bound.descriptor_label } }] } }, on() { return () => {}; } };
  assert.throws(() => f.setups[0](child), (error) => error.code === 'ROUTE_SNAPSHOT_UNAVAILABLE');
  assert.throws(() => f.setups[0]({ agent: { session: { events: [{ type: 'subagent/descriptor', data: { label: 'r21-route-v1:bad' } }] } }, on() {} }), (error) => error.code === 'ROUTE_SNAPSHOT_UNAVAILABLE');
});

test('an expired claimed snapshot remains cold-resumable', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.catalogDir, { recursive: true, force: true }));
  const realNow = Date.now;
  let bound;
  try {
    Date.now = () => 1_000_000;
    bound = await bind(f, { dispatch_label: 'expired-after-claim' });
    const exec = { callId: 'expired-call', name: 'subagent_executor', agent: f.root, arguments: { description: bound.descriptor_label } };
    await f.listeners.get('tools/pre-execute')(exec, () => Promise.resolve({ kind: 'allow' }));
  } finally {
    Date.now = realNow;
  }
  const cold = fixture(f.catalogDir);
  t.after(() => rmSync(cold.catalogDir, { recursive: true, force: true }));
  const resumed = await childRequest(cold, bound.descriptor_label);
  assert.deepEqual(resumed.result, { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' });
});

test('cold resume rejects a claimed snapshot whose route identity was tampered', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.catalogDir, { recursive: true, force: true }));
  const bound = await bind(f, { dispatch_label: 'tampered-snapshot' });
  const exec = { callId: 'tampered-call', name: 'subagent_executor', agent: f.root, arguments: { description: bound.descriptor_label } };
  await f.listeners.get('tools/pre-execute')(exec, () => Promise.resolve({ kind: 'allow' }));
  const snapshotPath = path.join(f.catalogDir, 'snapshots', `${bound.dispatch_ref}.json`);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  snapshot.provider = 'kimi-coding';
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  const cold = fixture(f.catalogDir);
  t.after(() => rmSync(cold.catalogDir, { recursive: true, force: true }));
  assert.throws(
    () => cold.setups[0]({ agent: { session: { events: [{ type: 'subagent/descriptor', data: { label: bound.descriptor_label } }] } }, on() {} }),
    (error) => error.code === 'ROUTE_SNAPSHOT_CONFLICT',
  );
});
