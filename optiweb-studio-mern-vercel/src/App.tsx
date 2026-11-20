import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "@/components/ui/Feedback";
import LandingPage from "@/pages/LandingPage";

// The workspace is loaded when it is first opened, so the landing page stays small.
const workspace = () => import("@/pages/WorkspacePages");
const OverviewPage = lazy(() => workspace().then((module) => ({ default: module.OverviewPage })));
const ImagePage = lazy(() => workspace().then((module) => ({ default: module.ImagePage })));
const FontsPage = lazy(() => workspace().then((module) => ({ default: module.FontsPage })));
const AssetsPage = lazy(() => workspace().then((module) => ({ default: module.AssetsPage })));
const AuditPage = lazy(() => workspace().then((module) => ({ default: module.AuditPage })));
const SettingsPage = lazy(() => workspace().then((module) => ({ default: module.SettingsPage })));
const RetiredPage = lazy(() => workspace().then((module) => ({ default: module.RetiredPage })));
const NotFoundPage = lazy(() => workspace().then((module) => ({ default: module.NotFoundPage })));

function Loading() {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas" role="status" aria-live="polite">
      <p className="font-mono text-xs tracking-[0.14em] text-muted uppercase">Loading…</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/app" element={<OverviewPage />} />
            <Route path="/app/images" element={<ImagePage />} />
            <Route path="/app/fonts" element={<FontsPage />} />
            <Route path="/app/assets" element={<AssetsPage />} />
            <Route path="/app/audit" element={<AuditPage />} />
            <Route path="/app/settings" element={<SettingsPage />} />
            {/* Pages of earlier versions, which listed records kept on a server. */}
            <Route path="/app/history" element={<RetiredPage title="History" />} />
            <Route path="/app/history/:id" element={<RetiredPage title="History" />} />
            <Route path="/app/usage" element={<RetiredPage title="Storage" />} />
            <Route path="/404" element={<NotFoundPage />} />
            <Route path="*" element={<Navigate to="/404" replace />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  );
}
