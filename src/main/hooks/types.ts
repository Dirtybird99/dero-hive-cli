// Lifecycle hooks let a user observe and gate tool calls with external commands,
// analogous to Claude Code / Grok Build hooks. A hook runs a shell command,
// receiving a JSON payload on stdin, and (for preToolUse) may allow or deny the call.

export type HookEvent = 'preToolUse' | 'postToolUse';

export interface HookDefinition {
  /** Which lifecycle point this hook fires on. */
  event: HookEvent;
  /**
   * Optional tool-name filter. A `/regex/` literal is matched as a RegExp;
   * any other string is matched as a substring. Omitted = every tool.
   */
  toolPattern?: string;
  /** Shell command to run. Receives the JSON payload on stdin. */
  command: string;
  /** Per-hook timeout in ms (default 5000). */
  timeoutMs?: number;
  /**
   * Fail-closed switch. By default a hook that errors or times out is ignored
   * (fail-open, matching Claude/Grok). When `blocking` is true, such a failure
   * blocks the tool call instead.
   */
  blocking?: boolean;
}

/** A preToolUse hook may emit this JSON on stdout to decide the call. */
export interface HookDecision {
  decision?: 'allow' | 'deny';
  feedback?: string;
}

/** Minimal execution context passed into the payload (kept decoupled from ToolContext). */
export interface HookContext {
  cwd?: string;
  conversationId?: string;
}
