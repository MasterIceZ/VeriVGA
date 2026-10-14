// Ported verbatim from TinyTapeout/vga-playground @ 3e3c77e, src/github/loadProject.ts
// (extractReadmemPaths, extractIncludePaths).

export function extractReadmemPaths(sources: Record<string, string>): string[] {
  const paths = new Set<string>();
  const re = /\$readmem[hb]\s*\(\s*"([^"]+)"/g;
  for (const code of Object.values(sources)) {
    for (const match of code.matchAll(re)) {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

export function extractIncludePaths(sources: Record<string, string>): string[] {
  const paths = new Set<string>();
  const re = /`include\s+"([^"]+)"/g;
  for (const code of Object.values(sources)) {
    for (const match of code.matchAll(re)) {
      paths.add(match[1]);
    }
  }
  // Exclude files already present in sources
  for (const name of Object.keys(sources)) {
    paths.delete(name);
  }
  return [...paths];
}
