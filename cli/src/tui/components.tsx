import React, { Fragment, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DOMElement } from 'ink';
import type { Message, ThinkingEffort, TokenUsage } from '../../../src/shared/types.js';
import { APP_VERSION } from '../../../src/shared/version.js';
import type { ResolvedTerminalTheme } from './themes.js';
import { SgrMouseParser } from './mouse.js';

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  group?: string;
  keywords?: string;
}

export interface ToolActivity {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'success' | 'error' | 'denied';
  result?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface PermissionView {
  toolName: string;
  args: Record<string, unknown>;
  description?: string;
}

function shorten(value: string, max = 80): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, Math.max(0, max - 1))}…`;
}

function contentText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'attachment_ref') return `@${part.attachment.filename}`;
    if (part.type === 'file') return `@${part.file.filename}`;
    if (part.type === 'image_url') return '[image]';
    if (part.type === 'input_audio') return '[audio]';
    return '';
  }).filter(Boolean).join('\n');
}

export function ComposerInput({ value, onChange, onSubmit, placeholder = '', focus = true, multiline = false, inputKey = 'composer', masked = false }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  focus?: boolean;
  multiline?: boolean;
  inputKey?: string;
  masked?: boolean;
}): JSX.Element {
  const [cursor, setCursor] = useState(value.length);
  const [selectedAll, setSelectedAll] = useState(false);
  const emitted = useRef(value);
  const activeInputKey = useRef(inputKey);
  const savedSelections = useRef(new Map<string, { cursor: number; selectedAll: boolean }>());
  const mouseInputParser = useRef(new SgrMouseParser());

  useEffect(() => {
    if (inputKey !== activeInputKey.current) {
      savedSelections.current.set(activeInputKey.current, { cursor, selectedAll });
      activeInputKey.current = inputKey;
      const saved = savedSelections.current.get(inputKey);
      emitted.current = value;
      setCursor(Math.min(value.length, saved?.cursor ?? value.length));
      setSelectedAll(Boolean(value && saved?.selectedAll));
      return;
    }
    if (value !== emitted.current) {
      emitted.current = value;
      setCursor(value.length);
      setSelectedAll(false);
    }
  }, [inputKey, value]);

  function change(next: string, nextCursor: number): void {
    emitted.current = next;
    setCursor(nextCursor);
    setSelectedAll(false);
    onChange(next);
  }

  useInput((input, key) => {
    const mouseEvents = mouseInputParser.current.push(input);
    if (mouseEvents.length || mouseInputParser.current.hasPendingReport) return;
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab) || key.escape) return;
    if (key.ctrl && input === 'a') {
      setSelectedAll(Boolean(value));
      setCursor(value.length);
      return;
    }
    if (multiline && ((input === '\r' && !key.return) || /^\[(?:13;2u|27;2;13~)$/.test(input))) {
      onSubmit();
      return;
    }
    if (key.return) {
      if (multiline && !key.ctrl && !key.meta && !key.shift) change(`${value.slice(0, cursor)}\n${value.slice(cursor)}`, cursor + 1);
      else onSubmit();
      return;
    }
    if (key.ctrl) return;
    if (key.leftArrow || key.rightArrow) {
      if (selectedAll) setCursor(key.leftArrow ? 0 : value.length);
      else setCursor((current) => Math.max(0, Math.min(value.length, current + (key.leftArrow ? -1 : 1))));
      setSelectedAll(false);
      return;
    }
    if (key.backspace || key.delete) {
      if (selectedAll) {
        change('', 0);
        return;
      }
      if (key.backspace && cursor > 0) {
        change(`${value.slice(0, cursor - 1)}${value.slice(cursor)}`, cursor - 1);
      } else if (key.delete && value.length) {
        const index = cursor < value.length ? cursor : cursor - 1;
        if (index >= 0) change(`${value.slice(0, index)}${value.slice(index + 1)}`, Math.min(index, value.length - 1));
      }
      return;
    }
    if (!input) return;
    const inserted = multiline ? input : input.replace(/[\r\n]+/g, ' ');
    if (selectedAll) change(inserted, inserted.length);
    else change(`${value.slice(0, cursor)}${inserted}${value.slice(cursor)}`, cursor + inserted.length);
  }, { isActive: focus });

  if (!value) {
    if (!focus) return <Text dimColor>{placeholder}</Text>;
    if (!placeholder) return <Text inverse> </Text>;
    return <Text><Text inverse>{placeholder[0]}</Text><Text dimColor>{placeholder.slice(1)}</Text></Text>;
  }
  const display = masked ? '•'.repeat(value.length) : value;
  if (selectedAll && focus) return <Text inverse>{display}</Text>;
  if (!focus) return <Text>{display}</Text>;
  return (
    <Text>
      {display.slice(0, cursor)}
      <Text inverse>{display[cursor] || ' '}</Text>
      {display.slice(cursor + (cursor < display.length ? 1 : 0))}
    </Text>
  );
}

const GLIMMER_CYCLE = 26;

export function glimmerLevel(column: number, phase: number): 0 | 1 | 2 {
  const distance = (phase % GLIMMER_CYCLE) - 1 - column;
  return distance === 0 ? 2 : distance === 1 ? 1 : 0;
}

function MarkGlyph({ glyph, column, phase, theme, center = false }: {
  glyph: '·' | '⬡' | '⬢';
  column: number;
  phase: number;
  theme: ResolvedTerminalTheme;
  center?: boolean;
}): JSX.Element {
  const level = glimmerLevel(column, phase);
  const display = level === 2 ? glyph === '·' ? '✦' : glyph === '⬡' ? '⬢' : '◆' : glyph;
  const color = level === 2 ? theme.palette.foreground : level === 1 || center ? theme.palette.accent : theme.palette.subtle;
  return <Text color={color} bold={center || level > 0} dimColor={level === 1}>{display}</Text>;
}

function HiveMark({ theme }: { theme: ResolvedTerminalTheme }): JSX.Element {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (process.env.HIVE_REDUCED_MOTION === '1') return;
    const timer = setInterval(() => setPhase((value) => (value + 1) % GLIMMER_CYCLE), 120);
    return () => clearInterval(timer);
  }, []);
  return (
    <Box flexDirection="column" width={19} alignItems="center">
      <Text>     <MarkGlyph glyph="·" column={0} phase={phase} theme={theme} />       <MarkGlyph glyph="·" column={6} phase={phase} theme={theme} /></Text>
      <Text>       <MarkGlyph glyph="⬡" column={1} phase={phase} theme={theme} />   <MarkGlyph glyph="⬡" column={5} phase={phase} theme={theme} /></Text>
      <Text> <MarkGlyph glyph="·" column={0} phase={phase} theme={theme} />   <MarkGlyph glyph="⬡" column={2} phase={phase} theme={theme} />   <MarkGlyph glyph="⬢" column={3} phase={phase} theme={theme} center />   <MarkGlyph glyph="⬡" column={4} phase={phase} theme={theme} />   <MarkGlyph glyph="·" column={6} phase={phase} theme={theme} /></Text>
      <Text>       <MarkGlyph glyph="⬡" column={1} phase={phase} theme={theme} />   <MarkGlyph glyph="⬡" column={5} phase={phase} theme={theme} /></Text>
      <Text>     <MarkGlyph glyph="·" column={0} phase={phase} theme={theme} />       <MarkGlyph glyph="·" column={6} phase={phase} theme={theme} /></Text>
    </Box>
  );
}

export const WELCOME_ACTIONS = [
  { id: 'worktree', label: 'New worktree', shortcut: 'ctrl+w' },
  { id: 'resume', label: 'Resume session', shortcut: 'ctrl+s' },
  { id: 'models', label: 'Models', shortcut: '/model' },
  { id: 'release-notes', label: 'Changelog', shortcut: '/release-notes' },
  { id: 'quit', label: 'Quit', shortcut: 'ctrl+q' }
] as const;

export type WelcomeActionId = typeof WELCOME_ACTIONS[number]['id'];

function WelcomeAction({ label, shortcut, selected, theme, nodeRef }: {
  label: string;
  shortcut: string;
  selected: boolean;
  theme: ResolvedTerminalTheme;
  nodeRef?: React.Ref<DOMElement>;
}): JSX.Element {
  return (
    <Box ref={nodeRef} justifyContent="space-between">
      <Text color={selected ? theme.palette.accent : theme.palette.foreground} bold={selected}>{selected ? '❯ ' : '  '}{label}</Text>
      <Text color={selected ? theme.palette.muted : theme.palette.subtle}>{shortcut}</Text>
    </Box>
  );
}

export function Welcome({ theme, width, workspace, model, selected = 0, actionRefs }: {
  theme: ResolvedTerminalTheme;
  width: number;
  workspace: string;
  model?: string;
  selected?: number;
  actionRefs?: React.MutableRefObject<Array<DOMElement | null>>;
}): JSX.Element {
  const narrow = width < 40;
  const spacious = width >= 86;
  const workspaceName = workspace.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') || '.';
  if (narrow) {
    const lineWidth = Math.max(8, width - 8);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.palette.border} marginTop={1} paddingX={1}>
        <Text><Text color={theme.palette.foreground} bold>DERO Hive</Text><Text color={theme.palette.subtle}>  {APP_VERSION}</Text></Text>
        <Text color={theme.palette.accent} bold>{shorten(model || 'Provider setup required', lineWidth)}</Text>
        <Text color={theme.palette.muted}>{shorten(model ? workspaceName : 'Settings → Providers', lineWidth)}</Text>
        <Box flexDirection="column" marginTop={1}>
          {WELCOME_ACTIONS.map((action, index) => (
            <WelcomeAction key={action.id} {...action} label={action.id === 'models' ? model ? 'Switch model' : 'Connect model' : action.label} selected={index === selected} theme={theme} nodeRef={(node) => { if (actionRefs) actionRefs.current[index] = node; }} />
          ))}
        </Box>
        <Text color={theme.palette.subtle}>{shorten('↑↓ choose · Enter open · Ctrl+P commands', lineWidth)}</Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor={theme.palette.border}
      marginX={width >= 72 ? 1 : 0}
      marginTop={2}
      paddingX={spacious ? 2 : 1}
      paddingY={1}
    >
      {spacious && (
        <Box width={21} alignItems="center" justifyContent="center">
          <HiveMark theme={theme} />
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1}>
        <Text><Text color={theme.palette.foreground} bold>DERO Hive</Text><Text color={theme.palette.subtle}>  {APP_VERSION}</Text></Text>
        <Box marginTop={1}>
          <Text color={theme.palette.accent} bold>{model ? shorten(model, 38) : 'Provider setup required'}</Text>
        </Box>
        <Text color={theme.palette.muted}>{model ? `Workspace  ${shorten(workspaceName, 44)}` : 'Open Settings → Providers to connect a model.'}</Text>
        <Box flexDirection="column" marginTop={1}>
          {WELCOME_ACTIONS.map((action, index) => (
            <WelcomeAction key={action.id} {...action} label={action.id === 'models' ? model ? 'Switch model' : 'Connect model' : action.label} selected={index === selected} theme={theme} nodeRef={(node) => { if (actionRefs) actionRefs.current[index] = node; }} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function viewportLines(text: string, width: number): string[] {
  const lines: string[] = [];
  const safeWidth = Math.max(20, width);
  for (const sourceLine of text.replace(/\r\n/g, '\n').split('\n')) {
    if (sourceLine.length <= safeWidth) {
      lines.push(sourceLine);
      continue;
    }
    for (let offset = 0; offset < sourceLine.length; offset += safeWidth) {
      lines.push(sourceLine.slice(offset, offset + safeWidth));
    }
  }
  return lines.length ? lines : [''];
}

function Inline({ text, theme }: { text: string; theme: ResolvedTerminalTheme }): JSX.Element {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const chunks = text.split(pattern);
  return (
    <Text color={theme.palette.foreground}>
      {chunks.map((chunk, index) => {
        if (chunk.startsWith('**') && chunk.endsWith('**')) {
          return <Text key={index} bold>{chunk.slice(2, -2)}</Text>;
        }
        if (chunk.startsWith('`') && chunk.endsWith('`')) {
          return <Text key={index} color={theme.palette.accent}>{chunk.slice(1, -1)}</Text>;
        }
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(chunk);
        if (link) return <Text key={index} color={theme.palette.info} underline>{link[1]}</Text>;
        return <Fragment key={index}>{chunk}</Fragment>;
      })}
    </Text>
  );
}

export function MarkdownBlock({ text, theme, maxLines }: {
  text: string;
  theme: ResolvedTerminalTheme;
  maxLines?: number;
}): JSX.Element {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  const lines = maxLines && rawLines.length > maxLines
    ? [...rawLines.slice(0, Math.max(1, maxLines - 1)), `… ${rawLines.length - maxLines + 1} more line(s)`]
    : rawLines;
  let inCode = false;
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        if (/^\s*```/.test(line)) {
          inCode = !inCode;
          const language = line.replace(/^\s*```/, '').trim();
          return (
            <Text key={index} color={theme.palette.subtle}>
              {inCode ? `┌─ ${language || 'code'}` : '└─'}
            </Text>
          );
        }
        if (inCode) {
          return <Text key={index} color={theme.palette.foreground} backgroundColor={theme.palette.codeBackground}>  {line || ' '}</Text>;
        }
        const heading = /^(#{1,4})\s+(.+)$/.exec(line);
        if (heading) return <Text key={index} color={theme.palette.accent} bold>{heading[2]}</Text>;
        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) return <Text key={index} color={theme.palette.muted}>│ <Inline text={quote[1]} theme={theme} /></Text>;
        const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
        if (bullet) return <Text key={index}><Text color={theme.palette.accent}>• </Text><Inline text={bullet[1]} theme={theme} /></Text>;
        const ordered = /^\s*(\d+)\.\s+(.+)$/.exec(line);
        if (ordered) return <Text key={index}><Text color={theme.palette.accent}>{ordered[1]}. </Text><Inline text={ordered[2]} theme={theme} /></Text>;
        if (/^\s*[-*_]{3,}\s*$/.test(line)) return <Text key={index} color={theme.palette.borderStrong}>{'─'.repeat(36)}</Text>;
        return <Inline key={index} text={line || ' '} theme={theme} />;
      })}
    </Box>
  );
}

function MessageCard({ message, theme, compactMode, showTimestamps, showReasoning, showToolDetails }: {
  message: Message;
  theme: ResolvedTerminalTheme;
  compactMode?: boolean;
  showTimestamps?: boolean;
  showReasoning: boolean;
  showToolDetails: boolean;
}): JSX.Element {
  const text = contentText(message);
  if (message.role === 'tool') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color={theme.palette.muted}>└─ ✓ {message.name || 'tool'} <Text color={theme.palette.subtle}>{shorten(text, 110)}</Text></Text>
        {showToolDetails && <Box paddingLeft={3}><MarkdownBlock text={text} theme={theme} maxLines={12} /></Box>}
      </Box>
    );
  }
  const user = message.role === 'user';
  const system = message.role === 'system';
  const label = user ? 'YOU' : system ? 'CONTEXT' : 'HIVE';
  const color = user ? theme.palette.info : system ? theme.palette.muted : theme.palette.accent;
  const createdAt = new Date(message.createdAt);
  const timestamp = `${String(createdAt.getHours()).padStart(2, '0')}:${String(createdAt.getMinutes()).padStart(2, '0')}`;
  return (
    <Box flexDirection="column" marginBottom={compactMode ? 0 : 1}>
      <Text><Text color={color} bold>{label}</Text>{showTimestamps && <Text color={theme.palette.subtle}>  {timestamp}</Text>}</Text>
      {message.reasoning && showReasoning && (
        <Box flexDirection="column" borderLeft borderColor={theme.palette.border} paddingLeft={1} marginBottom={1}>
          <Text color={theme.palette.muted}>thinking{showToolDetails ? ' · expanded' : ` · ${shorten(message.reasoning, 180)}`}</Text>
          {showToolDetails && <MarkdownBlock text={message.reasoning} theme={theme} maxLines={16} />}
        </Box>
      )}
      <MarkdownBlock text={text || ' '} theme={theme} maxLines={system ? 8 : undefined} />
      {(!compactMode || showToolDetails) && message.toolCalls?.length ? (
        <Text color={theme.palette.subtle}>
          {message.toolCalls.map((call) => `↳ ${call.function.name}`).join('  ')}
        </Text>
      ) : null}
      {(!compactMode || showToolDetails) && message.usage && (
        <Text color={theme.palette.subtle}>{message.model ? `${message.model} · ` : ''}{message.usage.totalTokens.toLocaleString()} tokens</Text>
      )}
    </Box>
  );
}

export function ToolRow({ tool, theme, expanded }: {
  tool: ToolActivity;
  theme: ResolvedTerminalTheme;
  expanded: boolean;
}): JSX.Element {
  const icon = tool.status === 'running' ? '◌' : tool.status === 'success' ? '✓' : tool.status === 'denied' ? '⊘' : '×';
  const color = tool.status === 'running' ? theme.palette.info
    : tool.status === 'success' ? theme.palette.success
    : tool.status === 'denied' ? theme.palette.warning
    : theme.palette.danger;
  const summary = Object.entries(tool.args).slice(0, 2).map(([key, value]) => `${key}=${shorten(String(value), 44)}`).join(' ');
  const meta = tool.meta || {};
  const change = typeof meta.linesAdded === 'number' || typeof meta.linesRemoved === 'number'
    ? ` +${String(meta.linesAdded || 0)} -${String(meta.linesRemoved || 0)}` : '';
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color={color}>└─ {icon} <Text bold>{tool.name}</Text><Text color={theme.palette.muted}> {summary}</Text>{change}<Text color={theme.palette.subtle}>{tool.durationMs !== undefined ? ` · ${tool.durationMs}ms` : ''}</Text></Text>
      {expanded && tool.result && <Box paddingLeft={3} borderLeft borderColor={theme.palette.border}><MarkdownBlock text={tool.result} theme={theme} maxLines={14} /></Box>}
    </Box>
  );
}

export function Transcript({ messages, live, tools, theme, height, width, workspace, model, showWelcome, welcomeSelected, welcomeActionRefs, scrollOffset, focusMode, compactMode, showTimestamps, showReasoning, showToolDetails }: {
  messages: Message[];
  live?: Message;
  tools: ToolActivity[];
  theme: ResolvedTerminalTheme;
  height: number;
  width: number;
  workspace: string;
  model?: string;
  showWelcome: boolean;
  welcomeSelected?: number;
  welcomeActionRefs?: React.MutableRefObject<Array<DOMElement | null>>;
  scrollOffset: number;
  focusMode: boolean;
  compactMode?: boolean;
  showTimestamps?: boolean;
  showReasoning: boolean;
  showToolDetails: boolean;
}): JSX.Element {
  const all = live ? [...messages, live] : messages;
  const visibleSource = focusMode ? all.slice(-2) : all;
  const lastTool = tools.at(-1);
  const expandedTool = Boolean(showToolDetails || lastTool?.status === 'error');
  const visibleTools = scrollOffset === 0
    ? tools.slice(expandedTool ? -1 : -3)
    : [];
  const toolBudget = visibleTools.length * (expandedTool ? 17 : 3);
  const latest = visibleSource.at(-1);
  const latestLines = latest ? viewportLines(contentText(latest), width - 4) : [];
  const reasoningBudget = latest?.reasoning && showReasoning ? (showToolDetails ? 19 : 3) : 0;
  const contentBudget = Math.max(3, height - toolBudget - reasoningBudget - 4);
  const latestMaxOffset = Math.max(0, latestLines.length - contentBudget);
  const scrollingLongMessage = latestMaxOffset > 0 && scrollOffset <= latestMaxOffset;
  const longMessageOffset = scrollingLongMessage ? scrollOffset : 0;
  const longEnd = latestLines.length - longMessageOffset;
  const longStart = Math.max(0, longEnd - contentBudget);
  const longText = latest && scrollingLongMessage
    ? [
        ...(longStart > 0 ? [`… ${longStart} earlier line(s)`] : []),
        ...latestLines.slice(longStart, longEnd),
        ...(longEnd < latestLines.length ? [`… ${latestLines.length - longEnd} later line(s)`] : [])
      ].join('\n')
    : '';
  const blockBudget = Math.max(2, Math.floor(height / 5));
  const page = Math.max(1, Math.floor(height / 4));
  const messageOffset = scrollOffset > latestMaxOffset
    ? Math.max(0, Math.ceil((scrollOffset - latestMaxOffset) / page))
    : latestMaxOffset === 0 ? Math.floor(scrollOffset / page) : 0;
  const end = Math.max(0, visibleSource.length - messageOffset);
  const start = Math.max(0, end - blockBudget);
  const visible = scrollingLongMessage && latest
    ? [{ ...latest, content: longText }]
    : visibleSource.slice(start, end);
  return (
    <Box flexDirection="column" height={Math.max(3, height)} overflow="hidden">
      {visible.length === 0 ? (
        showWelcome
          ? height >= 14
            ? <Welcome theme={theme} width={width} workspace={workspace} model={model} selected={welcomeSelected} actionRefs={welcomeActionRefs} />
            : <Box paddingX={1} paddingTop={1}><Text color={theme.palette.muted}>{shorten('DERO Hive · type below · /commands', Math.max(8, width - 4))}</Text></Box>
          : null
      ) : visible.map((message) => (
        <MessageCard key={message.id} message={message} theme={theme} compactMode={compactMode} showTimestamps={showTimestamps} showReasoning={showReasoning} showToolDetails={showToolDetails} />
      ))}
      {visibleTools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} theme={theme} expanded={showToolDetails || tool.status === 'error'} />
      ))}
      {scrollingLongMessage && <Text color={theme.palette.subtle}>PageUp/PageDown · {longMessageOffset} line(s) from latest</Text>}
      {!scrollingLongMessage && start > 0 && <Text color={theme.palette.subtle}>↑ {start} earlier message(s) · PageUp</Text>}
    </Box>
  );
}

export function Header({ theme, title, online, queued, contextUsed = 0, contextLimit = 0 }: {
  theme: ResolvedTerminalTheme;
  title: string;
  online: 'idle' | 'working' | 'error';
  queued: number;
  contextUsed?: number;
  contextLimit?: number;
}): JSX.Element {
  const statusColor = online === 'working' ? theme.palette.warning : online === 'error' ? theme.palette.danger : theme.palette.success;
  const context = contextLimit > 0
    ? `${Math.min(contextUsed, contextLimit).toLocaleString()} / ${contextLimit.toLocaleString()} · ${Math.min(100, Math.round((contextUsed / contextLimit) * 100))}% · `
    : '';
  return (
    <Box justifyContent="space-between" borderBottom borderColor={theme.palette.border} paddingX={1}>
      <Text><Text color={theme.palette.accent}>◆</Text><Text color={theme.palette.foreground} bold> DERO HIVE</Text><Text color={theme.palette.muted}>  /  {shorten(title, 52)}</Text></Text>
      <Text><Text color={theme.palette.subtle}>{context}</Text><Text color={statusColor}>{online === 'working' ? '● WORKING' : online === 'error' ? '● ATTENTION' : '● READY'}{queued ? ` · ${queued} queued` : ''}</Text></Text>
    </Box>
  );
}

export function Picker({ title, items, selected, theme, hint, maxItems = 9, width = 80, itemRefs, closeRef }: {
  title: string;
  items: PickerItem[];
  selected: number;
  theme: ResolvedTerminalTheme;
  hint?: string;
  maxItems?: number;
  width?: number;
  itemRefs?: React.MutableRefObject<Array<DOMElement | null>>;
  closeRef?: React.Ref<DOMElement>;
}): JSX.Element {
  const safe = Math.max(0, Math.min(items.length - 1, selected));
  const visibleCount = Math.max(3, maxItems);
  const start = Math.max(0, Math.min(safe - Math.floor(visibleCount / 2), items.length - visibleCount));
  const rowWidth = Math.max(8, width - 4);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.palette.borderStrong} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.palette.accent} bold>{title}</Text>
        <Box><Text color={theme.palette.subtle}>{items.length ? `${safe + 1}/${items.length}  ` : ''}</Text><Box ref={closeRef}><Text color={theme.palette.subtle}>[×]</Text></Box></Box>
      </Box>
      {hint && <Text color={theme.palette.subtle}>{hint}</Text>}
      {items.length === 0 ? <Text color={theme.palette.muted}>No matches</Text> : items.slice(start, start + visibleCount).map((item, index) => {
        const active = start + index === safe;
        const content = `${active ? '❯' : ' '} ${item.group ? `${item.group} / ` : ''}${item.label}${item.detail ? `  ${item.detail}` : ''}`;
        return (
          <Box key={item.id} ref={(node) => { if (itemRefs) itemRefs.current[start + index] = node; }}>
            <Text
              color={active ? theme.palette.background : theme.palette.foreground}
              backgroundColor={active ? theme.palette.foreground : undefined}
              bold={active}
            >
              {shorten(content, rowWidth).padEnd(rowWidth)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function CommandMenu({ items, selected, theme, maxItems = 6, width = 80, itemRefs, closeRef }: {
  items: PickerItem[];
  selected: number;
  theme: ResolvedTerminalTheme;
  maxItems?: number;
  width?: number;
  itemRefs?: React.MutableRefObject<Array<DOMElement | null>>;
  closeRef?: React.Ref<DOMElement>;
}): JSX.Element {
  const safe = Math.max(0, Math.min(items.length - 1, selected));
  const visibleCount = Math.max(3, maxItems);
  const start = Math.max(0, Math.min(safe - Math.floor(visibleCount / 2), items.length - visibleCount));
  const panelWidth = Math.max(8, width - 4);
  const innerWidth = Math.max(4, panelWidth - 4);
  const wide = panelWidth >= 46;
  const labelWidth = Math.min(28, Math.max(18, Math.floor(innerWidth * 0.24)));
  const detailWidth = Math.max(1, innerWidth - labelWidth - 2);
  const count = String(items.length);
  const ruleWidth = Math.max(1, panelWidth - count.length - 1);
  const visibleRows = Math.min(visibleCount, items.length);
  const thumbRow = items.length > visibleRows && visibleRows > 0
    ? Math.round((safe / Math.max(1, items.length - 1)) * (visibleRows - 1))
    : -1;
  const activeDetail = items[safe]?.detail || 'No description available';

  return (
    <Box flexDirection="column" width={panelWidth} alignSelf="center">
      <Box>
        <Text color={theme.palette.border}>{'─'.repeat(ruleWidth)}</Text>
        <Box ref={closeRef}><Text color={theme.palette.muted}>{` ${count}`}</Text></Box>
      </Box>
      {items.length === 0 ? (
        <Text color={theme.palette.muted}>{`  ${shorten('No commands match your search', innerWidth).padEnd(innerWidth)}  `}</Text>
      ) : items.slice(start, start + visibleCount).map((item, index) => {
        const active = start + index === safe;
        const backgroundColor = active ? theme.palette.border : theme.palette.background;
        const label = `${active ? '›' : ' '} ${shorten(item.label, wide ? labelWidth - 2 : innerWidth - 3)}`;
        const scroll = index === thumbRow ? '█' : ' ';
        return (
          <Box key={item.id} ref={(node) => { if (itemRefs) itemRefs.current[start + index] = node; }}>
            <Text backgroundColor={backgroundColor}>
              <Text backgroundColor={backgroundColor}>  </Text>
              <Text color={theme.palette.foreground} bold={active}>{wide ? label.padEnd(labelWidth) : label.padEnd(innerWidth - 1)}</Text>
              {wide && <Text color={active ? theme.palette.foreground : theme.palette.muted}>{` ${shorten(item.detail || '', detailWidth).padEnd(detailWidth)}`}</Text>}
              <Text color={theme.palette.borderStrong}>{scroll}</Text>
              <Text backgroundColor={backgroundColor}>  </Text>
            </Text>
          </Box>
        );
      })}
      {!wide && items.length > 0 && (
        <Text color={theme.palette.muted}>{`  ${shorten(activeDetail, innerWidth).padEnd(innerWidth)}  `}</Text>
      )}
      <Text color={theme.palette.border}>{'─'.repeat(panelWidth)}</Text>
    </Box>
  );
}

export function PermissionPrompt({ request, theme }: { request: PermissionView; theme: ResolvedTerminalTheme }): JSX.Element {
  const args = JSON.stringify(request.args, null, 2);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.palette.warning} paddingX={1}>
      <Text color={theme.palette.warning} bold>Permission required · {request.toolName}</Text>
      {request.description && <Text color={theme.palette.muted}>{request.description}</Text>}
      <MarkdownBlock text={args} theme={theme} maxLines={10} />
      <Text><Text color={theme.palette.success}>[a] allow once</Text>  <Text color={theme.palette.accent}>[p] allow for project</Text>  <Text color={theme.palette.warning}>[g] always allow</Text>  <Text color={theme.palette.danger}>[d] deny</Text></Text>
    </Box>
  );
}

export function StatusBar({ theme, provider, model, reasoning, usage, width, borderColor }: {
  theme: ResolvedTerminalTheme;
  provider: string;
  model: string;
  reasoning: ThinkingEffort;
  usage: TokenUsage;
  width: number;
  borderColor: string;
}): JSX.Element {
  if (width < 20) return <Text color={borderColor}>╰{'─'.repeat(width)}╯</Text>;
  const identity = provider ? `${provider} / ${model || 'no model'}` : 'no provider';
  const usageText = usage.totalTokens ? `${usage.totalTokens.toLocaleString()} tok` : '';
  const reasoningSuffix = width >= 96 ? ` · ${reasoning}` : '';
  const statusWidth = width - 4;
  const detailSource = `${identity}${reasoningSuffix}`;
  const detailBudget = usageText ? statusWidth - usageText.length - 3 : statusWidth;
  const showUsageWithDetail = Boolean(usageText && detailBudget >= 4);
  const usageOnly = Boolean(usageText && !showUsageWithDetail);
  const detail = usageOnly ? '' : shorten(detailSource, Math.max(4, detailBudget));
  const status = showUsageWithDetail ? `${usageText} · ${detail}` : usageOnly ? shorten(usageText, statusWidth) : detail;
  const leftRule = '─'.repeat(width - status.length - 3);
  return (
    <Box>
      <Text color={borderColor}>╰{leftRule} </Text>
      {(showUsageWithDetail || usageOnly) && <Text color={theme.palette.accent}>{usageOnly ? status : `${usageText} · `}</Text>}
      {!usageOnly && <Text color={theme.palette.subtle}>{detail}</Text>}
      <Text color={borderColor}> ─╯</Text>
    </Box>
  );
}
