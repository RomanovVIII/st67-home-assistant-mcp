export class BridgeError extends Error {
  constructor(readonly code: string, readonly resultUnknown = false) {
    super(code);
    this.name = 'BridgeError';
  }
}
