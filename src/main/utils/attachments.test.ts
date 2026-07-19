import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-attachments-'));
if (process.platform !== 'win32') chmodSync(dataDir, 0o755);
process.env.HIVE_DATA_DIR = dataDir;

const { ensureDirs, paths } = await import('./paths.js');
const { cleanupAttachmentFiles, deleteStoredAttachments, hydrateAttachmentRefs, storeAttachment } = await import('./attachments.js');

try {
  ensureDirs();
  const id = await storeAttachment(Buffer.from('hello'));
  assert.equal(existsSync(join(paths.attachments, id)), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(dataDir).mode & 0o777, 0o755, 'an existing explicit data root keeps its caller-selected mode');
    assert.equal(statSync(paths.attachments).mode & 0o777, 0o700, 'Hive-owned data subdirectories are private');
    assert.equal(statSync(paths.cli).mode & 0o777, 0o700, 'CLI history/export directory is private');
    assert.equal(statSync(paths.simulator).mode & 0o777, 0o700, 'simulator metadata directory is private');
    assert.equal(statSync(paths.simulatorData).mode & 0o777, 0o700, 'simulator chain data directory is private');
    assert.equal(statSync(join(paths.attachments, id)).mode & 0o777, 0o600, 'stored attachments are private');
  }
  assert.equal(readdirSync(paths.attachments).some((name) => name.endsWith('.tmp')), false, 'atomic writes leave no temporary file');

  const [hydrated] = await hydrateAttachmentRefs([{
    id: 'message',
    role: 'user',
    createdAt: Date.now(),
    content: [{
      type: 'attachment_ref',
      attachment: { id, type: 'file', filename: 'hello.txt', mimeType: 'text/plain', size: 5 }
    }]
  }]);
  assert.equal(Array.isArray(hydrated.content) && hydrated.content[0]?.type === 'file'
    ? Buffer.from(hydrated.content[0].file.data, 'base64').toString('utf8')
    : '', 'hello');

  await assert.rejects(storeAttachment(Buffer.alloc(20 * 1024 * 1024 + 1)), /size limit/u);
  const staleTemporary = `.${id}.${process.pid}.tmp`;
  const stalePath = join(paths.attachments, staleTemporary);
  writeFileSync(stalePath, 'partial');
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
  utimesSync(stalePath, twoDaysAgo, twoDaysAgo);
  const recentTemporary = `.${id}.${process.pid + 1}.tmp`;
  writeFileSync(join(paths.attachments, recentTemporary), 'active');
  const unreferencedId = '00000000-0000-4000-8000-000000000000';
  writeFileSync(join(paths.attachments, unreferencedId), 'pending in another process');
  await cleanupAttachmentFiles();
  assert.equal(existsSync(join(paths.attachments, id)), true, 'stored attachment is retained');
  assert.equal(existsSync(join(paths.attachments, unreferencedId)), true, 'another process\'s pending attachment is retained');
  assert.equal(existsSync(join(paths.attachments, staleTemporary)), false, 'stale partial attachment is removed');
  assert.equal(existsSync(join(paths.attachments, recentTemporary)), true, 'recent partial attachment is retained');

  await assert.doesNotReject(deleteStoredAttachments(['11111111-1111-4111-8111-111111111111']), 'an already-missing attachment is harmless');
  const undeletableId = '22222222-2222-4222-8222-222222222222';
  mkdirSync(join(paths.attachments, undeletableId));
  await assert.rejects(deleteStoredAttachments([undeletableId]), 'non-ENOENT deletion failures must be reported');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('attachment lifecycle tests passed');
