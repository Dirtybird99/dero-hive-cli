import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import * as conversationService from '../services/conversation.js';
import * as format from '../utils/format.js';
import { closeConversationSessions } from '../../../src/main/providers/registry.js';
import { sanitizeTerminalText } from '../../../src/shared/terminal.js';

export function formatConversationMessageContent(content: unknown): string {
  return sanitizeTerminalText(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

export function formatConversationSearchResult(result: {
  conversationId: string;
  messageId: string;
  role: string;
  snippet: string;
}): string {
  return sanitizeTerminalText(`${result.conversationId} / ${result.messageId} (${result.role}): ${result.snippet}`);
}

export function conversationCommand(): Command {
  const cmd = new Command('conversation')
    .alias('conv')
    .description('Manage conversations');

  cmd
    .command('list')
    .description('List conversations')
    .option('--project <id>', 'Filter by project id')
    .action((options) => {
      const convs = conversationService.listConversations(options.project);
      if (convs.length === 0) {
        format.printInfo('No conversations yet.');
        return;
      }
      for (const c of convs) {
        console.log(format.formatConversation(c));
      }
    });

  cmd
    .command('show <id>')
    .description('Show conversation messages')
    .action((id) => {
      const conv = conversationService.getConversation(id);
      if (!conv) {
        format.printError(`Conversation ${id} not found`);
        return;
      }
      format.printTitle(conv.title || 'Conversation');
      const messages = conversationService.getMessages(id);
      for (const m of messages) {
        const prefix = m.role === 'user' ? chalk.blue('You') : m.role === 'assistant' ? chalk.green('AI') : chalk.gray('Tool');
        console.log(`\n${prefix}:`);
        const content = formatConversationMessageContent(m.content);
        console.log(content);
      }
    });

  cmd
    .command('delete <id>')
    .description('Delete a conversation')
    .action(async (id) => {
      const conv = conversationService.getConversation(id);
      if (!conv) {
        format.printError(`Conversation ${id} not found`);
        return;
      }
      const ok = await confirm({ message: `Delete "${sanitizeTerminalText(conv.title)}"?`, default: false });
      if (ok) {
        await closeConversationSessions(id);
        await conversationService.deleteConversation(id);
        format.printSuccess(`Conversation ${id} deleted`);
      }
    });

  cmd
    .command('fork <id>')
    .description('Fork a conversation')
    .action((id) => {
      const conv = conversationService.forkConversation(id);
      if (!conv) {
        format.printError(`Conversation ${id} not found`);
        return;
      }
      format.printSuccess(`Forked conversation: ${conv.id}`);
    });

  cmd
    .command('search <query>')
    .description('Search conversation messages')
    .action((query) => {
      const results = conversationService.searchConversations(query);
      if (results.length === 0) {
        format.printInfo('No matches.');
        return;
      }
      for (const r of results) {
        console.log(formatConversationSearchResult(r));
      }
    });

  return cmd;
}
