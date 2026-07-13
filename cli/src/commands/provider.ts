import { Command } from 'commander';
import { input, password, select } from '@inquirer/prompts';
import { getDb } from '../../../src/main/db/client.js';
import { getProviderApiKey, testConnection } from '../../../src/main/providers/registry.js';
import { refreshProviderModels, removeProvider, saveProvider } from '../../../src/main/providers/service.js';
import { logger } from '../../../src/main/utils/logger.js';
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
    .option('--clear-api-key', 'Remove the stored API key')
    .option('--model <model>', 'Default model')
    .option('--enabled', 'Enable provider', true)
    .action(async (options) => {
      const { PROVIDER_PRESETS, findPreset } = await import('../../../src/shared/presets.js');
      let preset = options.preset ? findPreset(options.preset) : undefined;
      if (options.preset && !preset) {
        format.printError(`Unknown provider preset: ${options.preset}`);
        process.exitCode = 1;
        return;
      }
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
      const keyless = preset.id === 'codex' || preset.id === 'ollama';
      const baseUrl = options.baseUrl ?? (preset.id === 'codex' ? preset.baseUrl : await input({ message: 'Base URL:', default: preset.baseUrl }));
      const apiKey = options.clearApiKey || keyless
        ? undefined
        : process.stdin.isTTY && process.stdout.isTTY
          ? await password({ message: 'API key (leave blank to preserve):', mask: '•' })
          : undefined;
      const defaultModel = options.model || preset.defaultModel;

      const saved = await saveProvider({
        id,
        presetId: preset.id,
        name,
        baseUrl,
        apiKey: apiKey || undefined,
        clearApiKey: options.clearApiKey,
        enabled: options.enabled,
        models: preset.models,
        defaultModel,
        customHeaders: preset.headers
      });

      if (defaultModel) {
        const settings = getSetting<Record<string, unknown>>('appSettings', {}) || {};
        settings.defaultProviderId = id;
        settings.defaultModelId = defaultModel;
        getDb().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .run('appSettings', JSON.stringify(settings), Date.now());
      }

      format.printSuccess(`Provider ${id} saved.`);
      if (saved.discovery.ok) {
        format.printInfo(`Discovered ${saved.discovery.models?.length || 0} models.`);
      } else {
        format.printInfo(`Model discovery failed; saved fallback model list: ${saved.discovery.error || 'unknown error'}`);
      }
      logger.info('cli', `provider ${id} added/updated`);
    });

  cmd
    .command('remove <id>')
    .description('Remove a provider')
    .action((id) => {
      const result = removeProvider(id);
      if (result.ok) format.printSuccess(`Provider ${id} removed.`);
      else format.printError(result.error || `Provider ${id} could not be removed.`);
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
      const result = await refreshProviderModels(id);
      if (result.ok) format.printSuccess(`Refreshed ${result.models?.length || 0} models for ${id}`);
      else format.printError(`Refresh failed: ${result.error || 'no models'}`);
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
