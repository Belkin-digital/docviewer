#!/usr/bin/env node
// Локальный просмотрщик документации репозитория.
// Без внешних зависимостей: http + fs.watch + SSE.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_BASE = Number(process.env.DOCVIEWER_PORT || 4179);
const OPEN_BROWSER = process.env.DOCVIEWER_NO_OPEN !== '1';

// --- проекты -----------------------------------------------------------------
// Источники, по убыванию приоритета: аргументы командной строки, DOCVIEWER_ROOTS,
// projects.json рядом с сервером. Если ничего нет — текущая папка.
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'p';
const expand = (p) => path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function loadProjects() {
  let raw = [];
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (args.length) raw = args;
  else if (process.env.DOCVIEWER_ROOTS) raw = process.env.DOCVIEWER_ROOTS.split(':').filter(Boolean);
  else if (process.env.DOCVIEWER_ROOT) raw = [process.env.DOCVIEWER_ROOT];
  else {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'projects.json'), 'utf8'));
      raw = Array.isArray(cfg.projects) ? cfg.projects : [];
    } catch { raw = [process.cwd()]; }
  }
  const out = [];
  for (const item of raw) {
    const entry = typeof item === 'string' ? { path: item } : item;
    if (!entry || !entry.path) continue;
    const root = expand(entry.path);
    if (!fs.existsSync(root)) {
      console.error(`Пропускаю проект — папки нет: ${root}`);
      continue;
    }
    const name = entry.name || path.basename(root);
    out.push({ id: entry.id || slug(name), name, root });
  }
  if (!out.length) {
    const root = process.cwd();
    out.push({ id: slug(path.basename(root)), name: path.basename(root), root });
  }
  return out;
}

const PROJECTS = loadProjects();
const projectById = (id) => PROJECTS.find((p) => p.id === id) || PROJECTS[0];

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', '__pycache__', '.pytest_cache', '.idea',
  'ffmpeg_bin', '.DS_Store', 'vendor',
]);
// Полные относительные пути, которые не показываем (рабочие копии агентов и т.п.)
const SKIP_REL = new Set(['.claude/worktrees', '.claude/projects', 'scripts/__pycache__']);
const TEXT_EXT = new Set([
  '.md', '.mdc', '.txt', '.py', '.sh', '.json', '.yml', '.yaml', '.html', '.css',
  '.js', '.mjs', '.ts', '.puml', '.xml', '.csv', '.ndjson', '.toml', '.ini', '.sql', '.feature',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

// --- утилиты путей -----------------------------------------------------------
function safeAbs(root, rel) {
  const abs = path.resolve(root, String(rel || '').replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('путь вне репозитория');
  return abs;
}
const relOf = (root, abs) => path.relative(root, abs) || '.';

// --- дерево файлов -----------------------------------------------------------
async function buildTree(root, dir = root) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.cursor' && e.name !== '.claude') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (SKIP_REL.has(relOf(root, abs))) continue;
    if (e.isDirectory()) {
      const children = await buildTree(root, abs);
      out.push({ name: e.name, path: relOf(root, abs), dir: true, children });
    } else if (e.isFile()) {
      out.push({ name: e.name, path: relOf(root, abs), dir: false, ext: path.extname(e.name).toLowerCase() });
    }
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ru') : a.dir ? -1 : 1));
  return out;
}

// --- конфигурация разделов (docviewer.json в корне) -------------------------
const CONFIG_FILE = 'docviewer.json';

async function topLevelSections(root) {
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => ({ path: e.name, title: e.name, icon: '▣', description: '' }))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

async function readConfig(project) {
  const root = project.root;
  let cfg, source = 'file', notice = null;   // notice — пояснение, а не сбой запроса
  try {
    cfg = JSON.parse(await fsp.readFile(path.join(root, CONFIG_FILE), 'utf8'));
  } catch (err) {
    cfg = { title: 'Навигация по документации', subtitle: '', sections: await topLevelSections(root) };
    source = 'default';
    notice = err.code === 'ENOENT'
      ? `${CONFIG_FILE} в корне проекта нет — показаны все папки верхнего уровня`
      : `${CONFIG_FILE}: ${err.message}`;
  }
  const sections = [];
  for (const raw of Array.isArray(cfg.sections) ? cfg.sections : []) {
    const item = typeof raw === 'string' ? { path: raw } : raw;
    if (!item || typeof item.path !== 'string' || !item.path.trim()) continue;
    const rel = item.path.replace(/^\.?\//, '').replace(/\/$/, '');
    let exists = false;
    try { exists = (await fsp.stat(safeAbs(root, rel))).isDirectory(); } catch { exists = false; }
    sections.push({
      path: rel,
      title: item.title || rel,
      icon: item.icon || '▸',
      description: item.description || '',
      exists,
    });
  }
  return {
    project: project.id,
    title: cfg.title || 'Навигация по документации',
    subtitle: cfg.subtitle || '',
    sections,
    source,
    notice,
    file: CONFIG_FILE,
  };
}

const treeCache = new Map();
async function getTree(project) {
  if (!treeCache.has(project.id)) {
    treeCache.set(project.id, { generated: Date.now(), items: await buildTree(project.root) });
  }
  return treeCache.get(project.id);
}

// --- заголовки документов ----------------------------------------------------
// Название берём из frontmatter (title / export_title), иначе из первого заголовка «# …».
const titleCache = new Map();

async function docTitle(abs, mtime) {
  const cached = titleCache.get(abs);
  if (cached && cached.mtime === mtime) return cached.title;
  let head = '';
  try {
    const fh = await fsp.open(abs, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    head = buf.slice(0, bytesRead).toString('utf8');
  } catch { return null; }
  let title = null;
  if (head.startsWith('---')) {
    const end = head.indexOf('\n---', 3);
    const fm = end < 0 ? head : head.slice(0, end);
    const m = fm.match(/^title:\s*(.+)$/m);
    if (m) title = m[1].trim().replace(/^["']|["']$/g, '');
  }
  if (!title) {
    const m = head.match(/^#\s+(.+)$/m);
    if (m) title = m[1].trim();
  }
  if (title) title = title.replace(/\s+/g, ' ').slice(0, 160);
  titleCache.set(abs, { mtime, title });
  return title;
}

// --- содержимое одной папки --------------------------------------------------
async function listDir(project, rel) {
  const root = project.root;
  const dirAbs = safeAbs(root, rel);
  const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.cursor' && e.name !== '.claude') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dirAbs, e.name);
    const childRel = relOf(root, abs);
    if (SKIP_REL.has(childRel)) continue;
    if (e.isDirectory()) {
      let files = 0, docs = 0;
      const stack = [abs];
      while (stack.length) {
        let items = [];
        try { items = await fsp.readdir(stack.pop(), { withFileTypes: true }); } catch { continue; }
        for (const it of items) {
          if (it.name.startsWith('.') || SKIP_DIRS.has(it.name)) continue;
          const p2 = path.join(it.parentPath || it.path, it.name);
          if (it.isDirectory()) stack.push(p2);
          else { files++; if (/\.mdc?$/.test(it.name)) docs++; }
        }
      }
      out.push({ name: e.name, path: childRel, dir: true, files, docs });
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      let title = null, mtime = 0;
      try {
        const st = await fsp.stat(abs);
        mtime = st.mtimeMs;
        if (ext === '.md' || ext === '.mdc') title = await docTitle(abs, mtime);
      } catch { /* нечитаемый файл */ }
      out.push({ name: e.name, path: childRel, dir: false, ext, title, mtime });
    }
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ru') : a.dir ? -1 : 1));
  return { path: rel, parent: path.dirname(rel) === '.' ? '' : path.dirname(rel), entries: out };
}

// --- поиск по содержимому ----------------------------------------------------
function flatFiles(items, acc = []) {
  for (const it of items) it.dir ? flatFiles(it.children, acc) : acc.push(it);
  return acc;
}

async function search(project, q, limit = 200) {
  const needle = q.toLowerCase();
  const tree = await getTree(project);
  const files = flatFiles(tree.items).filter((f) => TEXT_EXT.has(f.ext));
  const hits = [];
  for (const f of files) {
    const nameHit = f.path.toLowerCase().includes(needle);
    let matches = [];
    try {
      const text = await fsp.readFile(safeAbs(project.root, f.path), 'utf8');
      if (text.toLowerCase().includes(needle)) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < 4; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({ line: i + 1, text: lines[i].trim().slice(0, 240) });
          }
        }
      }
    } catch { /* нечитаемый файл пропускаем */ }
    if (nameHit || matches.length) hits.push({ path: f.path, name: f.name, nameHit, matches });
    if (hits.length >= limit) break;
  }
  const archived = (p) => /(^|\/)(Archive|_archive)(\/|$)/.test(p) ? 1 : 0;
  hits.sort((a, b) =>
    (archived(a.path) - archived(b.path)) ||
    (b.nameHit - a.nameHit) ||
    (b.matches.length - a.matches.length) ||
    a.path.localeCompare(b.path, 'ru'));
  return hits;
}

// --- SSE ---------------------------------------------------------------------
const sseClients = new Set();
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch { /* закрыт */ } }
}

const pending = new Map();   // projectId → Set путей
const timers = new Map();
function onFsEvent(project, relPath) {
  if (!relPath) return;
  const parts = relPath.split(path.sep);
  if (parts.some((p) => SKIP_DIRS.has(p) || p === '.DS_Store')) return;
  for (const skip of SKIP_REL) if (relPath === skip || relPath.startsWith(skip + path.sep)) return;
  if (!pending.has(project.id)) pending.set(project.id, new Set());
  pending.get(project.id).add(relPath);
  clearTimeout(timers.get(project.id));
  timers.set(project.id, setTimeout(() => {
    const paths = [...(pending.get(project.id) || [])];
    pending.delete(project.id);
    treeCache.delete(project.id);          // дерево пересоберётся по запросу
    broadcast({ type: 'change', project: project.id, paths, at: Date.now() });
  }, 120));
}

function startWatcher() {
  for (const project of PROJECTS) {
    try {
      fs.watch(project.root, { recursive: true }, (_evt, name) => onFsEvent(project, name));
    } catch (err) {
      console.error(`fs.watch недоступен для ${project.name}:`, err.message);
    }
  }
}

// --- открытие в нативных приложениях ----------------------------------------
const APPS = {
  vscode: ['-a', 'Visual Studio Code'],
  cursor: ['-a', 'Cursor'],
  obsidian: ['-a', 'Obsidian'],
  reveal: ['-R'],
  default: [],
};
function openNative(app, abs) {
  const args = APPS[app];
  if (!args) throw new Error('неизвестное приложение: ' + app);
  return new Promise((resolve, reject) => {
    const p = spawn('open', [...args, abs], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('open вернул код ' + code))));
  });
}

// --- HTTP --------------------------------------------------------------------
function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

async function serveStatic(res, baseDir, rel) {
  const abs = path.resolve(baseDir, rel.replace(/^\/+/, ''));
  if (!abs.startsWith(baseDir)) return send(res, 403, 'forbidden');
  try {
    const buf = await fsp.readFile(abs);
    send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found');
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(HERE, 'public'), 'index.html');
    if (p.startsWith('/public/')) return serveStatic(res, path.join(HERE, 'public'), p.slice(8));
    if (p.startsWith('/vendor/')) return serveStatic(res, path.join(HERE, 'vendor'), p.slice(8));

    const project = projectById(url.searchParams.get('project'));

    if (p === '/api/projects') {
      return json(res, 200, { projects: PROJECTS.map(({ id, name, root }) => ({ id, name, root })) });
    }

    if (p === '/api/meta') {
      return json(res, 200, {
        root: project.root, name: project.name, project: project.id, host: os.hostname(),
        projects: PROJECTS.map(({ id, name }) => ({ id, name })),
      });
    }

    if (p === '/api/tree') return json(res, 200, await getTree(project));

    if (p === '/api/config') return json(res, 200, await readConfig(project));

    if (p === '/api/dir') return json(res, 200, await listDir(project, (url.searchParams.get('p') || '').replace(/\/$/, '')));

    if (p === '/api/file') {
      const rel = url.searchParams.get('p') || '';
      const abs = safeAbs(project.root, rel);
      const st = await fsp.stat(abs);
      const ext = path.extname(abs).toLowerCase();
      if (!TEXT_EXT.has(ext)) {
        return json(res, 200, { path: relOf(project.root, abs), binary: true, size: st.size, mtime: st.mtimeMs, ext });
      }
      const content = await fsp.readFile(abs, 'utf8');
      return json(res, 200, { path: relOf(project.root, abs), binary: false, content, size: st.size, mtime: st.mtimeMs, ext });
    }

    if (p === '/raw') {
      const abs = safeAbs(project.root, url.searchParams.get('p') || '');
      const buf = await fsp.readFile(abs);
      return send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    }

    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, { query: q, hits: [] });
      return json(res, 200, { query: q, hits: await search(project, q) });
    }

    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const target = projectById(body.project || url.searchParams.get('project'));
      const abs = safeAbs(target.root, body.path || '');
      await openNative(body.app || 'default', abs);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    send(res, 404, 'not found');
  } catch (err) {
    json(res, 400, { error: String(err.message || err) });
  }
});

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) return listen(port + 1, attempt + 1);
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const uri = `http://127.0.0.1:${port}/`;
    console.log(`Просмотрщик документации: ${uri}`);
    for (const pr of PROJECTS) console.log(`  ${pr.name} — ${pr.root}`);
    startWatcher();
    if (OPEN_BROWSER) spawn('open', [uri], { stdio: 'ignore' }).on('error', () => {});
  });
}
listen(PORT_BASE);
