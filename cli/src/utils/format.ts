import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { Conversation, Project, ProviderConfig } from '../../../src/shared/types.js';

marked.use(markedTerminal({
  reflowText: true,
  width: Math.min(process.stdout.columns || 80, 100)
}));

export function printTitle(text: string): void {
  console.log(chalk.bold.cyan(`\n${text}\n`));
}

export function printInfo(text: string): void {
  console.log(chalk.gray(text));
}

export function printSuccess(text: string): void {
  console.log(chalk.green(text));
}

export function printError(text: string): void {
  console.error(chalk.red(text));
}

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

export function formatConversation(conv: Conversation): string {
  const date = new Date(conv.updatedAt).toLocaleString();
  const title = conv.title || 'New chat';
  const pinned = conv.pinned ? chalk.yellow('📌 ') : '';
  const archived = conv.archived ? chalk.gray('[archived] ') : '';
  return `${pinned}${archived}${chalk.white.bold(title)} ${chalk.gray(`(${conv.messageCount} messages, ${date})`)}`;
}

export function formatProject(p: Project): string {
  return `${p.icon || '📁'} ${chalk.bold(p.name)} ${chalk.gray(p.path)}`;
}

export function formatProvider(p: ProviderConfig): string {
  const status = p.enabled ? chalk.green('●') : chalk.gray('○');
  const key = p.hasApiKey ? chalk.green('key') : chalk.gray('no key');
  return `${status} ${chalk.bold(p.id)} ${chalk.gray(`${p.name} — ${p.baseUrl} [${key}]`)}`;
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const colWidths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] || '').length)));
  return rows
    .map((row) =>
      row.map((cell, i) => cell.padEnd(colWidths[i])).join('  ')
    )
    .join('\n');
}
