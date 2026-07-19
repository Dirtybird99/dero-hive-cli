import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentPart, Message } from '@shared/types';
import { paths } from './paths';

const SAFE_ID = /^[0-9a-f-]{36}$/i;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;

function filePath(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('Invalid attachment id');
  return join(paths.attachments, id);
}

export async function storeAttachment(data: Buffer): Promise<string> {
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds the per-file size limit');
  const id = randomUUID();
  const finalPath = filePath(id);
  const temporaryPath = join(paths.attachments, `.${id}.${process.pid}.tmp`);
  try {
    await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, finalPath);
    return id;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function attachmentIds(content: string | ContentPart[]): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => part.type === 'attachment_ref' ? [part.attachment.id] : []);
}

export function serializedAttachmentIds(content: string): string[] {
  try { return attachmentIds(JSON.parse(content) as ContentPart[]); } catch { return []; }
}

export async function validateAttachmentRefs(content: string | ContentPart[], maxFileBytes: number, maxTotalBytes: number): Promise<void> {
  const ids = attachmentIds(content);
  let total = 0;
  for (const id of ids) {
    const size = (await stat(filePath(id))).size;
    if (size > maxFileBytes) throw new Error('Attachment exceeds the per-file size limit');
    total += size;
    if (total > maxTotalBytes) throw new Error('Attachments exceed the per-message size limit');
  }
}

function hydratedPart(part: ContentPart, data: string): ContentPart {
  if (part.type !== 'attachment_ref') return part;
  const a = part.attachment;
  if (a.type === 'image') return { type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${data}` } };
  if (a.type === 'audio' && (a.mimeType === 'audio/wav' || a.mimeType === 'audio/mpeg')) {
    return { type: 'input_audio', input_audio: { data, format: a.mimeType === 'audio/wav' ? 'wav' : 'mp3' } };
  }
  return { type: 'file', file: { filename: a.filename, data, mimeType: a.mimeType } };
}

export async function hydrateAttachmentRefs(messages: Message[]): Promise<Message[]> {
  return Promise.all(messages.map(async (message) => {
    if (!Array.isArray(message.content) || !message.content.some((part) => part.type === 'attachment_ref')) return message;
    let total = 0;
    const content: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== 'attachment_ref') {
        content.push(part);
        continue;
      }
      try {
        const path = filePath(part.attachment.id);
        const size = (await stat(path)).size;
        if (size > MAX_ATTACHMENT_BYTES || total + size > MAX_MESSAGE_ATTACHMENT_BYTES) {
          content.push({ type: 'text', text: `[Attachment omitted: ${part.attachment.filename} exceeds the size limit]` });
          continue;
        }
        total += size;
        const data = (await readFile(path)).toString('base64');
        content.push(hydratedPart(part, data));
      } catch {
        content.push({ type: 'text', text: `[Attachment unavailable: ${part.attachment.filename}]` });
      }
    }
    return { ...message, content };
  }));
}

export async function deleteStoredAttachments(ids: Iterable<string>): Promise<void> {
  await Promise.all(Array.from(new Set(ids)).filter((id) => SAFE_ID.test(id)).map(async (id) => {
    try { await unlink(filePath(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }));
}

export async function cleanupAttachmentFiles(now = Date.now()): Promise<void> {
  let names: string[];
  try { names = await readdir(paths.attachments); } catch { return; }
  await Promise.allSettled(names.map(async (name) => {
    if (!/^\.[0-9a-f-]{36}\.\d+\.tmp$/iu.test(name)) return;
    const path = join(paths.attachments, name);
    const info = await stat(path);
    if (now - info.mtimeMs >= STALE_TEMP_AGE_MS) await unlink(path);
  }));
}
