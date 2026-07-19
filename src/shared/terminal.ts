/* eslint-disable no-control-regex -- these expressions intentionally match terminal controls */
/** Remove terminal control sequences from untrusted text while preserving layout. */
export function sanitizeTerminalText(input: string): string {
  return input
    .replace(/\r\n?/gu, '\n')
    // OSC (titles, hyperlinks, clipboard), DCS/SOS/PM/APC, and CSI sequences.
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B[P_X^][\s\S]*?\u001B\\/gu, '')
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001B[@-_]/gu, '')
    // C0/C1 controls other than tab/newline, plus bidi overrides used for spoofing.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, '');
}
