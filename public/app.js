/* Просмотрщик документации: дерево, markdown, живое обновление. */
(() => {
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const TEXT_EXT = new Set(['.md', '.mdc', '.txt', '.py', '.sh', '.json', '.yml', '.yaml', '.html', '.css', '.js', '.mjs', '.ts', '.puml', '.xml', '.csv', '.ndjson', '.toml', '.ini', '.sql', '.feature']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const PAGE_EXT = new Set(['.html', '.htm']);   // показываем страницей, а не исходником
// какой проект открыт — в адресе (?project=…), чтобы ссылку можно было сохранить
const PROJECT = new URLSearchParams(location.search).get('project') || '';
const key = (name) => `dv.${PROJECT || 'default'}.${name}`;
const LS = {
  get open() { try { return new Set(JSON.parse(localStorage.getItem(key('open')) || '[]')); } catch { return new Set(); } },
  set open(s) { localStorage.setItem(key('open'), JSON.stringify([...s])); },
};

const state = {
  tree: [], files: [], fileSet: new Set(), dirSet: new Set(), dirMap: new Map(), current: null,
  expanded: LS.open, filter: '', tab: 'tree', lastQuery: '',
  config: null, sections: [], hidden: [], favorites: [], projects: [], project: PROJECT, root: '',
  home: '', meta: null, picking: false, wsItems: null, wsQuery: '',
  wsFav: localStorage.getItem('dv.wsfav') === '1', sort: localStorage.getItem('dv.sort') || 'custom',
  editing: false, showSource: false, assets: '',
};

/* ---------- «Заголовок С Заглавной» для читабельности плиток ---------- */
function cap(s) { return s ? s[0].toLocaleUpperCase('ru') + s.slice(1) : s; }

function plural(n, forms) {          // forms: [1 документ, 2 документа, 5 документов]
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  return b === 1 ? forms[0] : forms[2];
}
const docsWord = (n) => `${n} ${plural(n, ['документ', 'документа', 'документов'])}`;
const filesWord = (n) => `${n} ${plural(n, ['файл', 'файла', 'файлов'])}`;

const dark = matchMedia('(prefers-color-scheme: dark)');

/* ---------- пути ---------- */
function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function extname(p) { const b = p.slice(p.lastIndexOf('/') + 1); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i).toLowerCase(); }
function resolvePath(base, rel) {
  const parts = (base ? base.split('/') : []).concat(rel.split('/'));
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

/* ---------- сеть ---------- */
const withProject = (url) => {
  if (!PROJECT) return url;
  return url + (url.includes('?') ? '&' : '?') + 'project=' + encodeURIComponent(PROJECT);
};

const api = async (url, opts) => {
  const r = await fetch(withProject(url), opts);
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || r.statusText);
  return data;
};

/* ---------- уведомления ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------- дерево ---------- */
function flatten(items, acc = []) {
  for (const it of items) { if (it.dir) flatten(it.children, acc); else acc.push(it); }
  return acc;
}

function indexDirs(items, map = new Map()) {
  for (const it of items) if (it.dir) { map.set(it.path, it); indexDirs(it.children, map); }
  return map;
}

function matchesFilter(node, needle) {
  if (!needle) return true;
  if (node.path.toLowerCase().includes(needle)) return true;
  return node.dir && node.children.some((c) => matchesFilter(c, needle));
}

function updateCounter() {
  $('#counter').textContent = filesWord(state.files.length);
}

function renderTree() {
  const host = $('#tree');
  host.textContent = '';
  const needle = state.filter.trim().toLowerCase();
  const build = (items, parent) => {
    for (const node of items) {
      if (!matchesFilter(node, needle)) continue;
      const wrap = el('div', 'node');
      const row = el('div', 'row');
      row.dataset.path = node.path;
      if (node.dir) {
        const open = needle ? true : state.expanded.has(node.path);
        row.appendChild(el('span', 'caret', open ? '▾' : '▸'));
        row.appendChild(el('span', 'label', node.name));
        row.onclick = () => {
          if (state.expanded.has(node.path)) state.expanded.delete(node.path); else state.expanded.add(node.path);
          LS.open = state.expanded;
          renderTree();
        };
        wrap.appendChild(row);
        if (open) {
          const kids = el('div', 'children');
          build(node.children, kids);
          wrap.appendChild(kids);
        }
      } else {
        row.appendChild(el('span', 'caret', ''));
        row.appendChild(el('span', 'label', node.name));
        if (node.ext && node.ext !== '.md') row.appendChild(el('span', 'ext', node.ext.slice(1)));
        if (node.path === state.current) row.classList.add('current');
        row.onclick = () => navigate(node.path);
        wrap.appendChild(row);
      }
      parent.appendChild(wrap);
    }
  };
  build(state.tree, host);
  updateCounter();
}

async function loadConfig() {
  try {
    state.config = await api('/api/config');
    state.sections = state.config.sections || [];
    state.hidden = state.config.hidden || [];
    state.favorites = state.config.favorites || [];
  } catch (err) {
    state.config = { title: 'Навигация по документации', subtitle: '', sections: [], notice: 'Настройки разделов не прочитаны: ' + err.message };
    state.sections = [];
  }
}

async function loadTree() {
  const data = await api('/api/tree');
  state.tree = data.items;
  state.files = flatten(data.items);
  state.fileSet = new Set(state.files.map((f) => f.path));
  state.dirMap = indexDirs(data.items);
  state.dirSet = new Set(state.dirMap.keys());
  renderTree();
}

function revealInTree(p) {
  let acc = '';
  for (const seg of dirname(p).split('/').filter(Boolean)) {
    acc = acc ? acc + '/' + seg : seg;
    state.expanded.add(acc);
  }
  LS.open = state.expanded;
  renderTree();
  const row = $(`#tree .row[data-path="${CSS.escape(p)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

/* ---------- markdown ---------- */
marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: null, body: text, offset: 0 };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: null, body: text, offset: 0 };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const bodyAt = text.indexOf('\n', end + 1) + 1;
  const body = text.slice(bodyAt);
  const offset = countLines(text.slice(0, bodyAt));   // столько строк файла ушло на заголовок
  const meta = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) meta.push([m[1], m[2]]);
    else if (line.trim() && meta.length) meta[meta.length - 1][1] += ' ' + line.trim();
  }
  return { meta, body, offset };
}

/* ---------- номера строк документа ---------- */
const countLines = (text) => (text.match(/\n/g) || []).length;

// Блоки с собственной прокруткой (таблицы, код, схемы) срезали бы номер по краю,
// поэтому у них номер живёт на внешней обёртке.
function lineOutside(node) {
  const line = node.dataset.line;
  if (!line || node.parentElement.classList.contains('lined-block')) return;
  const outer = el('div', 'lined-block');
  outer.dataset.line = line;
  delete node.dataset.line;
  node.replaceWith(outer);
  outer.appendChild(node);
}

// marked разбирает текст на верхнеуровневые блоки и хранит у каждого исходный кусок текста —
// по нему и считаем, с какой строки файла блок начинается. Разметку не трогаем: номер живёт
// в data-line и рисуется псевдоэлементом в поле слева.
// В markdown строка таблицы — это ровно одна строка файла, поэтому номера строк считаются
// прямо по исходному куску: шапка, разделитель, дальше по строке на запись.
function tagTableRows(table, startLine, raw) {
  const lines = raw.replace(/\n$/, '').split('\n');
  let head = 0;
  while (head < lines.length && !lines[head].trim()) head++;
  const rows = [];
  for (let i = head + 2; i < lines.length; i++) if (lines[i].trim()) rows.push(startLine + i);
  const headRow = table.querySelector('thead tr');
  if (headRow) headRow.dataset.line = startLine + head;
  [...table.querySelectorAll('tbody tr')].forEach((tr, i) => {
    if (rows[i] != null) tr.dataset.line = rows[i];
  });
}

// Пункт списка может занимать несколько строк, поэтому идём по исходным кускам пунктов.
// Вложенные списки нумеруются тем же порядком.
function tagListItems(list, startLine, token) {
  const items = [...list.children].filter((n) => n.tagName === 'LI');
  let line = startLine;
  (token.items || []).forEach((item, i) => {
    const li = items[i];
    if (li) {
      li.dataset.line = line;
      const nestedToken = (item.tokens || []).find((t) => t.type === 'list');
      const nested = li.querySelector(':scope > ul, :scope > ol');
      if (nested && nestedToken) {
        const before = item.tokens.slice(0, item.tokens.indexOf(nestedToken)).map((t) => t.raw || '').join('');
        tagListItems(nested, line + countLines(before), nestedToken);
      }
    }
    line += countLines(item.raw);
  });
}

// Обёртка без собственного номера: номера пунктов и строк таблицы расставляются по измерениям.
function wrapForNumbers(node) {
  if (node.parentElement.classList.contains('lined-block')) return;
  const outer = el('div', 'lined-block');
  node.replaceWith(outer);
  outer.appendChild(node);
}

function renderMarkdown(body, firstLine) {
  const holder = el('div', 'lined');
  try {
    const tokens = marked.lexer(body);
    const box = el('div');
    let line = firstLine;
    for (const token of tokens) {
      const start = line;
      line += countLines(token.raw);
      if (token.type === 'space') continue;
      const one = [token];
      one.links = tokens.links;          // иначе ссылки-сноски потеряются
      box.innerHTML = marked.parser(one);
      for (const node of [...box.children]) {
        node.dataset.line = start;
        if (token.type === 'table' && node.tagName === 'TABLE') tagTableRows(node, start, token.raw);
        holder.appendChild(node);
        if (token.type === 'list' && (node.tagName === 'UL' || node.tagName === 'OL')) {
          tagListItems(node, start, token);
          delete node.dataset.line;        // номер первого пункта и есть номер списка
          wrapForNumbers(node);
        }
      }
    }
  } catch {
    holder.textContent = '';
    holder.innerHTML = marked.parse(body);   // разбор по блокам не удался — рисуем как раньше
  }
  return holder;
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^\wа-яё\s-]/gi, '').replace(/\s+/g, '-').slice(0, 80) || 'h';
}

function renderFrontmatter(meta) {
  const box = el('div', 'frontmatter');
  const grid = el('div', 'fm-grid');
  for (const [k, v] of meta) {
    grid.appendChild(el('div', 'k', k));
    grid.appendChild(el('div', 'v', v));
  }
  box.appendChild(grid);
  return box;
}

let mermaidReady = false;
function initMermaid() {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: dark.matches ? 'dark' : 'default',
    // useMaxWidth сжимает широкие схемы до нечитаемости — рисуем в натуральную величину,
    // а тесноту решают прокрутка блока и просмотр во весь экран.
    flowchart: { useMaxWidth: false, htmlLabels: true },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    journey: { useMaxWidth: false },
  });
  mermaidReady = true;
}

// Номера строк отдельной колонкой слева: разметку подсветки не трогаем, поэтому ничего не рвётся,
// а при горизонтальной прокрутке кода номера остаются на месте. Короткие вставки не нумеруем.
const MIN_NUMBERED = 3;
function addLineNumbers(pre, { always = false } = {}) {
  if (!pre || pre.parentElement.classList.contains('code-wrap')) return;
  const code = pre.querySelector('code') || pre;
  const lines = code.textContent.replace(/\n$/, '').split('\n').length;
  if (!always && lines < MIN_NUMBERED) { lineOutside(pre); return; }
  const wrap = el('div', 'code-wrap');
  if (pre.dataset.line) wrap.dataset.line = pre.dataset.line;
  pre.replaceWith(wrap);
  const gutter = el('div', 'code-lines');
  gutter.setAttribute('aria-hidden', 'true');   // для чтения вслух номера лишние
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  wrap.appendChild(gutter);
  wrap.appendChild(pre);
  lineOutside(wrap);
}

async function enhance(doc, filePath) {
  const base = dirname(filePath);

  // заголовки и оглавление
  const toc = $('#toc');
  toc.textContent = '';
  const used = new Set();
  doc.querySelectorAll('h1, h2, h3').forEach((h) => {
    let id = slugify(h.textContent);
    let n = 2; while (used.has(id)) id = slugify(h.textContent) + '-' + n++;
    used.add(id); h.id = id;
    if (h.tagName === 'H1') return;
    const a = el('a', h.tagName === 'H3' ? 'lvl3' : 'lvl2', h.textContent);
    a.href = '#' + id;
    a.onclick = (e) => { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    toc.appendChild(a);
  });

  // ссылки
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; return; }
    if (href.startsWith('#')) {
      a.onclick = (e) => { e.preventDefault(); const t = doc.querySelector('#' + CSS.escape(href.slice(1))) || [...doc.querySelectorAll('h1,h2,h3')].find((h) => slugify(h.textContent) === href.slice(1)); if (t) t.scrollIntoView({ behavior: 'smooth' }); };
      return;
    }
    const [rawPath, anchor] = decodeURI(href).split('#');
    const target = resolvePath(base, rawPath);
    if (!state.fileSet.has(target) && !state.dirSet.has(target)) a.classList.add('missing');
    a.href = '#' + target + (anchor ? '#' + anchor : '');
    a.onclick = (e) => {
      e.preventDefault();
      if (!state.fileSet.has(target) && !state.dirSet.has(target)) { toast('Файла нет: ' + target); return; }
      navigate(target, anchor);
    };
  });

  // изображения
  doc.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (/^(https?:|data:)/i.test(src)) return;
    img.src = withProject('/raw?p=' + encodeURIComponent(resolvePath(base, decodeURI(src))));
  });

  // таблицы: колонки по объёму текста, широкие — с горизонтальной прокруткой
  doc.querySelectorAll('table').forEach((table) => {
    if (!table.parentElement.classList.contains('table-wrap')) {
      const wrap = el('div', 'table-wrap');
      if (table.dataset.line) wrap.dataset.line = table.dataset.line;
      table.replaceWith(wrap);
      wrap.appendChild(table);
      lineOutside(wrap);
    }
  });
  relayoutTables();

  // код и mermaid
  const blocks = [...doc.querySelectorAll('pre > code')];
  const mermaids = blocks.filter((c) => c.className.includes('language-mermaid'));
  blocks.filter((c) => !c.className.includes('language-mermaid')).forEach((c) => {
    try { hljs.highlightElement(c); } catch { /* язык не распознан */ }
    addLineNumbers(c.parentElement);
  });
  if (mermaids.length) {
    initMermaid();
    for (let i = 0; i < mermaids.length; i++) {
      const pre = mermaids[i].parentElement;
      const code = mermaids[i].textContent;
      const box = el('div', 'mermaid');
      if (pre.dataset.line) box.dataset.line = pre.dataset.line;
      pre.replaceWith(box);
      lineOutside(box);
      try {
        const { svg } = await mermaid.render('mmd-' + Date.now() + '-' + i, code);
        box.innerHTML = svg;
        decorateDiagram(box, code);
      } catch (err) {
        box.classList.add('mermaid-error');
        box.textContent = 'Схема не построена: ' + (err && err.message ? err.message.split('\n')[0] : err);
      }
    }
  }
  placeMeasuredNumbers();   // схемы меняют высоту — номера ставим по итоговой раскладке
}

/* ---------- меню разделов ---------- */
async function saveSections(paths) {
  try {
    state.config = await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: paths }),
    });
    state.sections = state.config.sections || [];
    state.hidden = state.config.hidden || [];
    state.favorites = state.config.favorites || [];
    renderHome();
    toast('Меню сохранено в docviewer.json');
  } catch (err) {
    toast('Не удалось сохранить: ' + err.message);
  }
}

const isFavorite = (p) => state.favorites.some((f) => f.path === p);

async function toggleFavorite(p, on = !isFavorite(p)) {
  try {
    state.config = await api('/api/favorite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, on }),
    });
    state.favorites = state.config.favorites || [];
    syncFavButton();
    if (!state.current) renderHome();
    toast(on ? 'Добавлено в избранное' : 'Убрано из избранного');
  } catch (err) {
    toast('Не получилось: ' + err.message);
  }
}

function syncFavButton() {
  const btn = $('#fav-btn');
  const active = state.current && state.fileSet.has(state.current);
  btn.hidden = !active;
  if (!active) return;
  const on = isFavorite(state.current);
  btn.textContent = on ? '★' : '☆';
  btn.classList.toggle('on', on);
  btn.title = on ? 'Убрать из избранного' : 'Добавить в избранное — появится в меню разделов';
}

const sectionPaths = () => state.sections.map((s) => s.path);
const hideSection = (p) => saveSections(sectionPaths().filter((x) => x !== p));
const showSection = (p) => saveSections([...sectionPaths(), p]);

function sectionStats(secPath) {
  const files = state.files.filter((f) => f.path === secPath || f.path.startsWith(secPath + '/'));
  const docs = files.filter((f) => f.ext === '.md' || f.ext === '.mdc').length;
  const node = state.dirMap.get(secPath);
  const subs = node ? node.children.filter((c) => c.dir) : [];
  return { total: files.length, docs, subs };
}

function renderHome({ scroll = 0 } = {}) {
  closeFind();
  state.current = null;
  localStorage.removeItem(key('last'));
  document.body.classList.remove('picking');
  document.title = 'Документация — навигация';
  $('#crumbs').textContent = 'Меню разделов';
  document.querySelectorAll('.actions button').forEach((b) => { b.disabled = true; });
  // из меню приложения открывают сам проект: корень репозитория
  document.querySelectorAll('.actions button[data-open]').forEach((b) => { b.disabled = false; });
  $('#up-btn').hidden = true;
  $('#fav-btn').hidden = true;
  $('#toc').textContent = '';
  renderTree();

  const doc = $('#doc');
  doc.textContent = '';
  const home = el('div', 'home');
  if (state.editing) home.classList.add('editing');
  const cfg = state.config || { title: 'Навигация по документации', subtitle: '', sections: [] };

  const head = el('div', 'home-head');
  const titleRow = el('div', 'home-title-row');
  titleRow.appendChild(el('h1', null, cfg.title));
  const setup = el('button', 'setup-btn', state.editing ? 'Готово' : 'Настроить');
  setup.title = state.editing
    ? 'Выйти из настройки меню'
    : 'Настроить состав меню: клик по разделу убирает его вниз, клик по папке внизу возвращает наверх';
  if (state.editing) setup.classList.add('active');
  setup.onclick = () => { state.editing = !state.editing; renderHome(); };
  titleRow.appendChild(setup);
  titleRow.appendChild(sortRow(() => renderHome({ scroll: $('#scroller').scrollTop }), { custom: 'Как настроено' }));
  head.appendChild(titleRow);
  if (cfg.subtitle) head.appendChild(el('p', 'home-sub', cfg.subtitle));
  if (cfg.notice) head.appendChild(el('p', 'home-warn', cfg.notice));
  if (state.editing) {
    head.appendChild(el('p', 'home-hint',
      'Клик по разделу убирает его вниз, клик по папке внизу поднимает в меню. Состав сразу пишется в docviewer.json.'));
  }
  home.appendChild(head);

  const favs = state.favorites.filter((f) => f.exists);
  if (favs.length) {
    home.appendChild(el('div', 'group-title', state.editing ? 'Избранное — клик убирает из списка' : 'Избранное'));
    const grid = el('div', 'file-tiles');
    for (const fav of favs) {
      const tile = fileTile({ ...fav, dir: false });
      if (state.editing) {
        tile.classList.add('editable');
        tile.title = 'Убрать «' + cap(fav.title || fav.name) + '» из избранного';
        tile.onclick = () => toggleFavorite(fav.path, false);
      }
      grid.appendChild(tile);
    }
    home.appendChild(grid);
    home.appendChild(el('div', 'group-title', 'Разделы'));
  }

  const tiles = el('div', 'tiles big');
  for (const sec of sortSections(state.sections)) {
    const tile = el('button', 'tile');
    if (!sec.exists) tile.classList.add('gone');
    const top = el('div', 'tile-top');
    top.appendChild(el('span', 'tile-icon', sec.icon || '▸'));
    top.appendChild(el('span', 'tile-title', cap(sec.title)));
    tile.appendChild(top);
    if (sec.description) tile.appendChild(el('div', 'tile-desc', sec.description));
    if (!sec.exists) {
      tile.appendChild(el('div', 'tile-meta', 'папки нет: ' + sec.path));
    } else {
      const st = sectionStats(sec.path);
      tile.appendChild(el('div', 'tile-meta', `${sec.path}/ · ${docsWord(st.docs)} · ${filesWord(st.total)}`));
      if (st.subs.length && !state.editing) {
        const subs = el('div', 'tile-subs');
        for (const sub of st.subs) {
          const chip = el('span', 'chip', cap(sub.name));
          chip.onclick = (e) => { e.stopPropagation(); navigate(sub.path); };
          subs.appendChild(chip);
        }
        tile.appendChild(subs);
      }
    }
    if (state.editing) {
      tile.classList.add('editable');
      tile.appendChild(el('span', 'tile-mark', '↓'));
      tile.title = 'Убрать «' + cap(sec.title) + '» вниз';
      tile.onclick = () => hideSection(sec.path);
    } else if (sec.exists) {
      tile.onclick = () => navigate(sec.path);
    } else {
      tile.disabled = true;
    }
    tiles.appendChild(tile);
  }
  home.appendChild(tiles);
  if (!state.sections.length) home.appendChild(el('div', 'empty', 'В меню нет разделов — поднимите папки из списка ниже'));

  // подвал: сначала убранные из меню разделы (со своими подписями), затем прочие папки проекта
  const inMenu = new Set(state.sections.map((s) => s.path));
  const named = new Map(state.hidden.filter((h) => h.exists).map((h) => [h.path, h]));
  const rest = [];
  for (const h of named.values()) rest.push({ path: h.path, label: cap(h.title) });
  for (const n of state.tree) {
    if (n.dir && !inMenu.has(n.path) && !named.has(n.path)) rest.push({ path: n.path, label: cap(n.name) });
  }
  if (rest.length) {
    home.appendChild(el('div', 'home-rest-title', state.editing ? 'Не в меню — клик поднимает наверх' : 'Остальные папки'));
    const row = el('div', 'home-rest');
    for (const item of sortSections(rest)) {
      const chip = el('span', 'chip', item.label);
      if (state.editing) {
        chip.classList.add('add');
        chip.title = 'Поднять «' + item.label + '» в меню';
        chip.onclick = () => showSection(item.path);
      } else {
        chip.onclick = () => navigate(item.path);
      }
      row.appendChild(chip);
    }
    home.appendChild(row);
  }

  doc.appendChild(home);
  restoreScroll(scroll);
}
/* ---------- выбор проекта ---------- */
// Папки берём из того, где вы уже работали: проекты Claude Code, окна Cursor и VS Code,
// сессии Codex (ChatGPT). Звёздочка добавляет папку в список проектов наверху.
const PICKER = '!projects';
const SOURCE_NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', vscode: 'VS Code' };
const shortPath = (p) => (state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p);

const ws = (action, path, extra = {}) => api('/api/workspaces', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action, path, ...extra }),
});

async function refreshProjects() {
  const data = await api('/api/projects');
  state.projects = data.projects || [];
  if (state.meta) renderProjectSwitch(state.meta);
}

async function openProjectFolder(item) {
  const res = item.project ? { project: item.project } : await ws('use', item.path);
  if (!res.project) { toast('Не удалось открыть папку'); return; }
  location.href = `${location.pathname}?project=${encodeURIComponent(res.project)}`;
}

// Дата берётся из источников: последняя сессия Claude Code, последнее окно Cursor или VS Code и т.д.
function whenText(at) {
  if (!at) return '';
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return days + ' ' + plural(days, ['день', 'дня', 'дней']) + ' назад';
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function wsTile(item, redraw) {
  const tile = el('button', 'tile ws-tile');
  const top = el('div', 'tile-top');
  const apps = el('span', 'ws-apps');
  for (const src of item.sources) {
    const img = new Image();
    img.src = '/api/appicon?app=' + encodeURIComponent(src);
    img.alt = '';
    img.title = 'Работали в ' + (SOURCE_NAMES[src] || src);
    apps.appendChild(img);
  }
  if (!item.sources.length) apps.appendChild(el('span', 'ws-manual', '＋'));   // добавлена вручную
  top.appendChild(apps);
  top.appendChild(el('span', 'tile-title', cap(item.name)));
  tile.appendChild(top);
  const meta = el('div', 'tile-meta', shortPath(item.path));
  const when = whenText(item.at);
  if (when) meta.appendChild(el('span', 'ws-when', when));
  tile.appendChild(meta);

  const star = el('button', 'ws-star' + (item.fav ? ' on' : ''), item.fav ? '★' : '☆');
  star.title = item.fav ? 'Убрать из списка проектов' : 'Добавить в список проектов';
  star.onclick = async (e) => {
    e.stopPropagation();
    await ws('fav', item.path, { on: !item.fav });
    await refreshProjects();
    redraw();
  };
  tile.appendChild(star);

  if (state.picking) {
    tile.classList.add('editable');
    tile.appendChild(el('span', 'tile-mark', '↓'));
    if (!item.sources.length) {          // вручную добавленную папку можно и удалить
      const del = el('button', 'ws-del', '✕');
      del.title = 'Убрать папку из списка совсем';
      del.onclick = async (e) => { e.stopPropagation(); await ws('remove', item.path); redraw(); };
      tile.appendChild(del);
    }
  }

  tile.onclick = async () => {
    if (state.picking) { await ws('hide', item.path); redraw(); return; }
    openProjectFolder(item);
  };
  return tile;
}

async function renderPicker({ refresh = false, keepScroll = false } = {}) {
  const scroller = $('#scroller');
  const wasScroll = scroller.scrollTop;
  const hadFocus = document.activeElement && document.activeElement.classList.contains('ws-search');
  closeFind();
  state.current = null;
  localStorage.removeItem(key('last'));
  document.body.classList.add('picking');   // на экране выбора прячем всю правую часть шапки
  document.title = 'Проекты — просмотрщик';
  $('#crumbs').textContent = 'Выбор проекта';
  document.querySelectorAll('.actions button').forEach((b) => { b.disabled = true; });
  $('#up-btn').hidden = true;
  $('#fav-btn').hidden = true;
  $('#toc').textContent = '';

  const doc = $('#doc');
  doc.textContent = '';
  const home = el('div', 'home' + (state.picking ? ' editing' : ''));
  const head = el('div', 'home-head');
  const row = el('div', 'home-title-row');
  row.appendChild(el('h1', null, 'Проекты'));

  const setup = el('button', 'setup-btn' + (state.picking ? ' active' : ''), state.picking ? 'Готово' : 'Настроить');
  setup.onclick = () => { state.picking = !state.picking; renderPicker({ keepScroll: true }); };
  row.appendChild(setup);

  const add = el('button', 'setup-btn', '＋ Добавить папку');
  add.title = 'Выбрать папку, которой ещё нет ни в одном проекте';
  add.onclick = async () => {
    const res = await api('/api/pickfolder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (res.path) { toast('Добавлено: ' + shortPath(res.path)); renderPicker({ refresh: true, keepScroll: true }); }
  };
  row.appendChild(add);
  head.appendChild(row);

  const tools = el('div', 'ws-tools');
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'ws-search';
  search.placeholder = 'Поиск по имени или пути';
  search.value = state.wsQuery;
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.oninput = () => { state.wsQuery = search.value; paint(); };   // список перерисовываем, поле не трогаем
  search.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const first = list.querySelector('.ws-tile');   // Enter открывает первую найденную папку
    if (first) first.click();
  };
  tools.appendChild(search);
  const sorts = el('div', 'ws-sort');
  const onlyFav = el('button', 'chip' + (state.wsFav ? ' on' : ''), '★ Избранные');
  onlyFav.title = 'Показывать только папки из списка проектов';
  onlyFav.onclick = () => {
    state.wsFav = !state.wsFav;
    localStorage.setItem('dv.wsfav', state.wsFav ? '1' : '0');
    onlyFav.classList.toggle('on', state.wsFav);
    paint();
  };
  sorts.appendChild(onlyFav);
  tools.appendChild(sorts);
  tools.appendChild(sortRow(() => paint(), { fallback: 'date' }));
  head.appendChild(tools);

  head.appendChild(el('p', 'home-sub', 'Папки, с которыми вы работали в Claude Code, Codex, Cursor и VS Code. ' +
    'Звёздочка добавляет папку в список проектов наверху, «Настроить» убирает лишние в подвал.'));
  home.appendChild(head);
  const list = el('div', 'ws-list');
  home.appendChild(list);
  doc.appendChild(home);

  if (refresh || !state.wsItems) {
    try { state.wsItems = (await api('/api/workspaces')).items || []; }
    catch (err) {
      list.appendChild(el('div', 'empty', 'Не удалось собрать список папок: ' + err.message));
      return;
    }
  }
  paint();
  // при перерисовке (настройка, звёздочка) остаёмся на месте, при входе — сверху
  if (keepScroll) scroller.scrollTop = wasScroll;
  else restoreScroll(0);
  if (!keepScroll || hadFocus) search.focus({ preventScroll: true });

  function reload() { renderPicker({ refresh: true, keepScroll: true }); }

  function paint() {
    list.textContent = '';
    const needle = state.wsQuery.trim().toLowerCase();
    const found = sortEntries((state.wsItems || [])
      .filter((it) => !state.wsFav || it.fav)
      .filter((it) => !needle || it.name.toLowerCase().includes(needle) || shortPath(it.path).toLowerCase().includes(needle)),
    effSort('date'));
    const shown = found.filter((it) => !it.hidden);
    const hidden = found.filter((it) => it.hidden);

    const grid = el('div', 'tiles');
    for (const item of shown) grid.appendChild(wsTile(item, reload));
    list.appendChild(grid);
    if (!shown.length) {
      const why = needle ? 'Ничего не нашлось' : (state.wsFav ? 'В избранном пока пусто' : 'Все папки убраны в подвал');
      list.appendChild(el('div', 'empty', why));
    }

    if (hidden.length) {
      list.appendChild(el('div', 'group-title', 'Остальные папки'));
      const chips = el('div', 'chips');
      for (const item of hidden) {
        const chip = el('button', 'chip', cap(item.name));
        chip.title = shortPath(item.path);
        chip.onclick = async () => {
          if (state.picking) { await ws('show', item.path); reload(); return; }
          openProjectFolder(item);
        };
        chips.appendChild(chip);
      }
      list.appendChild(chips);
    }
  }
}

/* ---------- схемы: прокрутка, масштаб, просмотр во весь экран ---------- */
const zoomState = { scale: 1, svg: null };

function decorateDiagram(box, code) {
  const svg = box.querySelector('svg');
  if (!svg) return;
  const natural = svg.getBoundingClientRect().width || parseFloat(svg.getAttribute('width')) || 0;
  box.classList.add('diagram');
  if (natural > box.clientWidth + 4) box.classList.add('wide');

  const bar = el('div', 'diagram-bar');
  const openBtn = el('button', null, '⤢ Во весь экран');
  openBtn.onclick = () => openZoom(svg);
  bar.appendChild(openBtn);
  if (box.classList.contains('wide')) bar.appendChild(el('span', 'diagram-hint', 'схема шире колонки — прокрутите вбок или разверните'));
  box.appendChild(bar);
  box.title = 'Двойной клик — во весь экран';
  box.ondblclick = () => openZoom(svg);
}

function applyZoom() {
  const inner = $('#zoom .zoom-inner');
  inner.style.transform = `scale(${zoomState.scale})`;
  $('#zoom .zoom-level').textContent = Math.round(zoomState.scale * 100) + '%';
}

function fitZoom() {
  const stage = $('#zoom .zoom-stage');
  const w = zoomState.svg ? (parseFloat(zoomState.svg.getAttribute('width')) || zoomState.svg.getBoundingClientRect().width) : 0;
  zoomState.scale = w ? Math.min(4, Math.max(0.2, (stage.clientWidth - 48) / w)) : 1;
  applyZoom();
}

function openZoom(svg) {
  const inner = $('#zoom .zoom-inner');
  inner.textContent = '';
  const clone = svg.cloneNode(true);
  clone.removeAttribute('style');
  inner.appendChild(clone);
  zoomState.svg = clone;
  $('#zoom').hidden = false;
  zoomState.scale = 1;
  applyZoom();
  fitZoom();
}

function closeZoom() { $('#zoom').hidden = true; zoomState.svg = null; }

function bindZoom() {
  const zoom = $('#zoom');
  zoom.querySelector('.zoom-bar').onclick = (e) => {
    const act = e.target.dataset.zoom;
    if (!act) return;
    if (act === 'in') zoomState.scale = Math.min(6, zoomState.scale * 1.25);
    else if (act === 'out') zoomState.scale = Math.max(0.15, zoomState.scale / 1.25);
    else if (act === 'reset') zoomState.scale = 1;
    else if (act === 'fit') return fitZoom();
    else if (act === 'close') return closeZoom();
    applyZoom();
  };
  const stage = zoom.querySelector('.zoom-stage');
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;      // обычная прокрутка остаётся прокруткой
    e.preventDefault();
    zoomState.scale = Math.min(6, Math.max(0.15, zoomState.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyZoom();
  }, { passive: false });
  // перетаскивание схемы мышью
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('grabbing');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    stage.scrollLeft = drag.left - (e.clientX - drag.x);
    stage.scrollTop = drag.top - (e.clientY - drag.y);
  });
  const stop = () => { drag = null; stage.classList.remove('grabbing'); };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
}

/* ---------- ширина колонок таблицы ---------- */
// Эвристика перенесена из scripts/fix_docx_tables.py: спрос колонки по объёму текста
// плюс нижняя граница по самому длинному неразрывному слову.
const LONG_CELL_CHARS = 100, ABS_MIN_FRAC = 0.06, MAX_FRAC_MULTICOL = 0.55;

// Ширину меряем настоящим шрифтом ячейки: «Feat-01» и «Трекер» не должны рваться посреди слова.
const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(text, font) {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function fontOf(elem) {
  const cs = getComputedStyle(elem);
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`;
}

// Самый длинный кусок, который браузер не разорвёт. Перенос он делает только после дефисов:
// после «/» и «|» строка не переносится, поэтому «CHK/DMS» считаем неделимым.
const SHORT_CELL_CHARS = 14;   // короткий код («Feat-01», «2.1.3») держим в одну строку
function widestText(text, font) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 0;
  if (clean.length <= SHORT_CELL_CHARS && !clean.includes(' ')) return textWidth(clean, font);
  let best = 0;
  for (const token of clean.split(/\s+/)) {
    if (!token) continue;
    for (const part of token.split(/(?<=[-–—])/)) {
      if (part) best = Math.max(best, textWidth(part, font));
    }
  }
  return best;
}

// Шрифт `кода` задан в пикселях и не уменьшается вместе с таблицей,
// поэтому его требование считаем отдельно от масштабируемого текста.
function cellDemand(cell) {
  const codes = [...cell.querySelectorAll('code, tt')];
  let fixed = 0;
  for (const code of codes) {
    const cs = getComputedStyle(code);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    fixed = Math.max(fixed, widestText(code.textContent, fontOf(code)) + pad);
  }
  let plain = cell;
  if (codes.length) {
    plain = cell.cloneNode(true);
    plain.querySelectorAll('code, tt').forEach((c) => c.remove());
  }
  return { scalable: widestText(plain.textContent, fontOf(cell)), fixed };
}

function columnDemand(texts) {
  if (!texts.length) return 1;
  const lengths = texts.map((t) => t.length);
  const maxLen = Math.max(...lengths);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const longCells = lengths.filter((n) => n > LONG_CELL_CHARS).length;
  const boost = 1 + 0.3 * longCells;
  return Math.max((Math.sqrt(avgLen) * 9 + Math.sqrt(maxLen) * 5) * boost, 1);
}

function layoutTable(table) {
  const rows = [...table.rows];
  if (rows.length < 2) return;
  const ncols = Math.max(...rows.map((r) => r.cells.length));
  if (ncols < 2) return;

  table.style.fontSize = '';   // считаем от базового размера, а не от прошлой подгонки
  const cols = Array.from({ length: ncols }, () => []);
  const textPx = Array.from({ length: ncols }, () => 0);   // масштабируется вместе со шрифтом
  const fixedPxCol = Array.from({ length: ncols }, () => 0);  // `код` — фиксированный размер
  const padPx = 22;                                  // отступы ячейки плюс рамки
  for (const row of rows) {
    for (let i = 0; i < ncols && i < row.cells.length; i++) {
      const cell = row.cells[i];
      cols[i].push(cell.textContent.replace(/\s+/g, ' ').trim());
      const demand = cellDemand(cell);
      textPx[i] = Math.max(textPx[i], demand.scalable);
      fixedPxCol[i] = Math.max(fixedPxCol[i], demand.fixed);
    }
  }

  const avail = table.parentElement.clientWidth || $('#doc').clientWidth || 800;
  const basePt = parseFloat(getComputedStyle(table).fontSize) || 13;

  // Если минимумы не вмещаются, сначала пробуем чуть уменьшить шрифт таблицы
  // (так же поступает scripts/fix_docx_tables.py), и только потом включаем прокрутку.
  const needAt = (k) => textPx.reduce((sum, w, i) => sum + Math.max(w * k, fixedPxCol[i]) + padPx, 0);
  let scale = 1;
  for (const k of [1, 12 / 13, 11 / 13]) {
    if (needAt(k) <= avail) { scale = k; break; }
  }
  if (scale < 1) table.style.fontSize = (basePt * scale).toFixed(1) + 'px';

  // не влезло и на уменьшенном шрифте — таблица шире колонки и прокручивается вбок
  const minsPx = textPx.map((w, i) => Math.max(w * scale, fixedPxCol[i]) + padPx);
  const sumMin = minsPx.reduce((a, b) => a + b, 0);
  const width = Math.max(avail, Math.min(Math.ceil(sumMin) + 2, avail * 4));   // всё равно не влезает — прокрутка

  // Спрос колонки по объёму текста, затем жёсткое соблюдение минимумов.
  const demands = cols.map(columnDemand);
  const demandSum = demands.reduce((a, b) => a + b, 0);
  const cap = ncols <= 2 ? width : width * MAX_FRAC_MULTICOL;
  let w = demands.map((d, i) => {
    const want = Math.min((d / demandSum) * width, Math.max(cap, minsPx[i]));
    return Math.max(want, minsPx[i], width * ABS_MIN_FRAC > minsPx[i] ? minsPx[i] : 0);
  });

  const total = w.reduce((a, b) => a + b, 0);
  if (total > width) {
    // лишнее срезаем только с запаса над минимумом
    const slack = w.map((x, i) => x - minsPx[i]);
    const slackSum = slack.reduce((a, b) => a + b, 0);
    const excess = total - width;
    if (slackSum > 1e-6) w = w.map((x, i) => x - excess * slack[i] / slackSum);
  } else if (total < width) {
    const rest = width - total;
    w = w.map((x, i) => x + rest * demands[i] / demandSum);
  }
  const fracs = w.map((x) => x / w.reduce((a, b) => a + b, 0));

  const old = table.querySelector('colgroup');
  if (old) old.remove();
  const cg = document.createElement('colgroup');
  for (const f of fracs) {
    const col = document.createElement('col');
    col.style.width = (f * 100).toFixed(3) + '%';
    cg.appendChild(col);
  }
  table.insertBefore(cg, table.firstChild);
  table.style.tableLayout = 'fixed';
  table.style.width = width > avail ? width + 'px' : '100%';
}

// Строки таблиц и пункты списков разной высоты, а поле с номерами лежит вне прокручиваемой
// обёртки, поэтому их позиции считаем по факту — после раскладки и при каждом пересчёте.
function placeMeasuredNumbers() {
  $('#doc').querySelectorAll('.lined-block').forEach((block) => {
    const rows = [...block.querySelectorAll('tbody tr[data-line], li[data-line]')];
    let host = block.querySelector('.row-lines');
    if (!rows.length) { if (host) host.remove(); return; }
    if (!host) {
      host = el('div', 'row-lines');
      host.setAttribute('aria-hidden', 'true');   // для чтения вслух номера лишние
      block.appendChild(host);
    }
    host.textContent = '';
    const base = block.getBoundingClientRect().top;
    for (const row of rows) {
      const mark = el('span', null, row.dataset.line);
      const shift = row.tagName === 'TR' ? 7 : 2;   // вровень с первой строкой текста
      mark.style.top = Math.round(row.getBoundingClientRect().top - base) + shift + 'px';
      host.appendChild(mark);
    }
  });
}

function relayoutTables() {
  setTimeout(placeMeasuredNumbers, 0);   // после того, как раскладка и шрифты применятся
  $('#doc').querySelectorAll('table').forEach((table) => {
    try { layoutTable(table); } catch { /* раскладка не критична */ }
  });
}

// Ширина колонки текста меняется (панель, окно) — пересчитываем раскладку таблиц и номера строк.
// Следим именно за областью документа: при сворачивании панели размер окна не меняется.
let relayoutTimer = null, lastDocWidth = 0;
new ResizeObserver(() => {
  const width = $('#doc').clientWidth;
  if (width === lastDocWidth) return;     // изменилась только высота — раскладка та же
  lastDocWidth = width;
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayoutTables, 120);
}).observe($('#doc'));

/* ---------- HTML-страницы: показываем как страницу ---------- */
const pageUrl = (p) => (state.assets || '') + '/raw/' + encodeURIComponent(state.project || 'p') + '/' +
  p.split('/').map(encodeURIComponent).join('/');

function pageBar(p, data, showingSource) {
  const bar = el('div', 'page-bar');
  const openTab = el('button', null, '↗ В новой вкладке');
  openTab.title = 'Открыть страницу отдельно — со всеми правами обычной страницы';
  openTab.onclick = () => window.open(pageUrl(p), '_blank', 'noopener');
  bar.appendChild(openTab);

  const toggle = el('button', null, showingSource ? '▦ Страница' : '⟨⟩ Исходный код');
  toggle.onclick = () => {
    state.showSource = !showingSource;
    openFile(p, { keepScroll: false });
  };
  bar.appendChild(toggle);
  if (data && data.size) bar.appendChild(el('span', 'page-hint', `${Math.round(data.size / 1024)} КБ`));
  return bar;
}

function renderPage(doc, p, data) {
  doc.appendChild(pageBar(p, data, false));

  const frame = document.createElement('iframe');
  frame.className = 'page-frame';
  frame.src = pageUrl(p);
  // страница живёт на отдельном origin (свой порт), поэтому работает полноценно,
  // но данные просмотрщика ей недоступны
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  doc.appendChild(frame);
}

/* ---------- поиск внутри открытого документа ---------- */
const finder = { hits: [], idx: -1, query: '' };

// Снимаем обе наши подсветки: иначе новый поиск не увидит текст внутри старых <mark>
// и покажет «нет совпадений» поверх подсвеченного слова.
function clearMarks() {
  const doc = $('#doc');
  doc.querySelectorAll('mark.find-hit, mark.q-hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  doc.normalize();
}

function clearFind() {
  clearMarks();
  finder.hits = [];
  finder.idx = -1;
  $('#find-count').textContent = '';
}

function runFind(q) {
  clearFind();
  finder.query = q;
  if (!q || q.length < 2) return;
  const needle = q.toLowerCase();
  const doc = $('#doc');
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest('svg')) continue;
    if (node.nodeValue.toLowerCase().includes(needle)) targets.push(node);
  }
  for (const node of targets) {
    const frag = document.createDocumentFragment();
    let rest = node.nodeValue, idx;
    while ((idx = rest.toLowerCase().indexOf(needle)) >= 0) {
      frag.append(rest.slice(0, idx));
      const m = el('mark', 'find-hit', rest.slice(idx, idx + q.length));
      frag.appendChild(m);
      finder.hits.push(m);
      rest = rest.slice(idx + q.length);
    }
    frag.append(rest);
    node.replaceWith(frag);
  }
  if (finder.hits.length) focusHit(0);
  else $('#find-count').textContent = 'нет совпадений';
}

function focusHit(i) {
  if (!finder.hits.length) return;
  const n = finder.hits.length;
  finder.idx = ((i % n) + n) % n;
  finder.hits.forEach((m, k) => m.classList.toggle('active', k === finder.idx));
  finder.hits[finder.idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#find-count').textContent = `${finder.idx + 1} из ${n}`;
}

function openFind() {
  $('#find').hidden = false;
  const input = $('#find-input');
  input.focus();
  input.select();
  if (input.value.trim()) runFind(input.value.trim());
}

function closeFind() {
  $('#find').hidden = true;
  clearFind();
}

function bindFind() {
  const input = $('#find-input');
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => runFind(input.value.trim()), 180);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); focusHit(finder.idx + (e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  };
  $('#find').onclick = (e) => {
    const act = e.target.dataset.find;
    if (act === 'next') focusHit(finder.idx + 1);
    else if (act === 'prev') focusHit(finder.idx - 1);
    else if (act === 'close') closeFind();
  };
}

/* ---------- открытие файла ---------- */
async function navigate(p, anchor) {
  saveScrollNow();   // уходим с этой записи истории — запоминаем, где стояли
  if (!p) { location.hash = ''; renderHome(); return; }
  if (state.fileSet.has(p) && !handledInBrowser(p)) return openIn('default', p);
  const target = '#' + p + (anchor ? '#' + anchor : '');
  if (location.hash === target) return openPath(p, { anchor });  // тот же адрес — hashchange не придёт
  location.hash = target;                                        // иначе рендер запустит hashchange
}

async function openPath(p, opts = {}) {
  if (p !== state.current) state.showSource = false;   // исходник — только для текущего файла
  if (!p) return renderHome(opts);
  if (state.dirSet.has(p)) return openDir(p, opts);
  return openFile(p, opts);
}

function basename(p) { return p.split('/').pop(); }

function fileTile(entry) {
  const tile = el('div', 'ftile');
  tile.setAttribute('role', 'button');
  tile.tabIndex = 0;
  const extLabel = entry.ext ? entry.ext.slice(1) : '';
  const nameNoExt = entry.ext ? entry.name.slice(0, -entry.ext.length) : entry.name;
  if (entry.title) {
    tile.appendChild(el('div', 'ftile-title', cap(entry.title)));
    const second = el('div', 'ftile-name');
    second.appendChild(el('span', 'fname', cap(nameNoExt)));
    if (extLabel) second.appendChild(el('span', 'ext', extLabel));
    tile.appendChild(second);
  } else {
    // названия нет — имя файла становится первой строкой, вторая не выводится
    const first = el('div', 'ftile-title');
    first.appendChild(el('span', 'fname', cap(nameNoExt)));
    if (extLabel) first.appendChild(el('span', 'ext', ' ' + extLabel));
    first.style.display = 'flex';
    first.style.alignItems = 'baseline';
    first.style.gap = '6px';
    first.querySelector('.ext').style.cssText = 'font-family: var(--mono); font-size: 11.5px; font-weight: 400; color: var(--fg-dim)';
    tile.appendChild(first);
  }
  const copy = el('button', 'ftile-copy', '⧉');
  copy.title = 'Копировать полный путь: ' + entry.path;
  copy.onclick = (e) => { e.stopPropagation(); copyPath(entry.path); };
  tile.appendChild(copy);

  tile.onclick = () => navigate(entry.path);
  tile.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(entry.path); } };
  return tile;
}

function folderTile(entry) {
  const tile = el('button', 'tile');
  const top = el('div', 'tile-top');
  top.appendChild(el('span', 'tile-icon', '▣'));
  top.appendChild(el('span', 'tile-title', cap(entry.name)));
  tile.appendChild(top);
  tile.appendChild(el('div', 'tile-meta', `${entry.path}/ · ${docsWord(entry.docs)} · ${filesWord(entry.files)}`));
  tile.onclick = () => navigate(entry.path);
  return tile;
}

async function openDir(p, { scroll = 0 } = {}) {
  state.current = p;
  localStorage.setItem(key('last'), p);
  renderCrumbs(p);
  $('#up-btn').hidden = true;
  $('#fav-btn').hidden = true;      // избранное — про файлы, не про папки
  revealInTree(p);
  const doc = $('#doc');
  doc.textContent = '';
  $('#toc').textContent = '';

  let data;
  try { data = await api('/api/dir?p=' + encodeURIComponent(p)); }
  catch (err) { doc.appendChild(el('div', 'empty', 'Папка недоступна: ' + err.message)); return; }

  const head = el('div', 'dir-head');
  const up = el('button', 'up-btn', data.parent ? '↑ ' + cap(basename(data.parent)) : '↑ Меню разделов');
  up.onclick = () => navigate(data.parent || '');
  head.appendChild(up);
  head.appendChild(el('h1', null, cap(basename(p))));
  const sec = state.sections.find((s) => s.path === p);
  if (sec && sec.description) head.appendChild(el('p', 'home-sub', sec.description));
  doc.appendChild(head);

  const dirs = data.entries.filter((e) => e.dir);
  const files = data.entries.filter((e) => !e.dir);
  const list = el('div');
  head.appendChild(sortRow(paint, { fallback: 'name' }));
  doc.appendChild(list);
  paint();
  restoreScroll(scroll);

  function paint() {
    list.textContent = '';
    if (dirs.length) {
      list.appendChild(el('div', 'group-title', 'Папки'));
      const grid = el('div', 'tiles big');
      for (const d of sortEntries(dirs, effSort('name'))) grid.appendChild(folderTile(d));
      list.appendChild(grid);
    }
    if (files.length) {
      list.appendChild(el('div', 'group-title', 'Документы'));
      const grid = el('div', 'file-tiles');
      for (const f of sortEntries(files, effSort('name'))) grid.appendChild(fileTile(f));
      list.appendChild(grid);
    }
    if (!dirs.length && !files.length) list.appendChild(el('div', 'empty', 'Папка пуста'));
  }
}

/* ---------- переход по абсолютному пути ---------- */
// Корень подбирает сервер: избранные проекты → не убранные в подвал → все остальные,
// из подходящих берётся ближайший по глубине.
const GOTO_HINT = 'Проект подберётся сам: сначала избранные, затем остальные; из нескольких подходящих берётся ближайший';

function openGoto(prefill = '', note = '') {
  $('#goto').hidden = false;
  $('#goto-hint').textContent = note || GOTO_HINT;
  $('#goto-hint').classList.toggle('warn', !!note);
  const input = $('#goto-input');
  input.value = prefill;
  input.focus();
  input.select();
}
const closeGoto = () => { $('#goto').hidden = true; };

const askGoto = (path) => api('/api/goto', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
});

function applyGoto(res) {
  closeGoto();
  if (res.project === state.project) {
    if (!res.path) { navigate(''); return; }
    saveScrollNow();
    navigate(res.path);
    return;
  }
  const hash = res.path ? '#' + res.path : '';
  location.href = `${location.pathname}?project=${encodeURIComponent(res.project)}${hash}`;
}

async function runGoto(raw) {
  const value = (raw || '').trim();
  if (!value) return;
  try { applyGoto(await askGoto(value)); }
  catch (err) { openGoto(value, err.message); }     // «Файл вне проекта» и прочее показываем в окне
}

// Клик по кнопке сначала смотрит в буфер обмена: если там путь к файлу внутри проекта —
// переходим сразу. Ввод предлагаем, только когда взять из буфера нечего.
const looksLikePath = (s) => /^(~\/|\/|file:\/\/)/.test(s);

async function gotoFromClipboard() {
  let text = '';
  try { text = (await navigator.clipboard.readText()) || ''; } catch { /* буфер недоступен — спросим путь */ }
  const first = text.split('\n')[0].trim().replace(/^['"]|['"]$/g, '');
  if (!first || first.length > 400 || !looksLikePath(first)) {
    openGoto(looksLikePath(first) ? first : '');
    return;
  }
  let res;
  try { res = await askGoto(first); }
  catch (err) { openGoto(first, err.message); return; }
  toast('Из буфера: ' + (res.path || basename(res.root)));
  applyGoto(res);
}

/* ---------- порядок списков: по имени или по дате ---------- */
// Один переключатель на все списки: меню разделов, экран папки, выбор проекта.
// В меню есть третий вариант — «Как настроено»: там порядок задан docviewer.json.
// По имени — это имя файла или папки: оно предсказуемо (в именах обычно дата и тема),
// у разделов меню своего имени нет, поэтому там берётся подпись.
const sortLabel = (it) => it.name || it.title || it.label || '';
const sortName = (a, b) => sortLabel(a).localeCompare(sortLabel(b), 'ru');
const sortDate = (a, b) => ((b.mtime || b.at || 0) - (a.mtime || a.at || 0)) || sortName(a, b);
// «Как настроено» есть только в меню разделов; в остальных видах у каждого свой порядок
// по умолчанию: в папке — по имени, в выборе проекта — по дате.
const effSort = (fallback) => (state.sort === 'custom' ? fallback : state.sort);
const sortEntries = (items, key = 'name') => items.slice().sort(key === 'date' ? sortDate : sortName);

// Дата раздела — дата самого свежего файла внутри него.
const folderDate = (p) => state.files.reduce(
  (max, f) => ((f.path === p || f.path.startsWith(p + '/')) && f.mtime > max ? f.mtime : max), 0);
const sortSections = (items) => (state.sort === 'custom' ? items
  : sortEntries(items.map((it) => ({ ...it, mtime: folderDate(it.path) })), state.sort));

function sortRow(onChange, { custom = '', fallback = 'name' } = {}) {
  const row = el('div', 'ws-sort sort-row');
  const options = custom ? [['custom', custom], ['name', 'По имени'], ['date', 'По дате']]
    : [['name', 'По имени'], ['date', 'По дате']];
  const active = custom ? state.sort : effSort(fallback);
  for (const [key, label] of options) {
    const chip = el('button', 'chip' + (active === key ? ' on' : ''), label);
    chip.onclick = () => {
      state.sort = key;
      localStorage.setItem('dv.sort', key);
      [...row.children].forEach((c) => c.classList.toggle('on', c === chip));
      onChange();
    };
    row.appendChild(chip);
  }
  return row;
}

// Адрес возвращаем на прежнее место: файл ушёл в стороннее приложение,
// а страница просмотрщика меняться не должна.
function keepView(prev) {
  const rest = location.pathname + location.search;
  history.replaceState(history.state, '', prev ? rest + '#' + prev : rest);
}

/* ---------- позиция прокрутки в истории ---------- */
// Позицию пишем в саму запись истории, поэтому браузерное «назад» возвращает документ туда,
// откуда ушли по ссылке. У свежей записи состояния нет — такой документ открывается сверху.
let scrollTimer = null, restoring = false;

function rememberScroll() {
  if (restoring) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const scroll = $('#scroller').scrollTop;
    try { history.replaceState({ ...(history.state || {}), scroll }, ''); } catch { /* история недоступна */ }
  }, 250);
}

const savedScroll = () => (history.state && history.state.scroll) || 0;

// Перед сменой адреса пишем позицию без задержки: новая запись истории появится сейчас же.
function saveScrollNow() {
  clearTimeout(scrollTimer);
  if (restoring) return;
  try { history.replaceState({ ...(history.state || {}), scroll: $('#scroller').scrollTop }, ''); } catch { /* история недоступна */ }
}

// Схемы и картинки догружаются и меняют высоту страницы, поэтому позицию ставим несколько раз.
function restoreScroll(top) {
  const scroller = $('#scroller');
  if (!(top > 0)) { scroller.scrollTop = 0; return; }
  restoring = true;
  let tries = 0;
  const apply = () => {
    scroller.scrollTop = top;
    if (++tries < 4) setTimeout(apply, 140);
    else restoring = false;
  };
  apply();   // без requestAnimationFrame: во вкладке на фоне он не сработает
}

async function openFile(p, { anchor = null, keepScroll = false, scroll = 0 } = {}) {
  const doc = $('#doc');
  const scroller = $('#scroller');
  const prevScroll = scroller.scrollTop;
  const prev = state.current;
  const ext = extname(p);

  let data;
  try { data = await api('/api/file?p=' + encodeURIComponent(p)); }
  catch (err) {
    state.current = p;
    renderCrumbs(p);
    doc.textContent = '';
    $('#toc').textContent = '';
    const gone = /ENOENT|no such file/i.test(err.message);
    doc.appendChild(el('div', 'empty', gone ? 'Файл удалён или переименован: ' + p : 'Не удалось открыть: ' + err.message));
    return;
  }

  // показать такой файл интерфейс не может — отдаём системе и оставляем страницу как была
  if (data.binary && !IMG_EXT.has(ext) && ext !== '.pdf') {
    keepView(prev);
    return openIn('default', p);
  }

  state.current = p;
  localStorage.setItem(key('last'), p);
  renderCrumbs(p);
  revealInTree(p);   // дерево следует за навигацией через меню

  doc.textContent = '';

  if (PAGE_EXT.has(ext) && !state.showSource) {
    renderPage(doc, p, data);
    $('#toc').textContent = '';
    return;
  }

  if (data.binary) {
    if (IMG_EXT.has(ext)) {
      const img = el('img'); img.src = '/raw?p=' + encodeURIComponent(p); doc.appendChild(img);
    } else {
      const emb = document.createElement('embed');
      emb.src = withProject('/raw?p=' + encodeURIComponent(p)); emb.type = 'application/pdf';
      emb.style.cssText = 'width:100%;height:80vh;border:1px solid var(--line);border-radius:8px';
      doc.appendChild(emb);
    }
    $('#toc').textContent = '';
  } else if (ext === '.md' || ext === '.mdc') {
    const { meta, body, offset } = splitFrontmatter(data.content);
    if (meta && meta.length) doc.appendChild(renderFrontmatter(meta));
    const holder = renderMarkdown(body, offset + 1);
    doc.appendChild(holder);
    await enhance(doc, p);
  } else {
    if (PAGE_EXT.has(ext)) doc.appendChild(pageBar(p, data, true));
    const pre = el('pre');
    const code = el('code', 'language-' + ext.slice(1), data.content);
    pre.appendChild(code); doc.appendChild(pre);
    try { hljs.highlightElement(code); } catch { /* язык не распознан */ }
    addLineNumbers(pre, { always: true });   // файл целиком — номера нужны всегда
    $('#toc').textContent = '';
  }

  if (keepScroll) scroller.scrollTop = prevScroll;
  else if (scroll > 0) restoreScroll(scroll);   // вернулись кнопкой «назад»
  else if (anchor) {
    const t = [...doc.querySelectorAll('h1,h2,h3')].find((h) => h.id === anchor || slugify(h.textContent) === anchor.toLowerCase());
    if (t) t.scrollIntoView({ block: 'start' }); else scroller.scrollTop = 0;
  } else scroller.scrollTop = 0;

  if (state.lastQuery && state.tab === 'search') {
    try { highlightQuery(state.lastQuery); } catch { /* подсветка не критична */ }
  }
  if (!$('#find').hidden && $('#find-input').value.trim()) runFind($('#find-input').value.trim());
}

function highlightQuery(q) {
  clearMarks();
  // Фраза в markdown часто разорвана разметкой, поэтому подсвечиваем по словам запроса.
  const words = q.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 3);
  if (!words.length) return;
  const rx = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  const doc = $('#doc');
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest('svg')) continue;
    rx.lastIndex = 0;
    if (rx.test(node.nodeValue)) targets.push(node);
  }
  let first = null;
  for (const node of targets.slice(0, 400)) {
    const frag = document.createDocumentFragment();
    let last = 0;
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(node.nodeValue))) {
      frag.append(node.nodeValue.slice(last, m.index));
      const mark = el('mark', 'q-hit', m[0]);
      frag.appendChild(mark);
      if (!first) first = mark;
      last = m.index + m[0].length;
    }
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
  if (first) first.scrollIntoView({ block: 'center' });
}

function renderCrumbs(p) {
  document.body.classList.remove('picking');
  const c = $('#crumbs');
  c.textContent = '';
  const segs = p.split('/');
  segs.forEach((s, i) => {
    if (i) c.append(' / ');
    if (i === segs.length - 1) c.appendChild(el('b', null, s)); else c.append(s);
  });
  document.title = segs[segs.length - 1] + ' — документация';
  document.querySelectorAll('.actions button').forEach((b) => { b.disabled = false; });
  $('#up-btn').hidden = false;
  $('#up-btn').textContent = segs.length > 1 ? '↑ ' + cap(segs[segs.length - 2]) : '↑ Меню разделов';
  syncFavButton();
}

/* ---------- открытие в приложениях ---------- */
// Значок берём у самого приложения; если его нет в системе, на кнопке остаётся подпись.
function loadAppIcons() {
  document.querySelectorAll('.actions button[data-open]').forEach((btn) => {
    const img = new Image();
    img.src = '/api/appicon?app=' + encodeURIComponent(btn.dataset.open);
    img.alt = '';
    img.onload = () => { btn.textContent = ''; btn.appendChild(img); };
  });
}

// В буфер кладём полный путь от корня диска: его можно вставить в терминал или в диалог открытия.
const fullPath = (p) => (state.root ? state.root.replace(/\/$/, '') + '/' + p : p);

async function copyPath(rel) {
  if (!rel) return;
  const p = fullPath(rel);
  try {
    await navigator.clipboard.writeText(p);
    toast('Путь скопирован: ' + p);
    return;
  } catch { /* буфер недоступен — пробуем запасной путь */ }
  try {
    const ta = el('textarea');
    ta.value = p;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? 'Путь скопирован: ' + p : 'Скопировать не вышло');
  } catch { toast('Скопировать не вышло'); }
}

async function openIn(app, target = state.current) {
  target = target || '';   // пусто — значит корень проекта: так работают кнопки в меню разделов
  try {
    await api('/api/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, app, project: PROJECT || undefined }),
    });
    if (app === 'reveal') toast('Показано в Finder');
    else if (app === 'claude' || app === 'codex') {
      const chat = app === 'claude' ? 'Новый чат Claude Code' : 'Новый чат Codex';
      const dir = state.dirSet.has(target) ? target : dirname(target);
      toast(dir ? chat + ': ' + dir : chat + ' в корне проекта');
    }
    else toast(target ? 'Открыто: ' + target.split('/').pop() : 'Открыт проект целиком');
  } catch (err) { toast('Не получилось: ' + err.message); }
}

// Что веб-интерфейс показать не может — сразу отдаём системе (docx, xlsx, архивы и прочее).
function handledInBrowser(p) {
  const ext = extname(p);
  return !ext || TEXT_EXT.has(ext) || IMG_EXT.has(ext) || ext === '.pdf';
}

/* ---------- поиск ---------- */
async function runSearch(q) {
  const host = $('#results');
  state.lastQuery = q;
  host.textContent = '';
  if (q.trim().length < 2) return;
  host.appendChild(el('div', 'empty', 'Ищу…'));
  const data = await api('/api/search?q=' + encodeURIComponent(q));
  host.textContent = '';
  if (!data.hits.length) { host.appendChild(el('div', 'empty', 'Ничего не найдено')); return; }
  $('#counter').textContent = `${data.hits.length} ${plural(data.hits.length, ['совпадение', 'совпадения', 'совпадений'])}`;
  for (const hit of data.hits) {
    const box = el('div', 'hit');
    box.appendChild(el('div', 'hit-name', hit.name));
    const pathLine = el('div', 'hit-path', hit.path);
    if (/(^|\/)(Archive|_archive)(\/|$)/.test(hit.path)) pathLine.append(' · архив');
    box.appendChild(pathLine);
    for (const m of hit.matches) box.appendChild(el('div', 'hit-line', m.line + ': ' + m.text));
    box.onclick = () => navigate(hit.path);
    host.appendChild(box);
  }
}

/* ---------- палитра ---------- */
const palette = { items: [], sel: 0 };
function openPalette() {
  $('#palette').hidden = false;
  const input = $('#palette-input');
  input.value = ''; input.focus();
  updatePalette('');
}
function closePalette() { $('#palette').hidden = true; }
function updatePalette(q) {
  const needle = q.toLowerCase().trim();
  palette.items = state.files
    .filter((f) => !needle || f.path.toLowerCase().includes(needle))
    .slice(0, 60);
  palette.sel = 0;
  const list = $('#palette-list');
  list.textContent = '';
  palette.items.forEach((f, i) => {
    const li = el('li');
    li.appendChild(el('span', null, f.name));
    li.appendChild(el('span', 'p-dir', dirname(f.path)));
    if (i === palette.sel) li.classList.add('sel');
    li.onclick = () => { closePalette(); navigate(f.path); };
    list.appendChild(li);
  });
}
function movePalette(delta) {
  const list = $('#palette-list');
  if (!palette.items.length) return;
  palette.sel = (palette.sel + delta + palette.items.length) % palette.items.length;
  [...list.children].forEach((li, i) => li.classList.toggle('sel', i === palette.sel));
  list.children[palette.sel].scrollIntoView({ block: 'nearest' });
}

/* ---------- боковая панель: ширина и сворачивание ---------- */
const SIDE_MIN = 200, SIDE_MAX = 640, SIDE_DEFAULT = 320;

function applySideWidth(px) {
  const limit = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(window.innerWidth * 0.5)));
  const w = Math.min(limit, Math.max(SIDE_MIN, Math.round(px)));
  $('#app').style.setProperty('--side-w', w + 'px');
  localStorage.setItem('dv.sidew', String(w));
}

function setSideHidden(hidden) {
  document.body.classList.toggle('side-hidden', hidden);
  localStorage.setItem('dv.sidehidden', hidden ? '1' : '0');
}

function bindSidebarControls() {
  applySideWidth(Number(localStorage.getItem('dv.sidew')) || SIDE_DEFAULT);
  setSideHidden(localStorage.getItem('dv.sidehidden') === '1');

  $('#hide-side').onclick = () => setSideHidden(true);
  $('#show-side').onclick = () => setSideHidden(false);

  const rz = $('#resizer');
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('dragging');
    document.body.style.userSelect = 'none';
    const move = (ev) => applySideWidth(ev.clientX);
    const stop = () => {
      rz.classList.remove('dragging');
      document.body.style.userSelect = '';
      rz.removeEventListener('pointermove', move);
      rz.removeEventListener('pointerup', stop);
    };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', stop);
  });
  rz.addEventListener('dblclick', () => applySideWidth(SIDE_DEFAULT));
  window.addEventListener('resize', () => applySideWidth(Number(localStorage.getItem('dv.sidew')) || SIDE_DEFAULT));
}

/* ---------- живое обновление ---------- */
function connectEvents() {
  const dot = $('#status');
  const es = new EventSource('/api/events');
  es.onopen = () => { dot.className = 'dot live'; dot.title = 'Слежу за изменениями'; };
  es.onerror = () => { dot.className = 'dot off'; dot.title = 'Нет связи с сервером'; };
  es.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'projects') { await refreshProjects(); return; }
    if (msg.type !== 'change') return;
    if (msg.project && PROJECT && msg.project !== PROJECT) return;
    if (msg.paths.some((p) => p === 'docviewer.json')) await loadConfig();
    await loadTree();
    if (!state.current) { renderHome(); return; }
    if (state.dirSet.has(state.current)) {
      // открыта папка — перерисовываем её список, если изменилось что-то внутри
      if (msg.paths.some((p) => p === state.current || dirname(p) === state.current)) await openDir(state.current);
      return;
    }
    if (msg.paths.some((p) => p === state.current)) {
      await openFile(state.current, { keepScroll: true });
      toast('Обновлено: ' + state.current.split('/').pop());
    }
  };
}

/* ---------- переключатель проектов ---------- */
function renderProjectSwitch(meta) {
  const host = $('#projects');
  host.textContent = '';
  // в списке — только избранные проекты; остальные открываются через экран выбора
  const shown = state.projects.filter((pr) => pr.fav !== false || pr.id === meta.project);
  if (shown.length < 2) { host.hidden = shown.length < 1; }
  host.hidden = false;
  const select = document.createElement('select');
  select.id = 'project-select';
  select.title = 'Проект: ' + meta.root;
  for (const pr of shown) {
    const opt = document.createElement('option');
    opt.value = pr.id;
    opt.textContent = pr.name;
    if (pr.id === meta.project) opt.selected = true;
    select.appendChild(opt);
  }
  select.onchange = () => {
    // у каждого проекта своё состояние — открываем его с чистого адреса
    location.href = `${location.pathname}?project=${encodeURIComponent(select.value)}`;
  };
  host.appendChild(select);
}

/* ---------- инициализация ---------- */
function bindUI() {
  document.querySelectorAll('.side-tabs .tab').forEach((tab) => {
    tab.onclick = () => {
      state.tab = tab.dataset.tab;
      document.querySelectorAll('.side-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      const isTree = state.tab === 'tree';
      $('#tree').hidden = !isTree; $('#results').hidden = isTree;
      $('#filter').hidden = !isTree; $('#query').hidden = isTree;
      (isTree ? $('#filter') : $('#query')).focus();
      if (isTree) $('#counter').textContent = `${state.files.length} файлов`;
    };
  });

  $('#goto-btn').onclick = gotoFromClipboard;
  $('#goto-input').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runGoto(e.target.value); }
    if (e.key === 'Escape') { e.preventDefault(); closeGoto(); }
  };
  $('#goto').onclick = (e) => { if (e.target.id === 'goto') closeGoto(); };

  $('#pick-btn').onclick = () => {
    // Повторный клик закрывает экран выбора. Если мы сами на него ушли, возвращаемся
    // кнопкой истории: так документ откроется на прежнем месте. Если экран открыли
    // ссылкой или он остался после перезагрузки, возвращаться в истории некуда —
    // открываем то, что было до него (в этом случае — корень проекта).
    if (location.hash === '#' + PICKER) {
      if (state.pickerBack) history.back();
      else navigate(state.pickerFrom || '');
      return;
    }
    saveScrollNow();
    state.pickerFrom = state.current || '';
    state.pickerBack = true;
    location.hash = PICKER;
  };
  $('#home-btn').onclick = () => navigate('');
  $('#up-btn').onclick = () => {
    if (!state.current) return;
    navigate(dirname(state.current));
  };
  bindSidebarControls();
  bindZoom();
  bindFind();

  $('#filter').oninput = (e) => { state.filter = e.target.value; renderTree(); };
  $('#query').onkeydown = (e) => { if (e.key === 'Enter') runSearch(e.target.value); };

  document.querySelectorAll('.actions button[data-open]').forEach((b) => { b.onclick = () => openIn(b.dataset.open); });
  loadAppIcons();
  $('#copy-path').onclick = () => copyPath(state.current);
  $('#fav-btn').onclick = () => { if (state.current) toggleFavorite(state.current); };

  $('#palette-input').oninput = (e) => updatePalette(e.target.value);
  $('#palette').onclick = (e) => { if (e.target.id === 'palette') closePalette(); };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#goto').hidden) { e.preventDefault(); closeGoto(); return; }
    if (e.key === 'Escape' && !$('#zoom').hidden) { e.preventDefault(); closeZoom(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && state.current) { e.preventDefault(); openFind(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'g' && !$('#find').hidden) {
      e.preventDefault(); focusHit(finder.idx + (e.shiftKey ? -1 : 1)); return;
    }
    if (e.key === 'Escape' && !$('#find').hidden) { e.preventDefault(); closeFind(); return; }
    const palOpen = !$('#palette').hidden;
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      setSideHidden(!document.body.classList.contains('side-hidden'));
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'k')) { e.preventDefault(); palOpen ? closePalette() : openPalette(); return; }
    if (!palOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const item = palette.items[palette.sel];
      if (item) { closePalette(); navigate(item.path); }
    }
  });

  // подсветка активного пункта оглавления
  $('#scroller').addEventListener('scroll', () => {
    rememberScroll();
    const hs = [...$('#doc').querySelectorAll('h2, h3')];
    const top = $('#scroller').getBoundingClientRect().top + 90;
    let active = null;
    for (const h of hs) { if (h.getBoundingClientRect().top <= top) active = h; }
    document.querySelectorAll('#toc a').forEach((a) => a.classList.toggle('active', !!active && a.getAttribute('href') === '#' + active.id));
  }, { passive: true });

  window.addEventListener('hashchange', () => {
    const [p, anchor] = decodeURIComponent(location.hash.slice(1)).split('#');
    const scroll = savedScroll();   // есть только у записи, с которой мы уже уходили
    if (p === PICKER) renderPicker({ refresh: true });
    else {
      state.pickerBack = false;   // с экрана выбора ушли — возвращаться в истории уже некуда
      if (p) openPath(p, { anchor, scroll });
      else renderHome({ scroll });
    }
  });

  dark.addEventListener('change', () => { mermaidReady = false; if (state.current) openFile(state.current, { keepScroll: true }); });
}

async function boot() {
  bindUI();
  const meta = await api('/api/meta');
  state.projects = meta.projects || [];
  state.project = meta.project;
  state.assets = meta.assets || '';
  state.root = meta.root || '';
  state.home = meta.home || '';
  state.meta = meta;
  $('#repo-name').textContent = meta.name;
  $('#repo-name').title = meta.root;
  $('#repo-name').onclick = () => navigate('');
  renderProjectSwitch(meta);
  await loadConfig();
  await loadTree();
  connectEvents();

  const fromHash = decodeURIComponent(location.hash.slice(1)).split('#');
  if (fromHash[0] === PICKER) { renderPicker({ refresh: true }); return; }
  const start = fromHash[0] && (state.fileSet.has(fromHash[0]) || state.dirSet.has(fromHash[0])) && fromHash[0];
  if (start) { await openPath(start, { anchor: fromHash[1] }); revealInTree(start); }
  else renderHome();
}

boot().catch((err) => { $('#doc').appendChild(el('div', 'empty', 'Ошибка запуска: ' + err.message)); });
})();
