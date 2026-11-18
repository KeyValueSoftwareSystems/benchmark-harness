const KEY = "smithy-theme";

/** A saved choice wins; anything else follows the system setting. */
export const resolveTheme = (saved, prefersDark) => (saved === "light" || saved === "dark" ? saved : prefersDark ? "dark" : "light");
export const nextTheme = (current) => (current === "dark" ? "light" : "dark");

/** The only thing this page stores in the browser: the theme name. Storage can be blocked, so every access is guarded. */
export const loadTheme = () => {
	let saved = null;
	try {
		saved = localStorage.getItem(KEY);
	} catch {}
	return resolveTheme(saved, matchMedia("(prefers-color-scheme: dark)").matches);
};
export const saveTheme = (theme) => {
	try {
		localStorage.setItem(KEY, theme);
	} catch {}
};
export const applyTheme = (theme) => document.documentElement.setAttribute("data-theme", theme);
