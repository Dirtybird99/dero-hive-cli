import { Command } from 'commander';
import { input, select } from '@inquirer/prompts';
import { getDb } from '../../../src/main/db/client.js';
import { setSecret, deleteSecret } from '../../../src/main/utils/secrets.js';
import { getProviderApiKey, testConnection } from '../../../src/main/providers/registry.js';
import { fetchLiveModels } from '../../../src/main/providers/models.js';
import { logger } from '../../../src/main/utils/logger.js';
import { applyKnownMetadata } from '../../../src/shared/modelMetadata.js';
import type { ProviderModel } from '../../../src/shared/types.js';
import * as format from '../utils/format.js';

function rowToConfig(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    presetId: row.preset_id as string | undefined,
    name: row.name as string,
    baseUrl: row.base_url as string,
    enabled: row.enabled === 1,
    models: safeJson(row.models as string, []),
    customHeaders: safeJson(row.custom_headers as string, {}),
    modelsFetchedAt: row.models_fetched_at as number | undefined
  };
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function providerCommand(): Command {
  const cmd = new Command('provider')
    .description('Manage AI providers');

  cmd
    .command('list')
    .description('List configured providers')
    .action(async () => {
      const rows = getDb().prepare('SELECT * FROM providers ORDER BY name').all() as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        format.printInfo('No providers configured. Use `hive provider add` to add one.');
        return;
      }
      for (const row of rows) {
        const cfg = rowToConfig(row);
        const hasKey = !!getProviderApiKey(cfg.id);
        format.printInfo(format.formatProvider({ ...cfg, hasApiKey: hasKey, apiKey: '' }));
      }
    });

  cmd
    .command('add')
    .description('Add or update a provider')
    .option('--preset <preset>', 'Use a built-in preset')
    .option('--id <id>', 'Provider id')
    .option('--name <name>', 'Display name')
    .option('--base-url <url>', 'API base URL')
    .option('--api-key <key>', 'API key')
    .option('--model <model>', 'Default model')
    .option('--enabled', 'Enable provider', true)
    .action(async (options) => {
      const { PROVIDER_PRESETS, findPreset } = await import('../../../src/shared/presets.js');
      let preset = options.preset ? findPreset(options.preset) : undefined;
      if (!preset) {
        if (PROVIDER_PRESETS.length === 0) {
          format.printError('No provider presets available. Check the installation or use `--preset`, `--id`, `--name`, and `--base-url`.');
          return;
        }
        const presetId = await select({
          message: 'Choose a provider preset',
          choices: PROVIDER_PRESETS.map((p) => ({ value: p.id, name: `${p.name} (${p.defaultModel})` }))
        });
        preset = findPreset(presetId);
      }
      if (!preset) {
        format.printError('Unknown preset');
        return;
      }

      const id = options.id || (await input({ message: 'Provider id:', default: preset.id }));
      const name = options.name || (await input({ message: 'Display name:', default: preset.name }));
      const baseUrl = options.baseUrl || (await input({ message: 'Base URL:', default: preset.baseUrl }));
      const apiKey = options.apiKey || (await input({ message: 'API key (leave blank to skip):' }));
      const defaultModel = options.model || preset.defaultModel;

      const now = Date.now();
      getDb()
        .prepare(
          `INSERT INTO providers (id, preset_id, name, base_url, api_key_ref, enabled, models, custom_headers, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             preset_id = excluded.preset_id,
             name = excluded.name,
             base_url = excluded.base_url,
             enabled = excluded.enabled,
             models = excluded.models,
             custom_headers = excluded.custom_headers,
             updated_at = excluded.updated_at`
        )
        .run(
          id,
          preset.id,
          name,
          baseUrl,
          null,
          options.enabled ? 1 : 0,
          JSON.stringify(preset.models),
          JSON.stringify(preset.headers || {}),
          now
        );

      if (apiKey) setSecret(`provider:${id}`, apiKey);
      else deleteSecret(`provider:${id}`);

      if (defaultModel) {
        const settings = getSetting<Record<string, unknown>>('appSettings', {}) || {};
        settings.defaultProviderId = id;
        settings.defaultModelId = defaultModel;
        getDb().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .run('appSettings', JSON.stringify(settings), Date.now());
      }

      format.printSuccess(`Provider ${id} saved.`);
      logger.info('cli', `provider ${id} added/updated`);
    });

  cmd
    .command('remove <id>')
    .description('Remove a provider')
    .action((id) => {
      deleteSecret(`provider:${id}`);
      getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
      format.printSuccess(`Provider ${id} removed.`);
    });

  cmd
    .command('test <id>')
    .description('Test a provider connection')
    .action(async (id) => {
      const result = await testConnection(id);
      if (result.ok) {
        format.printSuccess(`Provider ${id} is reachable.`);
        if (result.models?.length) format.printInfo(`Models: ${result.models.join(', ')}`);
      } else {
        format.printError(`Provider ${id} test failed: ${result.error || 'unknown'}`);
      }
    });

  cmd
    .command('refresh <id>')
    .description('Refresh model list for a provider')
    .action(async (id) => {
      const row = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) {
        format.printError(`Provider ${id} not found`);
        return;
      }
      const cfg = rowToConfig(row);
      const apiKey = getProviderApiKey(id) || '';
      try {
        const result = await fetchLiveModels(cfg.baseUrl, apiKey, cfg.presetId, cfg.customHeaders);
        if (!result.ok || !result.models) {
          format.printError(`Refresh failed: ${result.error || 'no models'}`);
          return;
        }
        const models: ProviderModel[] = applyKnownMetadata(
          result.models.map((m) => {
            const detail = result.details?.[m];
            return {
              id: m,
              name: detail?.name || m,
              contextWindow: detail?.contextWindow,
              maxOutput: detail?.maxOutput,
              supportsVision: detail?.supportsVision,
              supportsTools: detail?.supportsTools,
              supportsReasoning: detail?.supportsReasoning
            };
          })
        );
        getDb().prepare('UPDATE providers SET models = ?, models_fetched_at = ? WHERE id = ?').run(
          JSON.stringify(models),
          Date.now(),
          id
        );
        format.printSuccess(`Refreshed ${models.length} models for ${id}`);
      } catch (err) {
        format.printError(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  cmd
    .command('set-default <id> <model>')
    .description('Set the default provider and model for new chats')
    .action((id, model) => {
      const appSettings = (getSetting('appSettings') as Record<string, unknown> | undefined) || {};
      appSettings.defaultProviderId = id;
      appSettings.defaultModelId = model;
      getDb().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
        'appSettings',
        JSON.stringify(appSettings),
        Date.now()
      );
      format.printSuccess(`Default provider set to ${id}/${model}`);
    });

  return cmd;
}

function getSetting<T>(key: string, fallback?: T): T | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return row.value as unknown as T; }
}
