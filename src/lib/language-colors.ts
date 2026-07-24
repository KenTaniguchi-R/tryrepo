// GitHub linguist colors for languages that appear in trending-repos.json.
export const LANGUAGE_COLORS: Record<string, string> = {
  Python: "#3572A5",
  TypeScript: "#3178c6",
  Rust: "#dea584",
  Go: "#00ADD8",
  Shell: "#89e051",
  CSS: "#563d7c",
};

export const DEFAULT_LANGUAGE_COLOR = "#8b8b8b";

export function languageColor(language: string): string {
  return LANGUAGE_COLORS[language] ?? DEFAULT_LANGUAGE_COLOR;
}
