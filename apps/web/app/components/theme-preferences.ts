export const COLOR_THEME_STORAGE_KEY = "asuka-agent-color-theme";

export const colorThemes = ["classic", "asuka"] as const;

export type ColorTheme = (typeof colorThemes)[number];

export function parseColorTheme(value: string | null | undefined): ColorTheme {
  return value === "asuka" ? "asuka" : "classic";
}

export const colorThemeBootstrapScript = `try{var theme=localStorage.getItem("${COLOR_THEME_STORAGE_KEY}");document.documentElement.dataset.colorTheme=theme==="asuka"?"asuka":"classic"}catch(error){document.documentElement.dataset.colorTheme="classic"}`;
