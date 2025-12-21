export class EmulatorResult {
  errors: string[] = [];
  warnings: string[] = [];
  printMessages: string[] = [];

  constructor(init?: Partial<EmulatorResult>) {
    Object.assign(this, init);
  }
  add(result: EmulatorResult): EmulatorResult
  {
    this.errors = this.errors.concat(result.errors);
    this.warnings = this.warnings.concat(result.warnings);
    this.printMessages = this.printMessages.concat(result.printMessages);
    return this;
  }
  addError(error: string): EmulatorResult
  {
    this.errors.push(error);
    return this;
  }
  addWarning(warning: string): EmulatorResult
  {
    this.warnings.push(warning);
    return this;
  }
  addPrintMessage(message: string): EmulatorResult
  {
    this.printMessages.push(message);
    return this;
  }
  get success(): boolean {
    return this.errors.length === 0;
  }
};