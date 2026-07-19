import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { Conversation, Project, ProviderConfig } from '../../../src/shared/types.js';
import { sanitizeTerminalText } from '../../../src/shared/terminal.js';

marked.use(markedTerminal({
  reflowText: true,
  width: Math.min(process.stdout.columns || 80, 100)
}));

export function printTitle(text: string): void {
  console.log(chalk.bold.cyan(`\n${sanitizeTerminalText(text)}\n`));
}

export function printInfo(text: string): void {
  console.log(chalk.gray(sanitizeTerminalText(text)));
}

export function printSuccess(text: string): void {
  console.log(chalk.green(sanitizeTerminalText(text)));
}

export function printError(text: string): void {
  console.error(chalk.red(sanitizeTerminalText(text)));
}

export function renderMarkdown(text: string): string {
  return marked.parse(sanitizeTerminalText(text), { async: false }) as string;
}

export function formatConversation(conv: Conversation): string {
  const date = new Date(conv.updatedAt).toLocaleString();
  const title = sanitizeTerminalText(conv.title || 'New chat');
  const pinned = conv.pinned ? chalk.yellow('📌 ') : '';
  const archived = conv.archived ? chalk.gray('[archived] ') : '';
  return `${pinned}${archived}${chalk.white.bold(title)} ${chalk.gray(`(${conv.messageCount} messages, ${date})`)}`;
}

export function formatProject(p: Project): string {
  return `${sanitizeTerminalText(p.icon || '📁')} ${chalk.bold(sanitizeTerminalText(p.name))} ${chalk.gray(sanitizeTerminalText(p.path))}`;
}

export function formatProvider(p: ProviderConfig): string {
  const status = p.enabled ? chalk.green('●') : chalk.gray('○');
  const key = p.hasApiKey ? chalk.green('key') : chalk.gray('no key');
  return `${status} ${chalk.bold(sanitizeTerminalText(p.id))} ${chalk.gray(`${sanitizeTerminalText(p.name)} — ${sanitizeTerminalText(p.baseUrl)} [${key}]`)}`;
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const colWidths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] || '').length)));
  return rows
    .map((row) =>
      row.map((cell, i) => sanitizeTerminalText(cell).padEnd(colWidths[i])).join('  ')
    )
    .join('\n');
}
