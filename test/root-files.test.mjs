import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docviewer-root-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'docs'));
  await fs.mkdir(path.join(dir, 'misc'));
  await fs.writeFile(path.join(dir, 'README.md'), '# Обзор проекта\n');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'notes');
  await fs.writeFile(path.join(dir, 'docs/nested.md'), '# Вложенный документ\n');
  const config = {
    title: 'Проект', description: 'Описание',
    sections: [{ path: 'docs', title: 'Документы', icon: '▣', description: 'Описание раздела' }],
    favorites: ['docs/nested.md'], hiddenFiles: ['notes.txt'], extraSetting: 'keep',
  };
  const configFile = path.join(dir, 'docviewer.json');
  await fs.writeFile(configFile, JSON.stringify(config));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'server.mjs'), dir], {
    cwd: dir, env: { ...process.env, DOCVIEWER_PORT: String(port), DOCVIEWER_NO_OPEN: '1' },
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
      const url = log.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (url) { clearTimeout(timer); resolve(url); }
    });
  });
  const request = async (url, body) => {
    const res = await fetch(new URL(url, origin), body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    return data;
  };
  return { config, configFile, request, origin };
}

// A small DOM supports the real home renderer and its mouse/keyboard handlers.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
    this.className = ''; this.scrollTop = 0; this.value = ''; this._text = '';
    this.classList = {
      contains: (name) => this.className.split(' ').includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter((n) => !names.includes(n)).join(' '); },
      toggle: (name, on = !this.classList.contains(name)) => {
        if (on) this.classList.add(name); else this.classList.remove(name);
      },
    };
  }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map((n) => n.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this[name] = value; }
  getContext() { return {}; }
  normalize() {}
  querySelectorAll(selector) {
    return this.children.flatMap((n) => [
      ...(selector.startsWith('.') && n.classList.contains(selector.slice(1)) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

async function browser(origin) {
  const nodes = new Map();
  const location = { search: '', hash: '' };
  const document = {
    createElement: (tag) => new Element(tag), body: new Element('body'),
    querySelector: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, new Element());
      return nodes.get(selector);
    },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document, location, URLSearchParams, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false }), marked: { setOptions() {} },
    ResizeObserver: class { observe() {} }, fetch: (url, opts) => fetch(new URL(url, origin), opts),
  });
  const source = await fs.readFile(path.join(root, 'public/app.js'), 'utf8');
  const start = source.lastIndexOf('\nboot().catch(');
  assert.ok(start > 0);
  vm.runInContext(source.slice(0, start) + `
    globalThis.app = { state, loadConfig, loadTree, renderHome };
  })();`, context);
  const app = context.app;
  await app.loadConfig();
  await app.loadTree();
  app.renderHome();
  return {
    ...app, location,
    home: () => nodes.get('#doc').children[0],
    rootGrid: () => {
      const children = nodes.get('#doc').children[0].children;
      return children[children.findIndex((n) => n.textContent === 'Файлы в корне') + 1];
    },
  };
}

test('root files render below other folders and can be hidden and restored', async (t) => {
  const { origin, request, configFile, config } = await fixture(t);
  const app = await browser(origin);
  const headings = app.home().children.map((n) => n.textContent);
  assert.ok(headings.indexOf('Файлы в корне') > headings.indexOf('Остальные папки'));
  assert.match(app.rootGrid().textContent, /Обзор проекта/);
  assert.doesNotMatch(app.rootGrid().textContent, /Notes|Вложенный документ/);
  assert.ok(app.state.fileSet.has('notes.txt'), 'hidden files remain in the tree');

  app.rootGrid().children.find((n) => n.textContent.includes('Обзор проекта')).onclick();
  assert.equal(app.location.hash, '#README.md');
  app.location.hash = '';
  app.state.editing = true;
  app.renderHome();
  let hidden = app.rootGrid().querySelector('.file-hidden');
  assert.match(hidden.textContent, /Notes/);
  assert.match(hidden.textContent, /Скрыт/);
  await hidden.onclick();
  assert.deepEqual((await request('/api/config')).hiddenFiles, []);

  const tile = app.rootGrid().children.find((n) => n.textContent.includes('Обзор проекта'));
  let prevented = false;
  await tile.onkeydown({ key: 'Enter', target: tile, preventDefault() { prevented = true; } });
  // Keyboard handlers initiate the same async save as mouse activation.
  // Wait for the request started by the handler to finish rendering.
  for (let attempt = 0; attempt < 50 && !app.state.hiddenFiles.includes('README.md'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(prevented, true);
  assert.equal(app.location.hash, '');
  assert.ok(app.state.hiddenFiles.includes('README.md'));
  hidden = app.rootGrid().querySelector('.file-hidden');
  assert.match(hidden.textContent, /Обзор проекта/);

  const reloaded = await browser(origin);
  assert.doesNotMatch(reloaded.rootGrid().textContent, /Обзор проекта/);
  const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.deepEqual(saved, { ...config, hiddenFiles: ['README.md'] });
  await request('/api/config', { sections: [] });
  assert.deepEqual((await request('/api/config')).hiddenFiles, ['README.md']);
});

test('root visibility settings preserve default sections and normalize only root file names', async (t) => {
  const { request, configFile } = await fixture(t);
  await fs.rm(configFile);
  const result = await request('/api/config', {
    hiddenFiles: ['./README.md', 'README.md', '../outside.md', 'docs/nested.md', '', '.', '..', null],
  });
  assert.deepEqual(result.hiddenFiles, ['README.md']);
  assert.deepEqual(result.sections.map((s) => s.path).sort(), ['docs', 'misc']);
  assert.deepEqual((await request('/api/config', { hiddenFiles: [] })).hiddenFiles, []);
});

test('home settings edit title and the single description and survive reload', async (t) => {
  const { origin, configFile } = await fixture(t);
  const app = await browser(origin);
  assert.equal(app.home().querySelectorAll('.project-description').length, 1);
  app.state.editing = true;
  app.renderHome();
  const form = app.home().querySelector('.project-settings-editor');
  const title = form.querySelector('.project-title-input');
  const description = form.querySelector('.description-input');
  assert.equal(title.value, 'Проект');
  assert.equal(description.value, 'Описание');
  title.value = 'Рабочая база знаний';
  description.value = 'Документы для поиска и работы';
  await form.onsubmit({ preventDefault() {}, stopPropagation() {} });
  assert.equal(app.state.config.title, title.value);
  assert.equal(app.state.config.description, description.value);
  assert.match(form.textContent, /Сохранено/);
  const loaded = await browser(origin);
  assert.equal(loaded.home().children[0].children[0].children[0].textContent, title.value);
  assert.equal(loaded.home().querySelectorAll('.project-description').length, 1);
  assert.equal(loaded.home().querySelector('.project-description').textContent, description.value);
  const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(saved.title, title.value);
  assert.equal(saved.description, description.value);
  assert.equal(Object.hasOwn(saved, 'subtitle'), false);
});

test('files without extensions render on the project home and remain configurable', async (t) => {
  const { origin, configFile, request } = await fixture(t);
  for (const name of ['LICENSE', 'Makefile', 'Dockerfile']) {
    await fs.writeFile(path.join(path.dirname(configFile), name), 'plain text');
  }
  const app = await browser(origin);
  for (const name of ['LICENSE', 'Makefile', 'Dockerfile']) {
    const tile = app.rootGrid().children.find((n) => n.querySelector('.fname')?.textContent === name);
    assert.ok(tile, name + ' is visible');
    assert.equal(tile.querySelector('.ext'), null);
  }

  app.state.editing = true;
  app.renderHome();
  const license = app.rootGrid().children.find((n) => n.querySelector('.fname')?.textContent === 'LICENSE');
  await license.onclick();
  assert.ok((await request('/api/config')).hiddenFiles.includes('LICENSE'));
  const reloaded = await browser(origin);
  assert.ok(!reloaded.rootGrid().children.some((n) => n.querySelector('.fname')?.textContent === 'LICENSE'));
});
