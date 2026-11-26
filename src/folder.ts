// Folders: where a page or an app is filed on the website ("财务/上账"). Display only: who may open or run it
// still follows its chat, so moving it changes nothing else.
import { AmberError } from './engine.ts';

export const MAX_FOLDER_DEPTH = 3;
const MAX_SEGMENT = 20;

/** "财务 / 上账/" → "财务/上账"; '' clears. Up to 3 levels of up to 20 characters, no control characters. */
export function normFolder(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new AmberError('bad_folder', '目录要写成文字，比如「财务/上账」');
  const parts = raw.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.length > MAX_FOLDER_DEPTH) throw new AmberError('bad_folder', `目录最多 ${MAX_FOLDER_DEPTH} 层`);
  for (const s of parts) {
    if (s.length > MAX_SEGMENT) throw new AmberError('bad_folder', `目录每一层最多 ${MAX_SEGMENT} 个字：「${s.slice(0, 30)}」`);
    if (/[\u0000-\u001f\u007f\\]/.test(s)) throw new AmberError('bad_folder', '目录名里不能有控制字符或反斜杠');
  }
  return parts.join('/');
}

/** The folder key of a page or an app in its chat. An app's versions share its line, so they share the folder. */
export const pageFolderKey = (id: string) => `page:${id}`;
export const appFolderKey = (c: { line?: string | null; name: string }) => `line:${c.line || c.name}`;
