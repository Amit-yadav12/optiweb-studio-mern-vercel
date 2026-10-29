/**
 * Client-side hand-off between the Asset Analyzer and the Image Optimizer.
 * In-memory only: it survives client-side navigation, never a page refresh, and
 * is deliberately not persisted anywhere.
 */
let pendingFile: File | null = null;

export function stageFileForOptimizer(file: File): void {
  pendingFile = file;
}

export function takeStagedFile(): File | null {
  const file = pendingFile;
  pendingFile = null;
  return file;
}
