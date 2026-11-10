/**
 * Mounts the real Image Optimizer screen, with the providers it needs, into a
 * container. `optimizer-dom-selftest.mjs` loads this file through Vite, so the
 * screen, the router and React all come from one module graph.
 */
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/ui/Feedback";
import { ImageOptimizer, type OptimizerLimits } from "@/features/images/ImageOptimizer";

export function mountImageOptimizer(container: HTMLElement, limits: OptimizerLimits): Root {
  const root = createRoot(container);
  root.render(
    <MemoryRouter>
      <ToastProvider>
        <ImageOptimizer limits={limits} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return root;
}
