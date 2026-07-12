import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentPart, Message } from '@shared/types';
import { paths } from './paths';

const SAFE_ID = /^[0-9a-f-]{36}$/i;

function filePath(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('Invalid attachment id');
  return join(paths.attachments, id);
}

export async function storeAttachment(data: Buffer): Promise<string> {
  const id = randomUUID();
  await writeFile(filePath(id), data, { flag: 'wx' });
  return id;
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
    const content = await Promise.all(message.content.map(async (part): Promise<ContentPart> => {
      if (part.type !== 'attachment_ref') return part;
      try {
        const data = (await readFile(filePath(part.attachment.id))).toString('base64');
        return hydratedPart(part, data);
      } catch {
        return { type: 'text', text: `[Attachment unavailable: ${part.attachment.filename}]` };
      }
    }));
    return { ...message, content };
  }));
}

export async function deleteStoredAttachments(ids: Iterable<string>): Promise<void> {
  await Promise.allSettled(Array.from(new Set(ids)).filter((id) => SAFE_ID.test(id)).map((id) => unlink(filePath(id))));
}

export async function cleanupAttachmentFiles(referencedIds: Set<string>): Promise<void> {
  let names: string[];
  try { names = await readdir(paths.attachments); } catch { return; }
  await deleteStoredAttachments(names.filter((name) => SAFE_ID.test(name) && !referencedIds.has(name)));
}
