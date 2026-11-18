/**
 * Client-side hand-off between the Asset Analyzer and the Image Optimizer.
 * In-memory only: it survives client-side navigation, never a page refresh, and
 * is deliberately not persisted anywhere.
 */
let pendingFiles: File[] = [];

/** Hands one or more files to the Image Optimizer. They are added to its queue when it opens. */
export function stageFilesForOptimizer(files: File[]): void {
  pendingFiles = [...files];
}

export function stageFileForOptimizer(file: File): void {
  stageFilesForOptimizer([file]);
}

/** The staged files, once. A second call returns nothing. */
export function takeStagedFiles(): File[] {
  const files = pendingFiles;
  pendingFiles = [];
  return files;
}
