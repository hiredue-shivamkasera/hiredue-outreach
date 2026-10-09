// The light/dark/system choice: stored in localStorage, applied as the "dark" class on <html>, and followed live when set to system.
import { createContext, useContext, useEffect, useState } from "react";

const KEY = "outreach.theme";
const ThemeContext = createContext({ theme: "system", resolved: "light", setTheme: () => {} });
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function stored() {
  try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; }
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(stored);
  const [dark, setDark] = useState(() => (theme === "system" ? systemDark() : theme === "dark"));

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setDark(theme === "system" ? media.matches : theme === "dark");
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => { document.documentElement.classList.toggle("dark", dark); document.documentElement.style.colorScheme = dark ? "dark" : "light"; }, [dark]);

  const setTheme = (t) => {
    try { localStorage.setItem(KEY, t); } catch { /* private storage only loses the preference, not the theme */ }
    setThemeState(t);
  };
  return <ThemeContext.Provider value={{ theme, resolved: dark ? "dark" : "light", setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
