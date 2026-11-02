export const SUPPORTED_NODE_VERSIONS = '^22.13.0 || >=24.0.0';

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 13) || major >= 24;
}
