import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaJobStatusEvent, MediaProviderConfig } from '../../shared/types.js';

// MediaManager tests: provider CRUD + secrets, generation lifecycle (queued →
// succeeded/failed events, artifact rows, files on disk), cancellation
// bookkeeping, artifact deletion, legacy path repair, and cleanup semantics.
// Everything runs against a disposable HIVE_DATA_DIR and a local HTTP fake
// speaking the A1111 txt2img shape (no key needed, base URL honored).

const dataDir = mkdtempSync(join(tmpdir(), 'dero-hive-media-manager-'));
process.env.HIVE_DATA_DIR = dataDir;

const payload = Buffer.from('artifact-bytes');
const payloadB64 = payload.toString('base64');

// When set, the /slow route holds its response until the gate resolves.
let gate: Promise<void> | null = null;

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const path = url.pathname;
  const finish = (status: number, body: string): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(body);
  };
  if (path === '/slow/sd-api/v1/txt2img') {
    void (gate ?? Promise.resolve()).then(() => finish(200, JSON.stringify({ images: [payloadB64], info: '{}' })));
    return;
  }
  if (path === '/fail/sd-api/v1/txt2img') return finish(500, 'boom');
  if (path === '/big/sd-api/v1/txt2img') {
    // One byte over the 50 MB artifact cap.
    return finish(200, JSON.stringify({ images: [Buffer.alloc(50 * 1024 * 1024 + 1).toString('base64')], info: '{}' }));
  }
  if (path.endsWith('/sd-api/v1/options')) return finish(200, '{}');
  if (path.endsWith('/sd-api/v1/txt2img')) return finish(200, JSON.stringify({ images: [payloadB64], info: '{"seed":11}' }));
  if (path.endsWith('/images/generations')) return finish(200, JSON.stringify({ data: [{ b64_json: payloadB64 }] }));
  finish(404, `no stub for ${path}`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

const { initDb, closeDb, getDb } = await import('../db/client.js');
await initDb();
const { MediaManager } = await import('./manager.js');
const { getSecret } = await import('../utils/secrets.js');

try {
  const events: MediaJobStatusEvent[] = [];
  const manager = new MediaManager((evt) => events.push(evt));
  const month = new Date().toISOString().slice(0, 7);

  // ── Nothing configured yet ────────────────────────────────────────────────
  await assert.rejects(manager.generate({ prompt: 'p' }), /No media provider configured/);
  assert.deepEqual(await manager.testProvider('missing'), { ok: false, error: 'Provider not configured' });
  assert.equal(manager.cancel('unknown-job'), false);
  assert.equal(manager.artifactFileById('unknown-artifact'), null);
  assert.equal(manager.autoPick('image'), null);

  // ── Provider CRUD and secret handling ─────────────────────────────────────
  const a1111Input: MediaProviderConfig = {
    id: '', presetId: 'a1111', name: 'Local A1111', baseUrl: base,
    hasApiKey: false, enabled: true, defaultImageModel: 'sd15', updatedAt: 0
  };
  const saved = manager.saveProvider(a1111Input);
  assert.match(saved.id, /^media-[0-9a-f]{8}$/, 'blank id must be auto-assigned');
  assert.equal(saved.hasApiKey, false);

  const keyed = manager.saveProvider({
    id: 'media-keyed', presetId: 'stability', name: 'Keyed', baseUrl: '',
    hasApiKey: false, enabled: false, updatedAt: 0, apiKey: 'sk-test'
  });
  assert.equal(keyed.hasApiKey, true);
  assert.equal(getSecret('media:media-keyed'), 'sk-test');
  // Re-saving without an apiKey must preserve the stored secret (COALESCE path).
  const resaved = manager.saveProvider({
    id: 'media-keyed', presetId: 'stability', name: 'Keyed', baseUrl: '',
    hasApiKey: true, enabled: false, updatedAt: 0
  });
  assert.equal(resaved.hasApiKey, true);
  assert.equal(getSecret('media:media-keyed'), 'sk-test');

  const listed = manager.listProviders();
  assert.equal(listed.length, 2);
  const a1111Row = listed.find((p) => p.id === saved.id);
  assert.ok(a1111Row);
  assert.equal(a1111Row.baseUrl, base);
  assert.equal(a1111Row.defaultImageModel, 'sd15');
  assert.equal(a1111Row.enabled, true);
  assert.deepEqual(a1111Row.customHeaders, {});

  assert.deepEqual(await manager.testProvider(saved.id), { ok: true });

  // autoPick prefers the enabled media provider that supports the kind; video
  // has no configured path here.
  assert.deepEqual(manager.autoPick('image'), { providerId: saved.id, model: 'sd15' });
  assert.equal(manager.autoPick('video'), null);

  // ── Generation happy path: events, DB row, file on disk ───────────────────
  const throwingOff = manager.onEvent(() => { throw new Error('listener boom'); }); // must not break emit
  const extraEvents: MediaJobStatusEvent[] = [];
  const extraOff = manager.onEvent((evt) => extraEvents.push(evt));

  const rec = await manager.generate({ prompt: 'a cat', seed: 3 }, { conversationId: 'c1', messageId: 'm1' });
  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.kind, 'image');
  assert.equal(rec.providerId, saved.id);
  assert.equal(rec.model, 'sd15', 'provider default image model must be applied');
  assert.equal(rec.mimeType, 'image/png');
  assert.equal(rec.bytes, payload.length);
  assert.equal(rec.seed, 11, 'seed reported by the provider must replace the requested seed');
  assert.equal(rec.conversationId, 'c1');
  assert.match(rec.relativePath, new RegExp(`^${month}/image-.*\\.png$`));
  const absPath = join(dataDir, 'media', rec.relativePath);
  assert.deepEqual(readFileSync(absPath), payload);

  assert.equal(events.length, 2);
  assert.equal(events[0].job.status, 'queued');
  assert.equal(events[0].job.relativePath, `${month}/${rec.id}.bin`, 'queued event carries the placeholder filename');
  assert.equal(events[1].job.status, 'succeeded');
  assert.equal(events[1].job.id, rec.id);
  assert.equal(extraEvents.length, 2, 'every registered listener must receive events');

  const file = manager.artifactFileById(rec.id);
  assert.ok(file);
  assert.equal(file.path, absPath);
  assert.equal(file.mimeType, 'image/png');
  const arts = manager.listArtifacts();
  assert.equal(arts[0].id, rec.id);
  assert.equal(arts[0].status, 'succeeded');
  assert.equal(manager.absolutePathFor(arts[0]), absPath);
  assert.equal(manager.cancel(rec.id), false, 'cancellation bookkeeping must be cleared after completion');
  extraOff();

  // ── Kind inference / adapter mismatch fails before any row is written ─────
  await assert.rejects(manager.generate({ prompt: 'p', durationSeconds: 4 }), /No adapter for preset "a1111" \(video\)/);
  assert.equal(events.length, 2, 'resolution failures must not emit job events');
  assert.equal(manager.listArtifacts().length, 1, 'resolution failures must not insert artifact rows');

  // ── Model (chat) provider path ────────────────────────────────────────────
  await assert.rejects(manager.generate({ prompt: 'p', modelProviderId: 'nope' }), /Selected model provider not found/);
  getDb().prepare('INSERT INTO providers (id, preset_id, name, base_url, enabled, updated_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run('chat1', 'openai', 'Chat Provider', base, Date.now());
  await assert.rejects(
    manager.generate({ prompt: 'p', modelProviderId: 'chat1', kind: 'video' }),
    /Video generation is not available through this chat provider/
  );
  const viaChat = await manager.generate({ prompt: 'p', modelProviderId: 'chat1', model: 'img-model' });
  assert.equal(viaChat.status, 'succeeded');
  assert.equal(viaChat.providerId, 'model:chat1');
  assert.equal(viaChat.mimeType, 'image/png');
  assert.equal(viaChat.model, 'img-model');

  // ── Failure path: provider HTTP error recorded on the artifact row ────────
  manager.saveProvider({ ...a1111Row, baseUrl: `${base}/fail` });
  const beforeFailure = events.length;
  await assert.rejects(manager.generate({ prompt: 'will fail' }), /A1111 error: 500/);
  const failedRow = manager.listArtifacts().find((a) => a.prompt === 'will fail');
  assert.ok(failedRow);
  assert.equal(failedRow.status, 'failed');
  assert.match(failedRow.error ?? '', /A1111 error: 500/);
  assert.equal(events.length, beforeFailure + 2);
  assert.equal(events[beforeFailure].job.status, 'queued');
  assert.equal(events[beforeFailure + 1].job.status, 'failed');
  assert.equal(extraEvents.length, 2, 'a disposed listener must receive no further events');
  assert.equal(manager.cancel(failedRow.id), false, 'cancellation bookkeeping must be cleared after failure');

  // ── Oversize artifact: rejected, row failed, file removed ─────────────────
  manager.saveProvider({ ...a1111Row, baseUrl: `${base}/big` });
  await assert.rejects(manager.generate({ prompt: 'too big' }), /exceeds 50 MB limit/);
  const bigRow = manager.listArtifacts().find((a) => a.prompt === 'too big');
  assert.ok(bigRow);
  assert.equal(bigRow.status, 'failed');
  assert.match(bigRow.error ?? '', /exceeds 50 MB limit/);
  const monthDir = join(dataDir, 'media', month);
  for (const entry of readdirSync(monthDir)) {
    assert.ok(statSync(join(monthDir, entry)).size <= payload.length, `oversized artifact file must be deleted (found ${entry})`);
  }

  // ── Cancellation of an in-flight job ──────────────────────────────────────
  manager.saveProvider({ ...a1111Row, baseUrl: `${base}/slow` });
  const filesBeforeCancelJob = readdirSync(monthDir).length;
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = manager.generate({ prompt: 'slow job' }, { jobId: 'job-cancel' });
  while (!events.some((e) => e.job.id === 'job-cancel')) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(manager.cancel('job-cancel'), true, 'in-flight jobs must be cancellable');
  const cancelledRow = manager.listArtifacts().find((a) => a.id === 'job-cancel');
  assert.equal(cancelledRow?.status, 'cancelled');
  assert.equal(cancelledRow?.error, 'Cancelled by user');
  release();
  gate = null;
  // Fixed: the AbortController still isn't wired into adapter fetches, so the
  // in-flight job runs to completion — but a cancelled row is never overwritten
  // with 'succeeded', no artifact is recorded (the orphaned file is deleted),
  // and no success event is emitted.
  const cancelledResult = await pending;
  assert.equal(cancelledResult.status, 'cancelled');
  const settledRow = manager.listArtifacts().find((a) => a.id === 'job-cancel');
  assert.equal(settledRow?.status, 'cancelled', 'completion must not overwrite a cancelled row');
  assert.equal(settledRow?.error, 'Cancelled by user');
  assert.deepEqual(
    events.filter((e) => e.job.id === 'job-cancel').map((e) => e.job.status),
    ['queued'],
    'no success event may follow a cancellation'
  );
  assert.equal(readdirSync(monthDir).length, filesBeforeCancelJob, 'cancelled job must not leave its artifact file behind');
  assert.equal(manager.cancel('job-cancel'), false, 'bookkeeping must be cleared once the job settles');

  // ── Project-scoped generation ─────────────────────────────────────────────
  const projectDir = join(dataDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  getDb().prepare('INSERT INTO projects (id, name, path, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('proj1', 'Proj', projectDir, '{}', Date.now(), Date.now());
  manager.saveProvider({ ...a1111Row }); // restore the working base URL
  const projRec = await manager.generate({ prompt: 'p', projectId: 'proj1' });
  assert.equal(projRec.projectId, 'proj1');
  const projAbs = join(projectDir, projRec.relativePath);
  assert.deepEqual(readFileSync(projAbs), payload, 'project-scoped artifacts must land under the project folder');
  const projArts = manager.listArtifacts('proj1');
  assert.equal(projArts.length, 1);
  assert.equal(manager.absolutePathFor(projArts[0]), projAbs);

  // ── Artifact deletion ─────────────────────────────────────────────────────
  assert.deepEqual(manager.deleteArtifact(rec.id), { ok: true });
  assert.ok(!manager.listArtifacts().some((a) => a.id === rec.id));
  assert.deepEqual(manager.deleteArtifact(rec.id), { ok: false, error: 'Artifact not found' });
  for (let i = 0; i < 100 && existsSync(absPath); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(absPath), false, 'deleting an artifact must remove its file');

  // ── Legacy path repair: bare-id orphan renamed to <id>.<ext> ──────────────
  const legacyId = 'legacy1';
  getDb().prepare(`INSERT INTO media_artifacts (id, kind, provider_id, model, prompt, relative_path, mime_type, bytes, status, created_at)
    VALUES (?, 'image', 'p', 'm', 'x', ?, 'image/png', ?, 'succeeded', ?)`)
    .run(legacyId, `${month}/${legacyId}.${legacyId}`, payload.length, Date.now());
  writeFileSync(join(dataDir, 'media', month, legacyId), payload);
  manager.repairArtifactPaths();
  const repaired = manager.listArtifacts().find((a) => a.id === legacyId);
  assert.equal(repaired?.relativePath, `${month}/${legacyId}.png`);
  assert.deepEqual(readFileSync(join(dataDir, 'media', month, `${legacyId}.png`)), payload);

  // ── Provider deletion removes the row and its secret ──────────────────────
  manager.deleteProvider('media-keyed');
  assert.equal(getSecret('media:media-keyed'), undefined);
  assert.ok(!manager.listProviders().some((p) => p.id === 'media-keyed'));

  throwingOff();
  console.log('media manager tests passed');
} finally {
  closeDb();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
