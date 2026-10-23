// The running WOBD version, from js/version.js (the same source as the page footer).
// Read lazily: version.js loads after the app modules, so this can't be captured at import time.
export function wobdVersion() {
  return globalThis.WOBD_VERSION ?? null;
}

// "WOBD v1.71", or plain "WOBD" if the version script hasn't run.
export function versionLine() {
  const version = wobdVersion();
  return version ? `WOBD v${version}` : 'WOBD';
}

// The first line of a CSV recording, "# WOBD v1.71", or null if the version is unknown.
export function versionComment() {
  const version = wobdVersion();
  return version ? `# WOBD v${version}` : null;
}

// "WOBD v1.71" or "# WOBD v1.71" -> "1.71", or null.
export function parseVersionLine(line) {
  const match = /^\s*#?\s*WOBD\s+v(\d+(?:\.\d+)*)\s*$/i.exec(line ?? '');
  return match ? match[1] : null;
}
