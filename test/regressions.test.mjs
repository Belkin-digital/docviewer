import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('manual addition restores a hidden Cursor workspace, including NFC/NFD paths', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docviewer-regression-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const folder = path.join(home, 'HR поиск и найм', 'Orgstructure');
  const storage = path.join(home, 'Library/Application Support/Cursor/User/workspaceStorage/org');
  const bin = path.join(dir, 'bin');
  await Promise.all([fs.mkdir(folder, { recursive: true }), fs.mkdir(storage, { recursive: true }), fs.mkdir(bin)]);
  for (const file of ['server.mjs', 'project-catalog.mjs', 'project-settings.mjs']) {
    await fs.copyFile(path.join(root, file), path.join(dir, file));
  }
  await fs.writeFile(path.join(dir, 'projects.json'), JSON.stringify({ projects: [folder] }));
  await fs.writeFile(path.join(storage, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder.normalize('NFD')).href }));
  const pickerResult = path.join(dir, 'chosen.txt');
  await fs.writeFile(pickerResult, folder.normalize('NFD') + '/\n');
  // Exercise the actual picker endpoint without displaying a native dialog during tests.
  await fs.writeFile(path.join(bin, 'osascript'), '#!/bin/sh\ncat "$DOCVIEWER_TEST_PICKER_RESULT"\n', { mode: 0o755 });
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], {
    cwd: dir,
    env: { ...process.env, HOME: home, DOCVIEWER_ROOT: '', DOCVIEWER_ROOTS: '', DOCVIEWER_PORT: String(port),
      DOCVIEWER_NO_OPEN: '1', PATH: bin + path.delimiter + process.env.PATH, DOCVIEWER_TEST_PICKER_RESULT: pickerResult },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  let log = '';
  child.stderr.on('data', (chunk) => { log += chunk; });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + log)), 10000);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(log)); });
    child.stdout.on('data', (chunk) => {
      log += chunk;
      const port = log.match(/http:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
      if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port); }
    });
  });
  const request = async (url, body) => {
    const res = await fetch(origin + url, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : undefined);
    return { status: res.status, data: await res.json() };
  };
  const seedHidden = () => fs.writeFile(path.join(dir, 'workspaces.json'), JSON.stringify({
    hidden: [folder.normalize('NFD'), path.join(home, 'other')], extra: [folder.normalize('NFD')],
  }));
  const workspace = async () => (await request('/api/workspaces')).data.items.find((it) => it.path === folder);

  await t.test('Cursor discovery preserves the hidden state before adding', async () => {
    await seedHidden();
    const item = await workspace();
    assert.ok(item.sources.includes('cursor'));
    assert.equal(item.hidden, true);
  });
  for (const route of ['/api/workspaces', '/api/pickfolder']) {
    await t.test(route + ' restores and deduplicates the chosen folder', async () => {
      await seedHidden();
      const result = await request(route, route === '/api/workspaces' ? { action: 'add', path: folder } : {});
      assert.equal(result.status, 200);
      if (route === '/api/pickfolder') assert.equal(result.data.path, folder);
      const item = await workspace();
      assert.equal(item.hidden, false);
      assert.ok(item.sources.includes('cursor'));
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'workspaces.json'), 'utf8'));
      assert.equal(saved.extra.length, 1);
      assert.deepEqual(saved.hidden, [path.join(home, 'other')]);
    });
  }
  await t.test('cancelling the picker preserves the workspace settings', async () => {
    await seedHidden();
    await fs.writeFile(pickerResult, '');
    const before = await fs.readFile(path.join(dir, 'workspaces.json'), 'utf8');
    assert.deepEqual((await request('/api/pickfolder', {})).data, { path: '' });
    assert.equal(await fs.readFile(path.join(dir, 'workspaces.json'), 'utf8'), before);
  });
  await t.test('a missing folder is rejected without changing the settings', async () => {
    const before = await fs.readFile(path.join(dir, 'workspaces.json'), 'utf8');
    assert.equal((await request('/api/workspaces', { action: 'add', path: path.join(dir, 'missing') })).status, 400);
    assert.equal(await fs.readFile(path.join(dir, 'workspaces.json'), 'utf8'), before);
  });
});

// Run the browser script with controlled network timing. Replace only its startup
// call so tests can drive the real event callback and render functions independently.
async function browserHarness(hash = '') {
  const calls = [];
  const nodes = new Map();
  const node = () => ({ textContent: '', scrollTop: 0, hidden: true, value: '', children: [],
    appendChild(child) { this.children.push(child); return child; }, scrollIntoView() {},
    getContext: () => ({}), querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {} } });
  const source = await fs.readFile(path.join(root, 'public/app.js'), 'utf8');
  const start = source.lastIndexOf('\nboot().catch(');
  assert.ok(start > 0);
  const location = { hash, search: '?project=officecraftagentic' };
  let events;
  let treeLoader = async () => { calls.push('tree'); };
  let configLoader = async () => { calls.push('config'); };
  const context = vm.createContext({
    URLSearchParams, setTimeout, clearTimeout, location, CSS: { escape: (value) => value },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false }), marked: { setOptions() {} },
    ResizeObserver: class { observe() {} },
    document: {
      querySelector: (selector) => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
      querySelectorAll: () => [], createElement: node, body: node(),
    },
    EventSource: class { constructor() { events = this; } },
    fetch: async () => { throw new Error('Unexpected fetch'); },
    testHooks: {
      tree: () => treeLoader(), config: () => configLoader(),
      render: (name, p) => { calls.push(p ? name + ':' + p : name); },
    },
  });
  vm.runInContext(source.slice(0, start) + `
    globalThis.app = { state, connectEvents, openDir, openFile };
    loadTree = testHooks.tree;
    loadConfig = testHooks.config;
    renderHome = () => testHooks.render('home');
    openDir = (p) => testHooks.render('dir', p);
    openFile = (p) => testHooks.render('file', p);
  })();`, context);
  context.app.connectEvents();
  return {
    ...context.app, location, nodes, calls, context,
    loadTree: (fn) => { treeLoader = fn; },
    loadConfig: (fn) => { configLoader = fn; },
    change: (paths = ['README.md'], project = 'officecraftagentic') => events.onmessage({
      data: JSON.stringify({ type: 'change', project, paths }),
    }),
  };
}

test('file updates keep the project picker open', async () => {
  const browser = await browserHarness('#!projects');
  await browser.change(['docviewer.json', 'README.md']);
  assert.deepEqual(browser.calls, ['config', 'tree']);
});

test('entering the picker while a tree refresh is pending preserves the picker', async () => {
  const browser = await browserHarness('');
  const pending = deferred();
  browser.loadTree(() => pending.promise);
  const update = browser.change();
  browser.location.hash = '#!projects';
  pending.resolve();
  await update;
  assert.deepEqual(browser.calls, []);
});

test('leaving the picker while a tree refresh is pending preserves the new view', async () => {
  const browser = await browserHarness('#!projects');
  const pending = deferred();
  browser.loadTree(() => pending.promise);
  const update = browser.change();
  browser.location.hash = '';
  pending.resolve();
  await update;
  assert.deepEqual(browser.calls, []);
});

test('file updates still refresh the active project home, directory and file', async () => {
  for (const [current, expected] of [[null, 'home'], ['docs', 'dir:docs'], ['README.md', 'file:README.md']]) {
    const browser = await browserHarness(current ? '#' + current : '');
    browser.state.current = current;
    browser.state.dirSet.add('docs');
    await browser.change(current === 'docs' ? ['docs/new.md'] : ['README.md']);
    assert.deepEqual(browser.calls, ['tree', expected]);
  }
});

test('updates from another project do not refresh the current view', async () => {
  const browser = await browserHarness('#!projects');
  await browser.change(['README.md'], 'another-project');
  assert.deepEqual(browser.calls, []);
});

for (const type of ['directory', 'file']) {
  for (const ok of [true, false]) {
    test(`a delayed ${type} ${ok ? 'response' : 'error'} cannot replace the picker`, async () => {
      const browser = await browserHarness('#docs');
      const pending = deferred();
      browser.context.fetch = () => pending.promise;
      const request = type === 'directory' ? browser.openDir('docs') : browser.openFile('docs/readme.md');
      browser.location.hash = '#!projects';
      browser.state.current = null;
      browser.nodes.get('#doc').textContent = 'Project picker';
      pending.resolve({ ok, json: async () => ok ? { entries: [], content: 'old', binary: false } : { error: 'ENOENT' } });
      await request;
      assert.equal(browser.state.current, null);
      assert.equal(browser.nodes.get('#doc').textContent, 'Project picker');
      assert.equal(browser.nodes.get('#doc').children.length, 0);
    });
  }
}
