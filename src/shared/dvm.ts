export type DvmLintSeverity = 'error' | 'warning' | 'info';

export interface DvmLintFinding {
  severity: DvmLintSeverity;
  code: string;
  message: string;
  line?: number;
  functionName?: string;
}

export interface DvmLintResult {
  valid: boolean;
  functions: Array<{ name: string; line: number; visibility: 'public' | 'private' }>;
  findings: DvmLintFinding[];
}

interface ParsedFunction {
  name: string;
  line: number;
  visibility: 'public' | 'private';
  body: Array<{ sourceLine: number; basicLine?: number; text: string }>;
}

/** Conservative structural checks. This is not a compiler; simulator/daemon results remain authoritative. */
export function lintDvmBasic(source: string): DvmLintResult {
  const findings: DvmLintFinding[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const functions: ParsedFunction[] = [];
  let current: ParsedFunction | null = null;
  for (let index = 0; index < lines.length; index++) {
    const sourceLine = index + 1;
    const text = lines[index];
    const functionMatch = /^\s*Function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s+([A-Za-z][A-Za-z0-9_]*)\s*$/i.exec(text);
    if (functionMatch) {
      if (current) findings.push({ severity: 'error', code: 'NESTED_FUNCTION', message: `Function ${functionMatch[1]} begins before ${current.name} ends.`, line: sourceLine, functionName: current.name });
      const name = functionMatch[1];
      current = { name, line: sourceLine, visibility: /^[A-Z]/.test(name) ? 'public' : 'private', body: [] };
      functions.push(current);
      continue;
    }
    if (/^\s*End\s+Function\s*$/i.test(text)) {
      if (!current) findings.push({ severity: 'error', code: 'ORPHAN_END_FUNCTION', message: 'End Function has no matching Function declaration.', line: sourceLine });
      current = null;
      continue;
    }
    if (current) {
      const numbered = /^\s*(\d+)\s+(.+?)\s*$/.exec(text);
      current.body.push({ sourceLine, basicLine: numbered ? Number(numbered[1]) : undefined, text });
      if (text.trim() && !numbered && !isComment(text)) findings.push({ severity: 'warning', code: 'UNNUMBERED_STATEMENT', message: 'Executable DVM-BASIC statements should have a line number.', line: sourceLine, functionName: current.name });
    } else if (text.trim() && !isComment(text)) findings.push({ severity: 'warning', code: 'TOP_LEVEL_CONTENT', message: 'Content outside a Function is not part of a contract function.', line: sourceLine });
  }
  if (current) findings.push({ severity: 'error', code: 'UNTERMINATED_FUNCTION', message: `Function ${current.name} is missing End Function.`, line: current.line, functionName: current.name });
  if (!functions.length) findings.push({ severity: 'error', code: 'NO_FUNCTIONS', message: 'No DVM-BASIC functions were found.' });
  const initializers = functions.filter((fn) => /^(Initialize|InitializePrivate)$/i.test(fn.name));
  if (initializers.length !== 1) findings.push({ severity: 'error', code: 'INITIALIZER_COUNT', message: `Expected exactly one Initialize or InitializePrivate function; found ${initializers.length}.`, line: initializers[1]?.line ?? initializers[0]?.line });
  for (const fn of functions) lintFunction(fn, findings);
  lintStaticStorageKeys(functions, findings);
  lintStorageTypeConsistency(functions, findings);
  lintControlFlow(functions, findings);
  return { valid: !findings.some((finding) => finding.severity === 'error'), functions: functions.map((fn) => ({ name: fn.name, line: fn.line, visibility: fn.visibility })), findings: findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || severityRank(b.severity) - severityRank(a.severity)) };
}

function lintFunction(fn: ParsedFunction, findings: DvmLintFinding[]): void {
  const numbered = fn.body.filter((line): line is { sourceLine: number; basicLine: number; text: string } => line.basicLine !== undefined);
  const declaredLines = new Map<number, number>();
  let prior = -1;
  for (const line of numbered) {
    const existing = declaredLines.get(line.basicLine);
    if (existing) findings.push({ severity: 'error', code: 'DUPLICATE_LINE', message: `DVM line ${line.basicLine} duplicates source line ${existing}.`, line: line.sourceLine, functionName: fn.name });
    declaredLines.set(line.basicLine, line.sourceLine);
    if (line.basicLine <= prior) findings.push({ severity: 'warning', code: 'NON_MONOTONIC_LINES', message: `DVM line ${line.basicLine} is not greater than the preceding numbered line.`, line: line.sourceLine, functionName: fn.name });
    prior = line.basicLine;
    const target = /\bGOTO\s+(\d+)\b/i.exec(line.text)?.[1];
    if (target && !declaredLines.has(Number(target)) && !numbered.some((candidate) => candidate.basicLine === Number(target))) findings.push({ severity: 'error', code: 'MISSING_GOTO_TARGET', message: `GOTO target ${target} does not exist in ${fn.name}.`, line: line.sourceLine, functionName: fn.name });
  }
  const body = fn.body.map((line) => line.text).join('\n');
  const gotoTargets = new Set<number>();
  for (const line of numbered) {
    const target = /\bGOTO\s+(\d+)\b/i.exec(line.text)?.[1];
    if (target) gotoTargets.add(Number(target));
  }
  for (let index = 0; index < numbered.length - 1; index++) {
    const line = numbered[index];
    const next = numbered[index + 1];
    if (/\bRETURN\b/i.test(line.text) && !gotoTargets.has(next.basicLine)) {
      findings.push({ severity: 'warning', code: 'LIKELY_UNREACHABLE_LINE', message: `DVM line ${next.basicLine} follows RETURN and is not a GOTO target; verify that it is reachable.`, line: next.sourceLine, functionName: fn.name });
    }
  }
  if (!/\bRETURN\b/i.test(body)) findings.push({ severity: 'warning', code: 'MISSING_RETURN', message: 'Function has no RETURN statement.', line: fn.line, functionName: fn.name });
  if (/\bSEND_(?:DERO|ASSET)_TO_ADDRESS\b/i.test(body) && !/\bSIGNER\s*\(/i.test(body)) findings.push({ severity: 'warning', code: 'TRANSFER_WITHOUT_SIGNER', message: 'A transfer is present but this function has no visible SIGNER() authorization check.', line: fn.line, functionName: fn.name });
  if (/\bDEROVALUE\s*\(/i.test(body) && !/\b(?:IF|GOTO)\b/i.test(body)) findings.push({ severity: 'warning', code: 'UNGUARDED_DEROVALUE', message: 'DEROVALUE() is used without a visible conditional guard; verify the received amount is checked.', line: fn.line, functionName: fn.name });
  if (fn.visibility === 'public' && /^(Transfer|Withdraw|Claim)/i.test(fn.name) && !/\bSIGNER\s*\(/i.test(body)) findings.push({ severity: 'warning', code: 'PUBLIC_VALUE_PATH', message: `Public ${fn.name} has no visible SIGNER() check; verify it cannot move funds without authorization.`, line: fn.line, functionName: fn.name });
  if (fn.visibility === 'public' && /\b(?:SC_INVOKE|SC_DEPLOY|SC_UPGRADE)\b/i.test(body) && !/\bSIGNER\s*\(/i.test(body)) findings.push({ severity: 'warning', code: 'SC_OP_WITHOUT_SIGNER', message: `Public ${fn.name} performs contract operations without SIGNER() check.`, line: fn.line, functionName: fn.name });
}

function lintStaticStorageKeys(functions: ParsedFunction[], findings: DvmLintFinding[]): void {
  const stored = new Set<string>();
  const loads: Array<{ key: string; line: number; functionName: string }> = [];
  for (const fn of functions) {
    for (const line of fn.body) {
      const store = /\bSTORE\s*\(\s*"([^"]+)"/i.exec(line.text)?.[1];
      if (store) stored.add(store);
      const load = /\bLOAD\s*\(\s*"([^"]+)"/i.exec(line.text)?.[1];
      if (load) loads.push({ key: load, line: line.sourceLine, functionName: fn.name });
    }
  }
  for (const load of loads) {
    if (!stored.has(load.key)) findings.push({ severity: 'info', code: 'UNOBSERVED_STORAGE_KEY', message: `No literal STORE for key "${load.key}" was found in this source; verify it is initialized or intentionally external.`, line: load.line, functionName: load.functionName });
  }
}

function lintStorageTypeConsistency(functions: ParsedFunction[], findings: DvmLintFinding[]): void {
  const writes = new Map<string, { line: number; fn: string; numeric: boolean }[]>();
  const reads = new Map<string, { line: number; fn: string; numeric: boolean }[]>();
  for (const fn of functions) {
    for (const line of fn.body) {
      const storeKey = /\bSTORE\s*\(\s*"([^"]+)"\s*,\s*(.+?)\s*\)/i.exec(line.text);
      if (storeKey) {
        const [, key, valueExpr] = storeKey;
        const numeric = /^[0-9]+$/.test(valueExpr.trim()) || /\b(?:LOAD|ADD|SUB|MUL|DIV|MOD|INC|DEC)\s*\(/i.test(valueExpr);
        const list = writes.get(key) || [];
        list.push({ line: line.sourceLine, fn: fn.name, numeric });
        writes.set(key, list);
      }
      const loadKey = /\bLOAD\s*\(\s*"([^"]+)"/i.exec(line.text);
      if (loadKey) {
        const key = loadKey[1];
        const numeric = /\b(?:IF|WHILE|ADD|SUB|MUL|DIV|MOD|LET|SET|FOR)\b/i.test(line.text) || /\bLOAD\s*\(/.test(line.text);
        const list = reads.get(key) || [];
        list.push({ line: line.sourceLine, fn: fn.name, numeric });
        reads.set(key, list);
      }
    }
  }
  for (const [key, writeList] of writes) {
    const readList = reads.get(key) || [];
    const everNumericWrite = writeList.some(w => w.numeric);
    const everStringRead = readList.some(r => !r.numeric);
    if (everNumericWrite && everStringRead) {
      findings.push({ severity: 'warning', code: 'STORAGE_TYPE_INCONSISTENCY',
        message: `Key "${key}" is stored with numeric expressions but loaded in non-numeric context; verify type safety.`,
        line: writeList[0].line, functionName: writeList[0].fn });
    }
  }
  for (const [key, writeList] of writes) {
    if (!reads.has(key)) {
      findings.push({ severity: 'info', code: 'DEAD_STORAGE',
        message: `Key "${key}" is STOREd but never LOADed; verify it is used elsewhere or remove.`,
        line: writeList[0].line, functionName: writeList[0].fn });
    }
  }
  for (const fn of functions) {
    const fnWrites = new Set<string>();
    for (const line of fn.body) {
      const storeKey = /\bSTORE\s*\(\s*"([^"]+)"/i.exec(line.text);
      if (storeKey) fnWrites.add(storeKey[1]);
      const loadKey = /\bLOAD\s*\(\s*"([^"]+)"/i.exec(line.text);
      if (loadKey && !fnWrites.has(loadKey[1]) && !writes.has(loadKey[1])) {
        findings.push({ severity: 'warning', code: 'UNINITIALIZED_STORAGE_READ',
          message: `Key "${loadKey[1]}" is LOADed in ${fn.name} before any STORE in this source.`,
          line: line.sourceLine, functionName: fn.name });
      }
    }
  }
}

function lintControlFlow(functions: ParsedFunction[], findings: DvmLintFinding[]): void {
  for (const fn of functions) {
    const numbered = fn.body.filter(l => l.basicLine !== undefined) as { sourceLine: number; basicLine: number; text: string }[];
    for (const line of numbered) {
      const gotoTarget = /\bGOTO\s+(\d+)\b/i.exec(line.text)?.[1];
      if (gotoTarget && Number(gotoTarget) <= line.basicLine) {
        const betweenTargetAndHere = numbered.filter(
          l => l.basicLine >= Number(gotoTarget) && l.basicLine < line.basicLine
        );
        const hasConditionalBreak = betweenTargetAndHere.some(l => /\bIF\b/i.test(l.text) && /\bGOTO\b/i.test(l.text));
        if (!hasConditionalBreak) {
          findings.push({ severity: 'warning', code: 'POTENTIAL_INFINITE_LOOP',
            message: `GOTO ${gotoTarget} at line ${line.basicLine} jumps backward without a visible conditional break; verify loop termination.`,
            line: line.sourceLine, functionName: fn.name });
        }
      }
    }
    for (let i = 0; i < numbered.length - 1; i++) {
      const line = numbered[i];
      const next = numbered[i + 1];
      if (/\bGOTO\s+\d+\b/i.test(line.text) && !/IF\b/i.test(line.text)) {
        if (next.basicLine !== line.basicLine + 1) {
          findings.push({ severity: 'info', code: 'UNREACHABLE_AFTER_GOTO',
            message: `Line ${next.basicLine} follows an unconditional GOTO and may be unreachable unless it is a jump target.`,
            line: next.sourceLine, functionName: fn.name });
        }
      }
    }
  }
}

function isComment(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || trimmed.startsWith("'") || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.endsWith('*/');
}
function severityRank(severity: DvmLintSeverity): number { return severity === 'error' ? 3 : severity === 'warning' ? 2 : 1; }
