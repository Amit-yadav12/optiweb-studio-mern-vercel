/**
 * Mounts the real Image Optimizer screen, with the providers it needs, into a
 * container. The DOM self-test loads this file through Vite, so the screen,
 * the router and React all come from one module graph.
 *
 * The screen is the app's own. Only the engine is the test's: it stands in for
 * the browser's decoder and encoders, which jsdom does not have.
 */
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/ui/Feedback";
import { ImageOptimizer, type ImageOptimizerProps } from "@/features/images/ImageOptimizer";

export function mountImageOptimizer(container: HTMLElement, props: ImageOptimizerProps): Root {
  const root = createRoot(container);
  root.render(
    <MemoryRouter>
      <ToastProvider>
        <ImageOptimizer {...props} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return root;
}
