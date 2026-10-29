import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "@/components/ui/Feedback";
import LandingPage from "@/pages/LandingPage";
import {
  AssetsPage,
  AuditPage,
  FontsPage,
  HistoryDetailPage,
  HistoryPage,
  ImagePage,
  NotFoundPage,
  OverviewPage,
  SettingsPage,
} from "@/pages/WorkspacePages";
import "@/styles.css";

function App() {
  return <BrowserRouter><ToastProvider><Routes>
    <Route path="/" element={<LandingPage />} />
    <Route path="/app" element={<OverviewPage />} />
    <Route path="/app/images" element={<ImagePage />} />
    <Route path="/app/fonts" element={<FontsPage />} />
    <Route path="/app/assets" element={<AssetsPage />} />
    <Route path="/app/audit" element={<AuditPage />} />
    <Route path="/app/history" element={<HistoryPage />} />
    <Route path="/app/history/:id" element={<HistoryDetailPage />} />
    <Route path="/app/settings" element={<SettingsPage />} />
    <Route path="/404" element={<NotFoundPage />} />
    <Route path="*" element={<Navigate to="/404" replace />} />
  </Routes></ToastProvider></BrowserRouter>;
}

const root = document.getElementById("root");
if (!root) throw new Error("The application root element was not found.");
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
