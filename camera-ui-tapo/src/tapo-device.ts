export function isTapoDoorbellModel(model?: string): boolean {
  return /\bD\d{3,4}[A-Z]*\b/i.test(model?.trim() ?? '');
}

export function isTapoDiscoveryIdentity(name?: string, hardware?: string): boolean {
  const identity = `${name ?? ''} ${hardware ?? ''}`.trim();
  if (/\b(?:tapo|tp[ -]?link)\b/i.test(identity)) return true;

  // Tapo WS-Discovery commonly exposes only its model, without a manufacturer.
  return /^(?:TC\d{2,4}[A-Z]*|C\d{2,4}[A-Z]*|D\d{2,4}[A-Z]*)\b/i.test(hardware?.trim() ?? '');
}
