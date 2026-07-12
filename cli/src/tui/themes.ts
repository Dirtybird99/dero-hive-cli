/**
 * Terminal-friendly versions of Hive's appearance tokens. Named presets
 * mirror renderer/lib/theme.ts; Hive Obsidian is tuned for the coding TUI.
 */

export const TERMINAL_THEME_IDS = [
  'system',
  'dark',
  'light',
  'solarized',
  'nord',
  'catppuccin',
  'gruvbox'
] as const;

export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number];
export type ResolvedTerminalThemeId = Exclude<TerminalThemeId, 'system'>;
export type TerminalColorScheme = 'dark' | 'light';

/** Semantic roles consumed by Ink components rather than ANSI colour names. */
export interface TerminalPalette {
  readonly background: string;
  readonly surface: string;
  readonly sidebar: string;
  readonly input: string;
  readonly foreground: string;
  readonly muted: string;
  readonly subtle: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly accent: string;
  readonly accentHover: string;
  readonly accentSoft: string;
  readonly accentGlow: string;
  readonly userBubble: string;
  readonly codeBackground: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly info: string;
}

export interface TerminalThemeOption {
  readonly id: TerminalThemeId;
  readonly name: string;
  readonly description: string;
}

export interface ResolvedTerminalTheme extends TerminalThemeOption {
  /** Concrete palette selected after resolving `system`. */
  readonly resolvedId: ResolvedTerminalThemeId;
  readonly colorScheme: TerminalColorScheme;
  readonly palette: Readonly<TerminalPalette>;
}

/**
 * Accepts `process.env` directly, as well as explicit values in tests or UI
 * state. Only a validated six-digit hex value is ever used as an override.
 */
export interface TerminalThemeEnvironment {
  readonly prefersDark?: boolean;
  readonly accentColor?: string;
  readonly HIVE_THEME?: string;
  readonly HIVE_COLOR_SCHEME?: string;
  readonly HIVE_ACCENT_COLOR?: string;
  readonly HIVE_ACCENT?: string;
  readonly TERM_BACKGROUND?: string;
  readonly COLOR_SCHEME?: string;
  readonly COLORFGBG?: string;
  readonly [name: string]: string | boolean | undefined;
}

interface ThemeDefinition {
  readonly name: string;
  readonly description: string;
  readonly colorScheme: TerminalColorScheme;
  readonly palette: Readonly<TerminalPalette>;
}

const OPTIONS: readonly TerminalThemeOption[] = Object.freeze([
  { id: 'system', name: 'System', description: 'Follow the terminal colour scheme' },
  { id: 'dark', name: 'Hive Obsidian', description: 'Graphite and honey' },
  { id: 'light', name: 'Hive Light', description: 'Hive desktop light palette' },
  { id: 'solarized', name: 'Solarized Dark', description: 'Low-contrast Solarized palette' },
  { id: 'nord', name: 'Nord', description: 'Cool arctic blue palette' },
  { id: 'catppuccin', name: 'Catppuccin', description: 'Catppuccin Mocha palette' },
  { id: 'gruvbox', name: 'Gruvbox', description: 'Warm retro dark palette' }
]);

const DEFINITIONS: Readonly<Record<ResolvedTerminalThemeId, ThemeDefinition>> = {
  dark: {
    name: 'Hive Obsidian',
    description: 'Graphite and honey',
    colorScheme: 'dark',
    palette: Object.freeze({
      background: '#141414',
      surface: '#202020',
      sidebar: '#101010',
      input: '#141414',
      foreground: '#e1e1e1',
      muted: '#8a8a8a',
      subtle: '#6c6c6c',
      border: '#454545',
      borderStrong: '#8c8c94',
      accent: '#e0af68',
      accentHover: '#edc17f',
      accentSoft: 'rgba(224, 175, 104, 0.12)',
      accentGlow: 'rgba(224, 175, 104, 0.28)',
      userBubble: '#202020',
      codeBackground: '#0f0f0f',
      success: '#88c79a',
      warning: '#e0af68',
      danger: '#e17878',
      info: '#8eadd0'
    })
  },
  light: {
    name: 'Hive Light',
    description: 'Hive desktop light palette',
    colorScheme: 'light',
    palette: Object.freeze({
      background: '#faf9f5',
      surface: '#ffffff',
      sidebar: '#f4f3ee',
      input: '#ffffff',
      foreground: '#1f1e1c',
      muted: '#5a5955',
      subtle: '#8a8983',
      border: '#e4e2dc',
      borderStrong: '#c8c6bf',
      accent: '#c26647',
      accentHover: '#b15a3e',
      accentSoft: 'rgba(194, 102, 71, 0.09)',
      accentGlow: 'rgba(194, 102, 71, 0.22)',
      userBubble: '#eeece4',
      codeBackground: '#f4f3ee',
      success: '#6a9a3a',
      warning: '#b58e3a',
      danger: '#b94a48',
      info: '#477ca8'
    })
  },
  solarized: {
    name: 'Solarized Dark',
    description: 'Low-contrast Solarized palette',
    colorScheme: 'dark',
    palette: Object.freeze({
      background: '#002b36',
      surface: '#073642',
      sidebar: '#073642',
      input: '#002b36',
      foreground: '#839496',
      muted: '#93a1a1',
      subtle: '#586e75',
      border: '#073642',
      borderStrong: '#586e75',
      accent: '#b58900',
      accentHover: '#cb4b16',
      accentSoft: 'rgba(181, 137, 0, 0.15)',
      accentGlow: 'rgba(181, 137, 0, 0.35)',
      userBubble: '#073642',
      codeBackground: '#002b36',
      success: '#859900',
      warning: '#b58900',
      danger: '#dc322f',
      info: '#268bd2'
    })
  },
  nord: {
    name: 'Nord',
    description: 'Cool arctic blue palette',
    colorScheme: 'dark',
    palette: Object.freeze({
      background: '#2e3440',
      surface: '#3b4252',
      sidebar: '#2e3440',
      input: '#3b4252',
      foreground: '#d8dee9',
      muted: '#81a1c1',
      subtle: '#5e81ac',
      border: '#434c5e',
      borderStrong: '#4c566a',
      accent: '#88c0d0',
      accentHover: '#8fbcbb',
      accentSoft: 'rgba(136, 192, 208, 0.15)',
      accentGlow: 'rgba(136, 192, 208, 0.35)',
      userBubble: '#3b4252',
      codeBackground: '#2e3440',
      success: '#a3be8c',
      warning: '#ebcb8b',
      danger: '#bf616a',
      info: '#81a1c1'
    })
  },
  catppuccin: {
    name: 'Catppuccin',
    description: 'Catppuccin Mocha palette',
    colorScheme: 'dark',
    palette: Object.freeze({
      background: '#1e1e2e',
      surface: '#313244',
      sidebar: '#181825',
      input: '#313244',
      foreground: '#cdd6f4',
      muted: '#a6adc8',
      subtle: '#6c7086',
      border: '#45475a',
      borderStrong: '#585b70',
      accent: '#f38ba8',
      accentHover: '#fab387',
      accentSoft: 'rgba(243, 139, 168, 0.15)',
      accentGlow: 'rgba(243, 139, 168, 0.35)',
      userBubble: '#313244',
      codeBackground: '#1e1e2e',
      success: '#a6e3a1',
      warning: '#f9e2af',
      danger: '#f38ba8',
      info: '#89b4fa'
    })
  },
  gruvbox: {
    name: 'Gruvbox',
    description: 'Warm retro dark palette',
    colorScheme: 'dark',
    palette: Object.freeze({
      background: '#282828',
      surface: '#3c3836',
      sidebar: '#282828',
      input: '#3c3836',
      foreground: '#ebdbb2',
      muted: '#d5c4a1',
      subtle: '#a89984',
      border: '#504945',
      borderStrong: '#665c64',
      accent: '#b8bb26',
      accentHover: '#98971a',
      accentSoft: 'rgba(184, 187, 38, 0.15)',
      accentGlow: 'rgba(184, 187, 38, 0.35)',
      userBubble: '#3c3836',
      codeBackground: '#282828',
      success: '#b8bb26',
      warning: '#fabd2f',
      danger: '#fb4934',
      info: '#83a598'
    })
  }
};

function runtimeEnvironment(): TerminalThemeEnvironment {
  return typeof process === 'undefined'
    ? {}
    : (process.env as TerminalThemeEnvironment);
}

function normaliseThemeId(id: string | null | undefined): TerminalThemeId | undefined {
  if (!id) return undefined;
  const value = id.trim().toLowerCase();
  if (value === 'auto' || value === 'default') return 'system';
  if (value === 'hive-dark') return 'dark';
  if (value === 'hive-light') return 'light';
  return (TERMINAL_THEME_IDS as readonly string[]).includes(value)
    ? value as TerminalThemeId
    : undefined;
}

function systemUsesDarkPalette(environment: TerminalThemeEnvironment): boolean {
  if (typeof environment.prefersDark === 'boolean') return environment.prefersDark;

  const scheme = String(
    environment.HIVE_COLOR_SCHEME
      ?? environment.TERM_BACKGROUND
      ?? environment.COLOR_SCHEME
      ?? ''
  ).trim().toLowerCase();
  if (scheme === 'light' || scheme.includes('light')) return false;
  if (scheme === 'dark' || scheme.includes('dark')) return true;

  // COLORFGBG commonly ends in the terminal's ANSI background colour index.
  const backgroundIndex = Number.parseInt(String(environment.COLORFGBG ?? '').split(';').at(-1) ?? '', 10);
  if (Number.isFinite(backgroundIndex)) {
    return backgroundIndex <= 6 || backgroundIndex === 8;
  }

  // Hive is dark by default in terminal surfaces when the terminal gives no hint.
  return true;
}

function normaliseAccent(value: string | boolean | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : undefined;
}

function withAccent(palette: Readonly<TerminalPalette>, accent: string | undefined): Readonly<TerminalPalette> {
  if (!accent) return palette;
  const value = Number.parseInt(accent.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const darken = (channel: number): number => Math.max(0, Math.round(channel * 0.88));

  return Object.freeze({
    ...palette,
    accent,
    accentHover: `rgb(${darken(red)}, ${darken(green)}, ${darken(blue)})`,
    accentSoft: `rgba(${red}, ${green}, ${blue}, 0.12)`,
    accentGlow: `rgba(${red}, ${green}, ${blue}, 0.28)`
  });
}

/** Return display metadata in the same stable order used by `nextTheme`. */
export function listThemes(): readonly TerminalThemeOption[] {
  return OPTIONS;
}

/**
 * Resolve a configured theme to a concrete terminal palette. Invalid IDs and
 * invalid accent strings safely fall back to system/default theme values.
 */
export function resolveTheme(
  id?: TerminalThemeId | string | null,
  environment: TerminalThemeEnvironment = runtimeEnvironment()
): ResolvedTerminalTheme {
  const requestedId = normaliseThemeId(id) ?? normaliseThemeId(environment.HIVE_THEME) ?? 'system';
  const resolvedId: ResolvedTerminalThemeId = requestedId === 'system'
    ? (systemUsesDarkPalette(environment) ? 'dark' : 'light')
    : requestedId;
  const definition = DEFINITIONS[resolvedId];
  const option = OPTIONS.find((candidate) => candidate.id === requestedId)!;
  const accent = normaliseAccent(
    environment.accentColor
      ?? environment.HIVE_ACCENT_COLOR
      ?? environment.HIVE_ACCENT
  );

  return Object.freeze({
    ...option,
    resolvedId,
    colorScheme: definition.colorScheme,
    palette: withAccent(definition.palette, accent)
  });
}

/** Cycle theme IDs for a keyboard shortcut or `/theme next|previous`. */
export function nextTheme(
  current?: TerminalThemeId | string | null,
  direction: 1 | -1 = 1
): TerminalThemeId {
  const id = normaliseThemeId(current);
  if (!id) return TERMINAL_THEME_IDS[0];
  const index = TERMINAL_THEME_IDS.indexOf(id);
  return TERMINAL_THEME_IDS[(index + direction + TERMINAL_THEME_IDS.length) % TERMINAL_THEME_IDS.length];
}
