import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./index.css";
import { ThemeProvider } from "@/lib/theme";
import App from "./App.jsx";

// Applied before React mounts so a dark-mode user never sees a white flash.
try { const t = localStorage.getItem("outreach.theme") || "system"; document.documentElement.classList.toggle("dark", t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)); } catch { /* falls back to light until the provider runs */ }

createRoot(document.getElementById("root")).render(<ThemeProvider><App /></ThemeProvider>);
