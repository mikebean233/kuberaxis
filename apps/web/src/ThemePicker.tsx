import { useState } from "react";

type Theme = "system" | "light" | "dark";

// index.html reads the same key before first paint, so a saved choice never flashes the other theme.
const STORAGE_KEY = "kuberaxis.theme";

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Light, dark, or follow the browser/OS setting (the default). */
export function ThemePicker() {
  const [theme, setTheme] = useState(savedTheme);

  const change = (next: Theme) => {
    setTheme(next);
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice still applies until reload.
    }
  };

  return (
    <label className="theme-picker">
      <span className="visually-hidden">Theme</span>
      <select value={theme} onChange={(e) => change(e.target.value as Theme)}>
        <option value="system">System theme</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
