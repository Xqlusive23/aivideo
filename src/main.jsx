import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import "./inspiretech.css";
import LandingPage from "./LandingPage.jsx";
import App from "./App.jsx";
import CheckoutPage from "./CheckoutPage.jsx";
import LiveChatInit from "./LiveChatInit.jsx";

function isCompanionApp() {
  return typeof window !== "undefined" && Boolean(window.inspiretechCompanion?.isDesktop);
}

function LandingRoute() {
  if (isCompanionApp()) {
    return <Navigate to="/app" replace />;
  }
  return <LandingPage />;
}

function DefaultRedirect() {
  return <Navigate to={isCompanionApp() ? "/app" : "/"} replace />;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <HashRouter>
      <LiveChatInit />
      <Routes>
        <Route path="/" element={<LandingRoute />} />
        <Route path="/app" element={<App />} />
        <Route path="/pay" element={<CheckoutPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="*" element={<DefaultRedirect />} />
      </Routes>
    </HashRouter>
  </StrictMode>
);
