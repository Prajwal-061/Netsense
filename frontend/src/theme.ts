// Dark is the default; the choice is remembered in this browser only.

export type Theme = 'dark' | 'light'

const KEY = 'netsense-theme'

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Storage blocked (private window): the theme still applies until reload.
  }
}
