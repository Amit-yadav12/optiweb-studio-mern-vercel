/**
 * Mounts the whole app, router included, into a container. The accessibility
 * audit loads this file through Vite and then moves from route to route.
 */
import { createRoot, type Root } from "react-dom/client";
import App from "@/App";

export function mountApp(container: HTMLElement): Root {
  const root = createRoot(container);
  root.render(<App />);
  return root;
}
