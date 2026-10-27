import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const modules = ['server.mjs', 'mcp-server.mjs', 'project-catalog.mjs', 'project-settings.mjs'];

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docviewer-mcp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const favorite = path.join(home, 'Избранный');
  const editor = path.join(home, 'Cursor project');
  const hidden = path.join(home, 'hidden');
  const storage = path.join(home, 'Library/Application Support/Cursor/User/workspaceStorage/one');
  for (const folder of [favorite, editor, hidden, storage]) await fs.mkdir(folder, { recursive: true });
  for (const file of modules) await fs.copyFile(path.join(root, file), path.join(dir, file));
  const settings = { title: 'Title', description: 'Проверки стандартов СМК', sections: [],
    favorites: ['README.md'], hiddenFiles: ['private.txt'], custom: { preserve: true } };
  await fs.writeFile(path.join(favorite, 'docviewer.json'), JSON.stringify(settings));
  await fs.writeFile(path.join(editor, 'docviewer.json'), JSON.stringify({ description: 'Редактор организационной структуры' }));
  await fs.writeFile(path.join(storage, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(editor.normalize('NFD')).href }));
  const entries = { projects: [{ name: 'СМК', path: favorite }, { name: 'Hidden', path: hidden, fav: false }] };
  await fs.writeFile(path.join(dir, 'projects.json'), JSON.stringify(entries));
  await fs.writeFile(path.join(dir, 'workspaces.json'), JSON.stringify({ hidden: [hidden], extra: [] }));
  const env = { ...process.env, HOME: home, DOCVIEWER_ROOTS: '', DOCVIEWER_ROOT: '', DOCVIEWER_NO_OPEN: '1' };
  const start = (file, overrides = {}) => {
    const child = spawn(process.execPath, [path.join(dir, file)], { cwd: dir, env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
    return child;
  };
  return { dir, favorite, editor, hidden, storage, settings, entries, start };
}

function client(child) {
  let sequence = 0;
  const pending = new Map(), received = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line); // Any startup log on stdout fails the test.
    received.push(message);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + stderr)); }, 5000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return {
    request, notify, received, stderr: () => stderr,
    async initialize() {
      const reply = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      assert.equal(reply.result.protocolVersion, '2025-06-18');
      assert.ok(reply.result.capabilities.tools);
      notify('notifications/initialized');
    },
    async tool(name, args = {}) {
      const reply = await request('tools/call', { name, arguments: args });
      assert.ok(reply.result, JSON.stringify(reply));
      if (!reply.result.isError) assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
      return reply.result;
    },
  };
}

async function web(f) {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = f.start('server.mjs', { DOCVIEWER_PORT: String(port) });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('HTTP startup timeout: ' + output)), 5000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('http://127.0.0.1:')) { clearTimeout(timer); resolve(); }
    });
  });
  return async (url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
}

test('stdio MCP negotiates, searches descriptions, keeps favorites cheap and discovers Cursor explicitly', async (t) => {
  const f = await fixture(t);
  const workspaceFile = path.join(f.storage, 'workspace.json');
  await fs.writeFile(workspaceFile, JSON.stringify({ folder: 'file:///nonexistent-docviewer-test-root' }));
  const c = client(f.start('mcp-server.mjs'));
  assert.equal((await c.request('tools/list', {})).error.code, -32600);
  await c.initialize();
  const list = await c.request('tools/list', {});
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['list_projects', 'get_project']);
  assert.ok(list.result.tools.every((tool) => tool.annotations.readOnlyHint));
  const favorites = (await c.tool('list_projects')).structuredContent;
  assert.equal(favorites.scope, 'starred');
  assert.deepEqual(favorites.projects.map((p) => p.path), [f.favorite]);
  assert.equal(favorites.projects[0].description, f.settings.description);
  assert.equal(favorites.projects[0].starred, true);
  assert.equal((await c.tool('list_projects', { query: 'стандартов смк' })).structuredContent.total, 1);
  const noMatch = (await c.tool('list_projects', { query: 'организационной' })).structuredContent;
  assert.equal(noMatch.total, 0);
  assert.match(noMatch.hint, /scope="all"/);
  // If starred calls had scanned histories, the 20-second discovery cache would
  // still contain the missing path and this newly restored workspace would be absent.
  await fs.writeFile(workspaceFile, JSON.stringify({ folder: pathToFileURL(f.editor.normalize('NFD')).href }));
  const all = (await c.tool('list_projects', { scope: 'all', query: 'организационной' })).structuredContent;
  assert.deepEqual(all.projects.map((p) => p.path), [f.editor]);
  assert.deepEqual(all.projects[0].sources, ['cursor']);
  assert.equal((await c.tool('list_projects', { scope: 'all' })).structuredContent.total, 2);
  const page = (await c.tool('list_projects', { scope: 'all', include_hidden: true, limit: 1 })).structuredContent;
  assert.equal(page.total, 3);
  assert.equal(page.nextOffset, 1);
  assert.equal((await c.tool('list_projects', { scope: 'all', include_hidden: true, offset: 1 })).structuredContent.projects.length, 2);
  assert.equal((await c.tool('get_project', { path: f.editor })).structuredContent.project.path, f.editor);
  assert.equal((await c.tool('get_project', { path: os.tmpdir() })).isError, true);
  assert.equal((await c.tool('list_projects', { limit: 101 })).isError, true);
  assert.equal((await c.tool('list_projects', { include_hidden: 'false' })).isError, true);
  assert.equal((await c.tool('list_projects', { scope: 'invalid' })).isError, true);
  assert.equal((await c.request('tools/call', { name: 'missing' })).error.code, -32602);
  await assert.rejects(fs.access(path.join(f.hidden, 'docviewer.json'))); // queries create no files
  assert.equal(c.received.filter((reply) => !('id' in reply)).length, 0);
});

test('UI description writes reach the running MCP and preserve project settings', async (t) => {
  const f = await fixture(t);
  const request = await web(f);
  const c = client(f.start('mcp-server.mjs'));
  await c.initialize();
  await c.tool('list_projects');
  const updated = 'Новое описание проекта через UI';
  const save = await request('/api/project-settings', { path: f.favorite.normalize('NFD'), description: updated });
  assert.equal(save.status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.favorite, 'docviewer.json'))), { ...f.settings, description: updated });
  assert.equal((await request('/api/config')).data.description, updated);
  assert.equal((await request('/api/projects')).data.projects[0].description, updated);
  assert.equal((await request('/api/workspaces')).data.items.find((p) => p.path === f.favorite).description, updated);
  assert.equal((await c.tool('list_projects', { query: 'Новое' })).structuredContent.projects[0].description, updated);
  assert.equal((await request('/api/project-settings', { path: f.dir, description: 'outside' })).status, 400);
  assert.equal((await request('/api/project-settings', { path: f.favorite, description: null })).status, 400);
  assert.equal((await request('/api/project-settings', { path: f.favorite, description: 'x'.repeat(2001) })).status, 400);

  // A discovered project can be described without starring or registering it.
  assert.equal((await request('/api/project-settings', { path: f.editor, description: 'Из Cursor' })).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dir, 'projects.json'))), f.entries);
  assert.equal((await c.tool('get_project', { path: f.editor })).structuredContent.project.description, 'Из Cursor');
  await request('/api/workspaces', { action: 'fav', path: f.editor });
  assert.equal((await c.tool('list_projects')).structuredContent.total, 2);

  await Promise.all([
    request('/api/config', { description: 'Concurrent description' }),
    request('/api/config', { hiddenFiles: [] }),
    request('/api/favorite', { path: 'another.md', on: true }),
  ]);
  const config = (await request('/api/config')).data;
  assert.equal(config.description, 'Concurrent description');
  assert.deepEqual(config.hiddenFiles, []);
  assert.ok(config.favorites.some((f) => f.path === 'another.md'));

  await fs.writeFile(path.join(f.favorite, 'docviewer.json'), '{ broken');
  assert.equal((await request('/api/project-settings', { path: f.favorite, description: 'Do not overwrite' })).status, 400);
  assert.equal(await fs.readFile(path.join(f.favorite, 'docviewer.json'), 'utf8'), '{ broken');
  assert.equal((await c.tool('list_projects')).structuredContent.projects.find((p) => p.path === f.favorite).description, '');
});

test('legacy subtitle becomes the only editable description; title reaches UI and MCP', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.favorite, 'docviewer.json');
  const { description, ...other } = f.settings;
  await fs.writeFile(file, JSON.stringify({ ...other, subtitle: 'Прежнее описание' }));
  const request = await web(f);
  const c = client(f.start('mcp-server.mjs'));
  await c.initialize();
  const before = (await request('/api/config')).data;
  assert.equal(before.description, 'Прежнее описание');
  assert.equal(Object.hasOwn(before, 'subtitle'), false);
  assert.equal((await c.tool('list_projects', { query: 'Прежнее' })).structuredContent.total, 1);

  const title = 'Центр качества';
  assert.equal((await request('/api/project-settings', { title })).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(file)), { ...other, title, description: 'Прежнее описание' });
  assert.equal((await request('/api/config')).data.title, title);
  assert.equal((await request('/api/projects')).data.projects[0].title, title);
  assert.equal((await request('/api/workspaces')).data.items.find((it) => it.path === f.favorite).title, title);
  assert.equal((await c.tool('list_projects', { query: title })).structuredContent.projects[0].title, title);

  // An explicit description wins over the obsolete subtitle, including a deliberately empty value.
  await fs.writeFile(file, JSON.stringify({ ...other, subtitle: 'Устаревшее', description: 'Актуальное' }));
  assert.equal((await request('/api/config')).data.description, 'Актуальное');
  assert.equal((await request('/api/project-settings', { description: '' })).status, 200);
  assert.equal((await request('/api/config')).data.description, '');
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(file)), 'subtitle'), false);

  for (const invalid of ['', '   ', 10, null, 'x'.repeat(201)]) {
    const unchanged = await fs.readFile(file, 'utf8');
    assert.equal((await request('/api/project-settings', { title: invalid })).status, 400);
    assert.equal((await request('/api/config', { title: invalid })).status, 400);
    assert.equal(await fs.readFile(file, 'utf8'), unchanged);
  }
  assert.equal((await request('/api/project-settings', {})).status, 400);
});

test('default titles are resolved identically by config, catalog, meta and MCP', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.favorite, 'docviewer.json');
  const request = await web(f);
  const c = client(f.start('mcp-server.mjs'));
  await c.initialize();
  for (const title of [undefined, '', '  ', 'Навигация по документации', 'Собственное название']) {
    const cfg = { ...f.settings };
    if (title === undefined) delete cfg.title;
    else cfg.title = title;
    const original = JSON.stringify(cfg);
    await fs.writeFile(file, original);
    const expected = title === 'Собственное название' ? title : 'СМК';
    assert.equal((await request('/api/config')).data.title, expected);
    const meta = (await request('/api/meta')).data;
    assert.equal(meta.title, expected);
    assert.equal(meta.projects[0].title, expected);
    assert.equal((await request('/api/projects')).data.projects[0].title, expected);
    assert.equal((await request('/api/workspaces')).data.items.find((it) => it.path === f.favorite).title, expected);
    assert.equal((await c.tool('get_project', { path: f.favorite })).structuredContent.project.title, expected);
    assert.equal(await fs.readFile(file, 'utf8'), original, 'read-only requests do not migrate settings');
  }
  assert.equal((await c.tool('get_project', { path: f.editor })).structuredContent.project.title, 'Cursor project');
  assert.equal((await c.tool('get_project', { path: f.hidden })).structuredContent.project.title, 'Hidden');
  await fs.writeFile(file, '{ broken');
  assert.equal((await request('/api/config')).data.title, 'СМК');
  assert.equal((await c.tool('get_project', { path: f.favorite })).structuredContent.project.title, 'СМК');
});
