export class PermanentIngestError extends Error {
  public readonly isPermanent = true;

  constructor(message: string) {
    super(message);
    this.name = "PermanentIngestError";
    Error.captureStackTrace(this, this.constructor);
  }
}

export function isPermanentIngestError(error: unknown): error is PermanentIngestError {
  return error instanceof PermanentIngestError;
}
