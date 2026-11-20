import { useEffect, useState } from "react";

/**
 * A `blob:` URL for a Blob, for as long as the component shows it. The URL is
 * released when the Blob changes or the component goes away, so a preview
 * never outlives its place on the page.
 */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  return url;
}
