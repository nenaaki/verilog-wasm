export class CompileError extends Error {
  constructor(message, line) {
    super(line != null && line >= 0 ? `${line} 行目: ${message}` : message);
    this.name = 'CompileError';
    this.line = line;
  }
}
