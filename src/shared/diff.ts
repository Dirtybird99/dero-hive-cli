// Line-based unified diff. Used by the renderer's activity log to show file
// edits in the same terminal style as `git diff` / claude-code / opencode.
//
// Algorithm: classic LCS-based diff over lines. The implementation is short
// enough to drop in here rather than pulling in the `diff` npm package — we
// only need line granularity and we don't need to handle binary files.

export type DiffOp = 'context' | 'add' | 'del';

export interface DiffLine {
  op: DiffOp;
  /** Line number in the old file (undefined for additions). */
  oldLineNo?: number;
  /** Line number in the new file (undefined for deletions). */
  newLineNo?: number;
  text: string;
}

/**
 * Compute a line-by-line diff between two pieces of text.
 *
 * `oldStart` / `newStart` (1-based) let callers anchor the diff to a real
 * position in the source file so the line numbers shown in the UI match the
 * real file. Use 1 when the inputs are the full files.
 */
export function diffLines(oldText: string, newText: string, opts: { oldStart?: number; newStart?: number } = {}): DiffLine[] {
  const oldStart = Math.max(1, opts.oldStart ?? 1);
  const newStart = Math.max(1, opts.newStart ?? 1);

  // Split on \n but keep empty trailing line semantics (file ending in \n
  // produces an empty final element). Skip the trailing empty so the diff
  // doesn't show a phantom blank line.
  const split = (s: string): string[] => {
    const lines = s.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  const a = split(oldText);
  const b = split(newText);
  const m = a.length;
  const n = b.length;

  // LCS length table — (m+1) × (n+1). For typical model edits this is small
  // (a handful of context lines on each side). For very large files the
  // table grows quadratically; we cap inputs above so the diff stays snappy.
  const CAP = 4000;
  if (m > CAP || n > CAP) {
    // Fallback: skip the LCS and emit the whole new file as additions and
    // the whole old file as deletions. Less helpful but bounded.
    const out: DiffLine[] = [];
    for (let i = 0; i < m; i++) out.push({ op: 'del', oldLineNo: oldStart + i, text: a[i] });
    for (let j = 0; j < n; j++) out.push({ op: 'add', newLineNo: newStart + j, text: b[j] });
    return out;
  }

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: 'context', oldLineNo: oldStart + i, newLineNo: newStart + j, text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'del', oldLineNo: oldStart + i, text: a[i] });
      i++;
    } else {
      out.push({ op: 'add', newLineNo: newStart + j, text: b[j] });
      j++;
    }
  }
  while (i < m) {
    out.push({ op: 'del', oldLineNo: oldStart + i, text: a[i] });
    i++;
  }
  while (j < n) {
    out.push({ op: 'add', newLineNo: newStart + j, text: b[j] });
    j++;
  }
  return out;
}

/** Total +/− line counts from a diff. */
export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === 'add') added++;
    else if (l.op === 'del') removed++;
  }
  return { added, removed };
}

/**
 * Coalesce a diff down to "interesting" hunks. Lines that are pure context
 * far from any change are dropped; nearby context is kept so the reader can
 * see what surrounds the change. Matches the look of `git diff -U3`.
 */
export function collapseContext(lines: DiffLine[], context = 3): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.op !== 'context') {
      // Walk back to capture leading context lines (already in `out`).
      // Walk forward to capture the trailing context.
      let j = i;
      while (j < lines.length && lines[j].op !== 'context') j++;
      const trailingEnd = Math.min(lines.length, j + context);
      for (let k = i; k < trailingEnd; k++) out.push(lines[k]);
      i = trailingEnd;
      // Add a separator between hunks if there's still more diff content.
      if (i < lines.length) {
        out.push({ op: 'context', text: '⋮' });
      }
    } else {
      i++;
    }
  }
  return out;
}