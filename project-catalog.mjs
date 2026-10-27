// Общий каталог проектов для веб-интерфейса и автономного MCP (без HTTP и наблюдателей).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readProjectInfo } from './project-settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const shortHome = (p) => (p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
const fileDates = (st) => ({ birthtime: st?.birthtimeMs > 0 ? st.birthtimeMs : null, mtime: st?.mtimeMs || 0 });

const slug = (s) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-+|-+$/g, '') || 'p';
// macOS отдаёт пути в NFD («найм» из двух кодпоинтов), а в конфигах путь лежит в NFC:
// строки разные, папка одна — все пути, прошедшие через expand, сравниваем в NFC.
const norm = (p) => p.normalize('NFC');
const expand = (p) => norm(path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p));

function loadProjects({ args = process.argv.slice(2).filter((a) => !a.startsWith('-')), fallback = true } = {}) {
  let raw = [];
  if (args.length) raw = args;
  else if (process.env.DOCVIEWER_ROOTS) raw = process.env.DOCVIEWER_ROOTS.split(':').filter(Boolean);
  else if (process.env.DOCVIEWER_ROOT) raw = [process.env.DOCVIEWER_ROOT];
  else {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'projects.json'), 'utf8'));
      raw = Array.isArray(cfg.projects) ? cfg.projects : [];
    } catch { raw = fallback ? [process.cwd()] : []; }
  }
  const out = [];
  const roots = new Set(), ids = new Set();
  for (const item of raw) {
    const entry = typeof item === 'string' ? { path: item } : item;
    if (!entry || !entry.path) continue;
    const root = expand(entry.path);
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`Пропускаю проект — папки нет: ${root}`);
      continue;
    }
    if (roots.has(root)) continue;   // одна папка под двумя начертаниями пути (NFC и NFD)
    roots.add(root);
    const name = entry.name || path.basename(root);
    // fav: false — проект открывается, но в списке наверху не показывается
    let id = entry.id || slug(name);
    for (let n = 2; ids.has(id); n++) id = `${entry.id || slug(name)}-${n}`;
    ids.add(id);
    out.push({ id, name, root, raw: entry.path, fav: entry.fav !== false });
  }
  if (!out.length && fallback) {
    const root = process.cwd();
    out.push({ id: slug(path.basename(root)), name: path.basename(root), root, fav: true });
  }
  return out;
}


const HOME = os.homedir();
const WORKSPACES_FILE = path.join(HERE, 'workspaces.json');
const WS_TTL = 20000;
let wsCache = { at: 0, items: [] };

const readJson = async (file) => { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; } };
const claudeSlug = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

async function readWorkspacesFile() {
  const data = (await readJson(WORKSPACES_FILE)) || {};
  return { hidden: Array.isArray(data.hidden) ? data.hidden : [], extra: Array.isArray(data.extra) ? data.extra : [] };
}
const writeWorkspacesFile = (data) => fsp.writeFile(WORKSPACES_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');

async function addWorkspace(raw) {
  const abs = expand(raw);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('папки нет: ' + abs);
  const file = await readWorkspacesFile();
  file.extra = [...file.extra.filter((x) => expand(x) !== abs), shortHome(abs)];
  // Повторное добавление возвращает папку из скрытых, в том числе при NFC/NFD путях macOS.
  file.hidden = file.hidden.filter((x) => expand(x) !== abs);
  await writeWorkspacesFile(file);
  return abs;
}

async function scanClaude(add) {
  const cfg = await readJson(path.join(HOME, '.claude.json'));
  for (const p of Object.keys((cfg && cfg.projects) || {})) {
    const st = await fsp.stat(path.join(HOME, '.claude', 'projects', claudeSlug(p))).catch(() => null);
    add(p, 'claude', st ? st.mtimeMs : 0);
  }
}

async function scanEditor(appDir, source, add) {
  const base = path.join(HOME, 'Library/Application Support', appDir, 'User/workspaceStorage');
  for (const dir of await fsp.readdir(base).catch(() => [])) {
    const info = await readJson(path.join(base, dir, 'workspace.json'));
    const uri = info && info.folder;
    if (!uri || !uri.startsWith('file://')) continue;
    const st = await fsp.stat(path.join(base, dir)).catch(() => null);
    add(decodeURIComponent(uri.slice('file://'.length)), source, st ? st.mtimeMs : 0);
  }
}

// Проекты приложения Codex лежат в его базе `~/.codex/state_<N>.sqlite`: таблицы
// `projects` и `project_roots`. Берём именно их, а не рабочие папки разговоров: чат без
// проекта Codex заводит в отдельной папке `~/Documents/Codex/<дата>/<название чата>`,
// и раньше список заполняли как раз они — по папке на чат.
// Дата проекта в базе одна на всех (её проставила миграция), поэтому берём дату последнего
// разговора в этой папке: `threads.updated_at`, секунды.
async function scanCodex(add) {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { return; }   // сборка Node без node:sqlite
  const dir = path.join(HOME, '.codex');
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => /^state_\d+\.sqlite$/.test(f));
  if (!files.length) return;
  // имя файла версионное: state_6 новее state_5
  files.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  let db = null;
  try {
    db = new sqlite.DatabaseSync(path.join(dir, files[files.length - 1]), { readOnly: true });
    const lastUse = new Map();
    for (const row of db.prepare('SELECT cwd, MAX(updated_at) AS at FROM threads GROUP BY cwd').all()) {
      lastUse.set(row.cwd, Number(row.at) * 1000);
    }
    const sql = 'SELECT r.path AS path, p.updated_at_ms AS at FROM project_roots r JOIN projects p ON p.id = r.project_id';
    for (const row of db.prepare(sql).all()) add(row.path, 'codex', lastUse.get(row.path) || Number(row.at) || 0);
  } catch (err) {
    console.error('Codex: база проектов не прочиталась:', err.message);
  } finally {
    try { if (db) db.close(); } catch { /* уже закрыта */ }
  }
}

async function collectWorkspaces() {
  if (Date.now() - wsCache.at < WS_TTL) return wsCache.items;
  const found = new Map();
  const seenDir = new Map();
  const isDir = async (p) => {
    if (seenDir.has(p)) return seenDir.get(p);
    const st = await fsp.stat(p).catch(() => null);
    const ok = !!st && st.isDirectory();
    seenDir.set(p, ok);
    return ok;
  };
  const pending = [];
  // Служебные копии не проекты: временные папки Claude и рабочие копии агентов
  const JUNK = ['/Library/Application Support/Claude/scratch-workspaces/', '/.claude/worktrees/', '/.git/',
    '/Documents/Codex/'];   // папки, которые Codex заводит под чат без проекта
  const add = (raw, source, at) => {
    if (!raw || typeof raw !== 'string') return;
    const abs = norm(path.resolve(raw.replace(/\/$/, '')));
    if (abs === '/' || abs === HOME) return;               // корень диска и домашняя папка — не проекты
    if (JUNK.some((junk) => abs.includes(junk))) return;
    pending.push({ abs, source, at: at || 0 });
  };
  await Promise.all([
    scanClaude(add),
    scanCodex(add),
    scanEditor('Cursor', 'cursor', add),
    scanEditor('Code', 'vscode', add),
  ]);
  for (const { abs, source, at } of pending) {
    if (!(await isDir(abs))) continue;                     // папку могли удалить или переименовать
    const item = found.get(abs) || { path: abs, name: path.basename(abs), sources: [], at: 0 };
    if (!item.sources.includes(source)) item.sources.push(source);
    item.at = Math.max(item.at, at);
    found.set(abs, item);
  }
  wsCache = { at: Date.now(), items: [...found.values()] };
  return wsCache.items;
}

async function workspaceList(projects = loadProjects(), { starredOnly = false } = {}) {
  const items = (starredOnly ? [] : await collectWorkspaces()).map((it) => ({ ...it, sources: [...it.sources] }));
  const { hidden, extra } = await readWorkspacesFile();
  const byPath = new Map(items.map((it) => [it.path, it]));
  for (const raw of starredOnly ? [] : extra) {
    const abs = expand(raw);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isDirectory()) continue;
    const item = byPath.get(abs) || { path: abs, name: path.basename(abs), sources: [], at: st.mtimeMs };
    item.manual = true;
    byPath.set(abs, item);
  }
  for (const project of projects.filter((p) => !starredOnly || p.fav)) {
    const item = byPath.get(path.resolve(project.root));
    if (item) continue;
    byPath.set(path.resolve(project.root), {
      path: path.resolve(project.root), name: project.name, sources: [], at: 0, manual: true,
    });
  }
  const hiddenSet = new Set(hidden.map(expand));
  const list = await Promise.all([...byPath.values()].map(async (it) => {
    const st = await fsp.stat(it.path).catch(() => null);
    const project = projects.find((p) => path.resolve(p.root) === it.path);
    return {
      ...it,
      name: project ? project.name : it.name,
      ...fileDates(st),
      ...await readProjectInfo(it.path, project ? project.name : it.name),
      hidden: hiddenSet.has(it.path),
      listed: !!project,
      fav: !!project && project.fav,
      project: project ? project.id : '',
    };
  }));
  list.sort((a, b) => (b.fav - a.fav) || (b.at - a.at) || a.name.localeCompare(b.name, 'ru'));
  return list;
}


export { loadProjects, workspaceList, expand, norm, slug, shortHome, readJson, readWorkspacesFile, writeWorkspacesFile, addWorkspace };
