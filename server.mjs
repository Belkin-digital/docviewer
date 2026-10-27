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
import { loadProjects, workspaceList as catalogWorkspaces, expand, shortHome,
  readWorkspacesFile, writeWorkspacesFile, addWorkspace } from './project-catalog.mjs';
import { readSettings, readProjectInfo, writeSettings, serializeSettings, validateDescription, validateTitle, resolveProjectTitle } from './project-settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_BASE = Number(process.env.DOCVIEWER_PORT || 4179);
const OPEN_BROWSER = process.env.DOCVIEWER_NO_OPEN !== '1';

// --- проекты -----------------------------------------------------------------
// Источники, по убыванию приоритета: аргументы командной строки, DOCVIEWER_ROOTS,
// projects.json рядом с сервером. Если ничего нет — текущая папка.
// id из имени: буквы и цифры любых алфавитов, иначе кириллица схлопывается в «p»
// и проекты с русскими названиями сталкиваются одним id. Коллизии разных папок
// с одинаковым именем снимает суффикс в loadProjects.

let PROJECTS = loadProjects();
const projectById = (id) => PROJECTS.find((p) => p.id === id) || PROJECTS[0];
const projectSummaries = () => Promise.all(PROJECTS.map(async ({ id, name, root, fav }) =>
  ({ id, name, root, fav, ...await readProjectInfo(root, name) })));
const PROJECTS_FILE = path.join(HERE, 'projects.json');

// Список проектов правится прямо из интерфейса, поэтому перечитываем его на ходу:
// новые папки получают наблюдателя, а клиенты узнают об изменении через SSE.
async function writeProjects(entries) {
  await fsp.writeFile(PROJECTS_FILE, JSON.stringify({ projects: entries }, null, 2) + '\n', 'utf8');
  PROJECTS = loadProjects();
  for (const project of PROJECTS) watchProject(project);
  for (const [root, watcher] of watchers) {          // убранные проекты перестаём слушать
    if (!PROJECTS.some((p) => p.root === root)) {
      try { watcher.close(); } catch { /* уже закрыт */ }
      watchers.delete(root);
    }
  }
  for (const id of treeCache.keys()) if (!PROJECTS.some((p) => p.id === id)) treeCache.delete(id);
  broadcast({ type: 'projects', at: Date.now() });
}

// Правка списка проектов — чтение-изменение-запись: два одновременных запроса
// иначе затирают правки друг друга, поэтому проводим их строго по очереди.
let projectsQueue = Promise.resolve();
const serialized = (fn) => {
  const run = projectsQueue.then(fn, fn);
  projectsQueue = run.then(() => {}, () => {});
  return run;
};

const projectEntries = () => PROJECTS.map((p) => ({
  name: p.name, path: p.raw || shortHome(p.root), ...(p.fav ? {} : { fav: false }),
}));

// Папка становится проектом: без этого её нельзя открыть по ?project=
async function ensureProject(abs, fav) {
  return serialized(async () => {
    const found = PROJECTS.find((p) => path.resolve(p.root) === path.resolve(abs));
    const entries = projectEntries();
    if (found) {
      const entry = entries.find((e) => expand(e.path) === path.resolve(found.root));
      if (entry) { if (fav === true) delete entry.fav; if (fav === false) entry.fav = false; }
      if (fav !== undefined) await writeProjects(entries);
      return (PROJECTS.find((p) => path.resolve(p.root) === path.resolve(abs)) || found).id;
    }
    const name = path.basename(abs) || abs;
    entries.push({ name, path: shortHome(abs), ...(fav ? {} : { fav: false }) });
    await writeProjects(entries);
    const added = PROJECTS.find((p) => path.resolve(p.root) === path.resolve(abs));
    return added ? added.id : '';
  });
}

async function dropProject(abs) {
  return serialized(async () => {
    const entries = projectEntries().filter((e) => expand(e.path) !== path.resolve(abs));
    await writeProjects(entries);
  });
}

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
const fileDates = (st) => ({ birthtime: st?.birthtimeMs > 0 ? st.birthtimeMs : null, mtime: st?.mtimeMs || 0 });

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
      const st = await fsp.stat(abs).catch(() => null);
      out.push({ name: e.name, path: relOf(root, abs), dir: true, children, ...fileDates(st) });
    } else if (e.isFile()) {
      const st = await fsp.stat(abs).catch(() => null);   // дата нужна для сортировки списков
      out.push({
        name: e.name, path: relOf(root, abs), dir: false,
        ext: path.extname(e.name).toLowerCase(), ...fileDates(st),
        // Файлы корня показаны плитками в меню, с теми же названиями, что и внутри папок.
        ...(dir === root && /\.mdc?$/i.test(e.name) ? { title: await docTitle(abs, st?.mtimeMs) } : {}),
      });
    }
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ru') : a.dir ? -1 : 1));
  return out;
}

// --- конфигурация разделов (docviewer.json в корне) -------------------------
const CONFIG_FILE = 'docviewer.json';
const rootFilePaths = (paths) => [...new Set((Array.isArray(paths) ? paths : [])
  .filter((p) => typeof p === 'string').map((p) => p.replace(/^\.\//, ''))
  .filter((p) => p && p !== '.' && p !== '..' && !p.includes('/')))];

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
    cfg = await readSettings(root);
    if (!cfg) throw Object.assign(new Error('файла нет'), { code: 'ENOENT' });
  } catch (err) {
    cfg = { description: '', sections: await topLevelSections(root) };
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
    let exists = false, st = null;
    try { st = await fsp.stat(safeAbs(root, rel)); exists = st.isDirectory(); } catch { exists = false; }
    const entry = {
      path: rel,
      title: item.title || rel,
      icon: item.icon || '▸',
      description: item.description || '',
      exists,
      ...fileDates(st),
    };
    (item.hidden ? hidden : sections).push(entry);
  }
  const favorites = [];
  for (const raw of Array.isArray(cfg.favorites) ? cfg.favorites : []) {
    const rel = String(raw || '').replace(/^\.?\//, '');
    if (!rel) continue;
    let exists = false, title = null, st = null;
    try {
      const abs = safeAbs(root, rel);
      st = await fsp.stat(abs);
      exists = st.isFile();
      if (exists && /\.mdc?$/.test(rel)) title = await docTitle(abs, st.mtimeMs);
    } catch { exists = false; }
    favorites.push({ path: rel, name: path.basename(rel), ext: path.extname(rel).toLowerCase(), title, exists, ...fileDates(st) });
  }

  return {
    project: project.id,
    title: resolveProjectTitle(cfg.title, project.name),
    description: typeof cfg.description === 'string' ? cfg.description : '',
    sections,
    hidden,
    hiddenFiles: rootFilePaths(cfg.hiddenFiles),
    favorites,
    source,
    notice,
    file: CONFIG_FILE,
  };
}

// Запись состава меню обратно в docviewer.json проекта.
// Порядок и состав задаёт клиент, а подписи, значки и описания уже известных разделов сохраняем.
async function writeConfig(project, { sections: paths, hiddenFiles, description, title }) {
  const root = project.root;
  const cfg = await readSettings(root) || { sections: await topLevelSections(root) };

  if (hiddenFiles !== undefined && !Array.isArray(hiddenFiles)) throw new Error('hiddenFiles должен быть массивом');
  if (description !== undefined) cfg.description = validateDescription(description);
  if (title !== undefined) cfg.title = validateTitle(title);

  if (paths !== undefined) {
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
    cfg.sections = sections;
  }

  const out = {
    title: resolveProjectTitle(cfg.title, project.name),
    ...Object.fromEntries(Object.entries(cfg).filter(([k]) => !['title', 'sections'].includes(k))),
    sections: cfg.sections || [],
    ...(hiddenFiles !== undefined ? { hiddenFiles: rootFilePaths(hiddenFiles) } : {}),
  };
  await writeSettings(root, out);
  return readConfig(project);
}

// Избранные файлы живут в том же docviewer.json проекта.
async function writeFavorite(project, rel, on) {
  const cfg = await readSettings(project.root) || {};

  const clean = String(rel || '').replace(/^\.?\//, '');
  if (!clean) throw new Error('не указан файл');
  safeAbs(project.root, clean);                       // за пределы проекта не выпускаем

  const list = (Array.isArray(cfg.favorites) ? cfg.favorites : []).map(String).filter(Boolean);
  const next = on ? [...list.filter((x) => x !== clean), clean] : list.filter((x) => x !== clean);

  const out = { ...cfg, favorites: next };
  if (!Array.isArray(out.sections)) out.sections = [];
  await writeSettings(project.root, out);
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
      const st = await fsp.stat(abs).catch(() => null);
      out.push({ name: e.name, path: childRel, dir: true, files, docs, ...fileDates(st) });
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      let title = null, st = null;
      try {
        st = await fsp.stat(abs);
        if (ext === '.md' || ext === '.mdc') title = await docTitle(abs, st.mtimeMs);
      } catch { /* нечитаемый файл */ }
      out.push({ name: e.name, path: childRel, dir: false, ext, title, ...fileDates(st) });
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
  }
  const archived = (p) => /(^|\/)(Archive|_archive)(\/|$)/.test(p) ? 1 : 0;
  hits.sort((a, b) =>
    (archived(a.path) - archived(b.path)) ||
    (b.nameHit - a.nameHit) ||
    (b.matches.length - a.matches.length) ||
    a.path.localeCompare(b.path, 'ru'));
  return hits.slice(0, limit);   // лимит после сортировки: иначе релевантные файлы в конце дерева терялись
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

const watchers = new Map();
function watchProject(project) {
  if (watchers.has(project.root)) return;
  try {
    watchers.set(project.root, fs.watch(project.root, { recursive: true }, (_evt, name) => onFsEvent(project, name)));
  } catch (err) {
    console.error(`fs.watch недоступен для ${project.name}:`, err.message);
  }
}
function startWatcher() {
  for (const project of PROJECTS) watchProject(project);
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
  //
  // Текст для поля ввода передаём всегда, даже когда кликнули по самому корню: приложение
  // помечает папку из внешней ссылки как «чужую» (src=external) и без текста только предлагает
  // её плиткой — сессия при этом стартует без корневой папки. С непустым текстом оно идёт
  // другим путём: спрашивает доверие к папке и делает её корнем сессии. Когда называть нечего,
  // шлём один пробел — в поле ввода он незаметен.
  const mention = rel && rel !== '.' ? '@' + rel + (st.isDirectory() ? '/' : '') + ' ' : ' ';
  const params = ['folder=' + encodeURIComponent(root), 'q=' + encodeURIComponent(mention)];
  return run('open', ['claude://code/new?' + params.join('&') + '&source=external']);
}

// Новый чат Codex в приложении ChatGPT: у него своя ссылка codex://threads/new.
// Параметр path обработчик принимает только папкой (файл он молча отбрасывает и открывает
// чат без проекта), поэтому шлём корень репозитория, а документ называем в поле ввода
// @-упоминанием — как и у Claude. Доверие к папке Codex не спрашивает: папка сразу
// становится проектом чата.
async function openCodex(abs, root) {
  const st = await fsp.stat(abs);
  const rel = relOf(root, abs);
  const params = ['path=' + encodeURIComponent(root)];
  if (rel && rel !== '.') params.push('prompt=' + encodeURIComponent('@' + rel + (st.isDirectory() ? '/' : '') + ' '));
  return run('open', ['codex://threads/new?' + params.join('&')]);
}

function openNative(app, abs, root) {
  if (app === 'claude') return openClaude(abs, root);
  if (app === 'codex') return openCodex(abs, root);
  if (EDITOR_CLIS[app]) return openEditor(app, abs, root);
  const args = APPS[app];
  if (!args) throw new Error('неизвестное приложение: ' + app);
  return run('open', [...args, abs]);
}

// --- папки, с которыми работали ----------------------------------------------
// Собираем из того, что приложения уже хранят у себя: список проектов Claude Code,
// рабочие папки окон Cursor и VS Code, cwd сессий Codex (ChatGPT). Плюс папки,
// добавленные вручную, и список убранных в подвал — они лежат в workspaces.json.
// Источники и описания общие с MCP: project-catalog.mjs.
const workspaceList = () => catalogWorkspaces(PROJECTS);

// --- переход по абсолютному пути ---------------------------------------------
// Корень выбираем по очереди: сначала избранные проекты, потом всё, что не убрано в подвал,
// и только затем остальное. Если подходит несколько корней — берём самый глубокий.
const under = (root, target) => target === root || target.startsWith(root + path.sep);

function deepest(roots, target) {
  let best = '';
  for (const root of roots) {
    if (!root || !under(path.resolve(root), target)) continue;
    const abs = path.resolve(root);
    if (abs.length > best.length) best = abs;
  }
  return best;
}

async function resolveGoto(raw) {
  let input = raw.trim().replace(/^['"]|['"]$/g, '');
  if (input.startsWith('file://')) input = decodeURIComponent(input.slice('file://'.length));
  if (!input) return { error: 'не указан путь' };
  const target = expand(input).replace(/\/$/, '');
  const st = await fsp.stat(target).catch(() => null);
  if (!st) return { error: 'Файла нет: ' + target };

  const items = await workspaceList();
  const tiers = [
    PROJECTS.filter((pr) => pr.fav).map((pr) => pr.root),
    [...items.filter((it) => !it.hidden).map((it) => it.path), ...PROJECTS.map((pr) => pr.root)],
    [...items.map((it) => it.path), ...PROJECTS.map((pr) => pr.root)],
  ];
  for (const tier of tiers) {
    const root = deepest(tier, target);
    if (!root) continue;
    const project = await ensureProject(root, undefined);
    if (!project) continue;
    return { project, path: path.relative(root, target).split(path.sep).join('/'), root, dir: st.isDirectory() };
  }
  return { error: 'Файл вне проекта' };
}

// --- значки приложений -------------------------------------------------------
// Берём настоящие значки установленных приложений: .icns из бандла → png через sips.
// Приложения нет — отдаём 404, и в интерфейсе остаётся текстовая подпись кнопки.
const APP_BUNDLES = {
  vscode: '/Applications/Visual Studio Code.app',
  cursor: '/Applications/Cursor.app',
  obsidian: '/Applications/Obsidian.app',
  claude: '/Applications/Claude.app',
  codex: '/Applications/ChatGPT.app',        // приложение Codex, оно же ChatGPT (com.openai.codex)
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

// Сервер слушает только на 127.0.0.1, но чужой браузерный контекст всё равно может
// достучаться: страница злого сайта шлёт POST с чужим Origin (Content-Type text/plain
// проходит без CORS-preflight, а readBody его не проверяет), а DNS-rebinding подставляет
// чужой Host. Такие запросы не обслуживаем — проверка стоит в самом начале обработчиков.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', os.hostname().toLowerCase()]);
const hostnameOf = (host) => {
  const h = String(host || '');
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end < 0 ? '' : h.slice(1, end).toLowerCase(); }
  const colon = h.lastIndexOf(':');
  return (colon > -1 ? h.slice(0, colon) : h).toLowerCase();
};
const fromViewer = (req) =>
  LOCAL_HOSTS.has(hostnameOf(req.headers.host)) &&
  (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`);

async function serveStatic(res, baseDir, rel) {
  const abs = path.resolve(baseDir, rel.replace(/^\/+/, ''));
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return send(res, 403, 'forbidden');
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
    if (!fromViewer(req)) return send(res, 403, 'forbidden');
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
    if (!fromViewer(req)) return json(res, 403, { error: 'запрос не из просмотрщика' });
    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(HERE, 'public'), 'index.html');
    if (p.startsWith('/public/')) return serveStatic(res, path.join(HERE, 'public'), p.slice(8));
    if (p.startsWith('/vendor/')) return serveStatic(res, path.join(HERE, 'vendor'), p.slice(8));

    const project = projectById(url.searchParams.get('project'));

    if (p === '/api/projects') {
      return json(res, 200, { projects: await projectSummaries() });
    }

    if (p === '/api/project-settings' && req.method === 'POST') {
      const body = await readBody(req);
      const root = expand(String(body.path || project.root));
      const known = PROJECTS.find((pr) => pr.root === root) || (await workspaceList()).find((it) => it.path === root);
      if (!known) {
        return json(res, 400, { error: 'Неизвестный проект' });
      }
      if (!Object.hasOwn(body, 'title') && !Object.hasOwn(body, 'description')) {
        return json(res, 400, { error: 'Не переданы заголовок или описание' });
      }
      const changes = {
        ...(Object.hasOwn(body, 'title') ? { title: validateTitle(body.title) } : {}),
        ...(Object.hasOwn(body, 'description') ? { description: validateDescription(body.description) } : {}),
      };
      await serializeSettings(root, async () => {
        const cfg = await readSettings(root) || { sections: await topLevelSections(root) };
        await writeSettings(root, { ...cfg, ...changes });
      });
      const info = await readProjectInfo(root, known.name);
      broadcast({ type: 'project-settings', root, ...info });
      return json(res, 200, info);
    }

    if (p === '/api/workspaces' && req.method === 'POST') {
      const body = await readBody(req);
      const abs = body.path ? expand(String(body.path)) : '';
      const file = await readWorkspacesFile();
      const drop = (list) => list.filter((x) => expand(x) !== abs);
      if (!abs) return json(res, 400, { error: 'не указана папка' });
      switch (body.action) {
        case 'fav':
          return json(res, 200, { project: await ensureProject(abs, body.on !== false) });
        case 'use':
          return json(res, 200, { project: await ensureProject(abs, undefined) });
        case 'hide':
          file.hidden = [...drop(file.hidden), shortHome(abs)];
          break;
        case 'show':
          file.hidden = drop(file.hidden);
          break;
        case 'add': {
          await addWorkspace(abs);
          return json(res, 200, { ok: true });
        }
        case 'remove':
          file.extra = drop(file.extra);
          file.hidden = drop(file.hidden);
          if (PROJECTS.some((pr) => path.resolve(pr.root) === abs)) await dropProject(abs);
          break;
        default:
          return json(res, 400, { error: 'неизвестное действие' });
      }
      await writeWorkspacesFile(file);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/workspaces') return json(res, 200, { items: await workspaceList() });

    if (p === '/api/goto' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await resolveGoto(String(body.path || '')));
    }

    if (p === '/api/pickfolder' && req.method === 'POST') {
      // родного выбора папки у браузера нет — просим системный диалог
      const chosen = await new Promise((resolve) => {
        const proc = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "Папка проекта")'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        proc.stdout.on('data', (chunk) => { out += chunk; });
        proc.on('error', () => resolve(''));
        proc.on('exit', (code) => resolve(code === 0 ? out.trim() : ''));
      });
      if (!chosen) return json(res, 200, { path: '' });     // отменили выбор
      const abs = await addWorkspace(chosen);   // osascript отдаёт путь в NFD — нормализуем в addWorkspace
      return json(res, 200, { path: abs });
    }

    if (p === '/api/meta') {
      return json(res, 200, {
        root: project.root, name: project.name, project: project.id, host: os.hostname(), home: os.homedir(),
        ...await readProjectInfo(project.root, project.name),
        assets: ASSET_ORIGIN,
        projects: await projectSummaries(),
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
      return json(res, 200, await serializeSettings(project.root, () => writeFavorite(project, body.path, body.on !== false)));
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await serializeSettings(project.root, () => writeConfig(project, body)));
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
