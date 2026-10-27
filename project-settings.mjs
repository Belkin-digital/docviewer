// Настройки принадлежат проекту: UI и MCP читают один docviewer.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DESCRIPTION_LIMIT = 2000;
export const DEFAULT_TITLE = 'Навигация по документации';

export function validateTitle(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('title должен быть непустой строкой');
  if (value.length > 200) throw new Error('Заголовок должен быть не длиннее 200 символов');
  return value.trim();
}

export function normalizeSettings(settings) {
  const { subtitle, ...canonical } = settings;
  // Явно очищенное description остаётся пустым; старый subtitle читаем только как запасной источник.
  if (!Object.hasOwn(canonical, 'description') && typeof subtitle === 'string') canonical.description = subtitle;
  return canonical;
}

export function validateDescription(value) {
  if (typeof value !== 'string') throw new Error('description должен быть строкой');
  if (value.length > DESCRIPTION_LIMIT) throw new Error(`Описание должно быть не длиннее ${DESCRIPTION_LIMIT} символов`);
  return value.trim();
}

export async function readSettings(root) {
  let text;
  try { text = await fs.readFile(path.join(root, 'docviewer.json'), 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('docviewer.json должен содержать объект');
  }
  return normalizeSettings(settings);
}

export async function readProjectInfo(root) {
  // Один повреждённый/недоступный конфиг не ломает каталог остальных проектов.
  try {
    const settings = await readSettings(root);
    return {
      title: typeof settings?.title === 'string' && settings.title.trim() ? settings.title : DEFAULT_TITLE,
      description: typeof settings?.description === 'string' ? settings.description : '',
    };
  } catch { return { title: DEFAULT_TITLE, description: '' }; }
}

export async function writeSettings(root, settings) {
  const file = path.join(root, 'docviewer.json');
  const temporary = path.join(root, `.docviewer-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(normalizeSettings(settings), null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// Все операции чтение-изменение-запись одного проекта проходят через одну очередь.
const queues = new Map();
export function serializeSettings(root, fn) {
  const key = path.resolve(root).normalize('NFC');
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  queues.set(key, run);
  const clean = () => { if (queues.get(key) === run) queues.delete(key); };
  run.then(clean, clean);
  return run;
}
