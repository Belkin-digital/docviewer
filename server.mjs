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
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
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
  const hidden = [];
  for (const raw of Array.isArray(cfg.sections) ? cfg.sections : []) {
    const item = typeof raw === 'string' ? { path: raw } : raw;
    if (!item || typeof item.path !== 'string' || !item.path.trim()) continue;
    const rel = item.path.replace(/^\.?\//, '').replace(/\/$/, '');
    let exists = false;
    try { exists = (await fsp.stat(safeAbs(root, rel))).isDirectory(); } catch { exists = false; }
    const entry = {
      path: rel,
      title: item.title || rel,
      icon: item.icon || '▸',
      description: item.description || '',
      exists,
    };
    (item.hidden ? hidden : sections).push(entry);
  }
  const favorites = [];
  for (const raw of Array.isArray(cfg.favorites) ? cfg.favorites : []) {
    const rel = String(raw || '').replace(/^\.?\//, '');
    if (!rel) continue;
    let exists = false, title = null, mtime = 0;
    try {
      const abs = safeAbs(root, rel);
      const st = await fsp.stat(abs);
      exists = st.isFile();
      mtime = st.mtimeMs;
      if (exists && /\.mdc?$/.test(rel)) title = await docTitle(abs, mtime);
    } catch { exists = false; }
    favorites.push({ path: rel, name: path.basename(rel), ext: path.extname(rel).toLowerCase(), title, exists });
  }

  return {
    project: project.id,
    title: cfg.title || 'Навигация по документации',
    subtitle: cfg.subtitle || '',
    sections,
    hidden,
    favorites,
    source,
    notice,
    file: CONFIG_FILE,
  };
}

// Запись состава меню обратно в docviewer.json проекта.
// Порядок и состав задаёт клиент, а подписи, значки и описания уже известных разделов сохраняем.
async function writeConfig(project, paths) {
  const root = project.root;
  const file = path.join(root, CONFIG_FILE);
  let cfg = {};
  try { cfg = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { cfg = {}; }

  const known = new Map();
  for (const raw of Array.isArray(cfg.sections) ? cfg.sections : []) {
    const item = typeof raw === 'string' ? { path: raw } : raw;
    if (item && typeof item.path === 'string') known.set(item.path.replace(/\/$/, ''), item);
  }

  const sections = [];
  const visible = new Set();
  for (const rawPath of Array.isArray(paths) ? paths : []) {
    const rel = String(rawPath || '').replace(/^\.?\//, '').replace(/\/$/, '');
    if (!rel || visible.has(rel)) continue;
    const abs = safeAbs(root, rel);                       // за пределы проекта не выпускаем
    let isDir = false;
    try { isDir = (await fsp.stat(abs)).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    visible.add(rel);
    const { hidden: _drop, ...entry } = known.get(rel) || { path: rel, title: path.basename(rel) };
    sections.push(entry);
  }
  // убранные из меню сохраняем с пометкой: вернутся со своим названием, значком и описанием
  for (const [rel, item] of known) {
    if (!visible.has(rel)) sections.push({ ...item, hidden: true });
  }

  const out = {
    title: cfg.title || 'Навигация по документации',
    ...(cfg.subtitle ? { subtitle: cfg.subtitle } : {}),
    ...Object.fromEntries(Object.entries(cfg).filter(([k]) => !['title', 'subtitle', 'sections'].includes(k))),
    sections,
  };
  await fsp.writeFile(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return readConfig(project);
}

// Избранные файлы живут в том же docviewer.json проекта.
async function writeFavorite(project, rel, on) {
  const file = path.join(project.root, CONFIG_FILE);
  let cfg = {};
  try { cfg = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { cfg = {}; }

  const clean = String(rel || '').replace(/^\.?\//, '');
  if (!clean) throw new Error('не указан файл');
  safeAbs(project.root, clean);                       // за пределы проекта не выпускаем

  const list = (Array.isArray(cfg.favorites) ? cfg.favorites : []).map(String).filter(Boolean);
  const next = on ? [...list.filter((x) => x !== clean), clean] : list.filter((x) => x !== clean);

  const out = { ...cfg, favorites: next };
  if (!Array.isArray(out.sections)) out.sections = [];
  await fsp.writeFile(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return readConfig(project);
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
  obsidian: ['-a', 'Obsidian'],
  reveal: ['-R'],
  default: [],
};

function run(cmd, args) {
  console.log('открываю:', cmd, args.join(' '));   // видно в журнале, если кнопка «ничего не сделала»
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} вернул код ${code}`))));
  });
}

// Редакторы открываем их собственной командой: рабочей папкой окна становится корень проекта,
// а документ открывается внутри него. `open -a` так не умеет — он просто подкидывает файл
// в последнее активное окно с чужой рабочей папкой.
// Сначала команда из самого бандла: одноимённые обёртки в PATH бывают чужими
// (например, ~/.local/bin/cursor — это шим агента, который редактор не открывает).
const EDITOR_CLIS = {
  vscode: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/usr/local/bin/code', 'code'],
  cursor: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', '/usr/local/bin/cursor', 'cursor'],
};
const EDITOR_APPS = { vscode: 'Visual Studio Code', cursor: 'Cursor' };
// Cursor без -n отдаёт папку последнему активному окну: если это окно с несколькими корнями
// (например, «Cursor Agents»), папка молча добавляется туда, а файл открывается в чужом проекте.
// С -n он открывает окно именно на нужном проекте и при повторных кликах переиспользует его.
// VS Code так делает сам, и -n ему только плодило бы окна.
const EDITOR_FLAGS = { vscode: [], cursor: ['-n'] };

function findCli(candidates) {
  for (const c of candidates) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(':')) {
      if (dir && fs.existsSync(path.join(dir, c))) return path.join(dir, c);
    }
  }
  return '';
}

async function openEditor(app, abs, root) {
  const cli = findCli(EDITOR_CLIS[app]);
  if (!cli) return run('open', ['-a', EDITOR_APPS[app], abs]);   // обёртки нет — открываем как раньше
  const isDir = (await fsp.stat(abs)).isDirectory();
  const flags = EDITOR_FLAGS[app] || [];
  return run(cli, isDir ? [...flags, root] : [...flags, root, abs]);
}

// Новый чат Claude Code в приложении: у него своя ссылка claude://code/new,
// той же ссылкой открывает сессию пункт Finder «New Claude Code Session Here».
// Папок можно передать несколько: первой корень проекта, второй — та, откуда кликнули.
async function openClaude(abs, root) {
  const st = await fsp.stat(abs);
  const rel = relOf(root, abs);
  // Папку передаём ровно одну — корень проекта. От второй (папки документа) сессия начинала
  // не с корня, а сам документ ссылка всё равно не открывает: параметр file обработчик
  // /code/new читает, но дальше не пробрасывает. Поэтому документ называем в поле ввода
  // @-упоминанием от корня — Claude Code понимает такие пути.
  const params = ['folder=' + encodeURIComponent(root)];
  if (rel && rel !== '.') params.push('q=' + encodeURIComponent('@' + rel + (st.isDirectory() ? '/' : '') + ' '));
  return run('open', ['claude://code/new?' + params.join('&') + '&source=external']);
}

function openNative(app, abs, root) {
  if (app === 'claude') return openClaude(abs, root);
  if (EDITOR_CLIS[app]) return openEditor(app, abs, root);
  const args = APPS[app];
  if (!args) throw new Error('неизвестное приложение: ' + app);
  return run('open', [...args, abs]);
}

// --- значки приложений -------------------------------------------------------
// Берём настоящие значки установленных приложений: .icns из бандла → png через sips.
// Приложения нет — отдаём 404, и в интерфейсе остаётся текстовая подпись кнопки.
const APP_BUNDLES = {
  vscode: '/Applications/Visual Studio Code.app',
  cursor: '/Applications/Cursor.app',
  obsidian: '/Applications/Obsidian.app',
  claude: '/Applications/Claude.app',
  reveal: '/System/Library/CoreServices/Finder.app',
};
const ICON_DIR = path.join(os.tmpdir(), 'docviewer-icons');

async function icnsOf(bundle) {
  const res = path.join(bundle, 'Contents', 'Resources');
  try {
    const plist = await fsp.readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
    const m = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/);
    if (m) {
      const abs = path.join(res, m[1].endsWith('.icns') ? m[1] : m[1] + '.icns');
      if (fs.existsSync(abs)) return abs;
    }
  } catch { /* двоичный plist — ищем значок по файлам */ }
  const files = (await fsp.readdir(res).catch(() => [])).filter((f) => f.endsWith('.icns'));
  let best = '', size = 0;
  for (const f of files) {
    const st = await fsp.stat(path.join(res, f)).catch(() => null);
    if (st && st.size > size) { best = path.join(res, f); size = st.size; }
  }
  return best;
}

const iconJobs = new Map();
async function appIcon(app) {
  const bundle = APP_BUNDLES[app];
  if (!bundle || !fs.existsSync(bundle)) return null;
  const out = path.join(ICON_DIR, app + '.png');
  try { await fsp.access(out); return out; } catch { /* ещё не сконвертирован */ }
  let job = iconJobs.get(app);
  if (!job) {
    job = (async () => {
      const icns = await icnsOf(bundle);
      if (!icns) return null;
      await fsp.mkdir(ICON_DIR, { recursive: true });
      await new Promise((resolve, reject) => {
        const p = spawn('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out], { stdio: 'ignore' });
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('sips вернул код ' + code))));
      });
      return out;
    })();
    iconJobs.set(app, job);
    const forget = () => iconJobs.delete(app);
    job.then(forget, forget);
  }
  return job.catch(() => null);
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

// Отдача файла проекта по «настоящему» пути: относительные ссылки внутри HTML тогда работают.
async function serveProjectFile(res, p) {
  const rest = p.slice(5);
  const cut = rest.indexOf('/');
  const projId = decodeURIComponent(cut < 0 ? rest : rest.slice(0, cut));
  const rel = cut < 0 ? '' : decodeURIComponent(rest.slice(cut + 1));
  const target = projectById(projId);
  const abs = safeAbs(target.root, rel);
  const buf = await fsp.readFile(abs);
  return send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
}

// Страницы проектов открываются на отдельном порту: у них свой origin, поэтому они
// работают как обычные страницы (localStorage, скрипты), но не видят данных просмотрщика.
let ASSET_ORIGIN = '';
const assetServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/raw/')) return serveProjectFile(res, url.pathname);
    send(res, 404, 'not found');
  } catch (err) {
    send(res, 400, String(err.message || err));
  }
});

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
        assets: ASSET_ORIGIN,
        projects: PROJECTS.map(({ id, name }) => ({ id, name })),
      });
    }

    if (p === '/api/tree') return json(res, 200, await getTree(project));

    if (p === '/api/appicon') {
      const icon = await appIcon(url.searchParams.get('app') || '');
      if (!icon) return send(res, 404, 'значок не найден');
      return send(res, 200, await fsp.readFile(icon), 'image/png', { 'Cache-Control': 'max-age=86400' });
    }

    if (p === '/api/favorite' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await writeFavorite(project, body.path, body.on !== false));
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await writeConfig(project, body.sections));
    }

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

    if (p.startsWith('/raw/')) return serveProjectFile(res, p);

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

    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      return json(res, 403, { error: 'запрос не из просмотрщика' });   // защита от встроенных страниц
    }

    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const target = projectById(body.project || url.searchParams.get('project'));
      const abs = safeAbs(target.root, body.path || '');
      await openNative(body.app || 'default', abs, target.root);
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
    assetServer.listen(0, '127.0.0.1', () => {
      ASSET_ORIGIN = `http://127.0.0.1:${assetServer.address().port}`;
    });
    console.log(`Просмотрщик документации: ${uri}`);
    for (const pr of PROJECTS) console.log(`  ${pr.name} — ${pr.root}`);
    startWatcher();
    if (OPEN_BROWSER) spawn('open', [uri], { stdio: 'ignore' }).on('error', () => {});
  });
}
listen(PORT_BASE);
