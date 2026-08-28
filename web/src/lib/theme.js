/**
 * Light/dark theme state.
 *
 * Three states, not two: "dark" and "light" are explicit choices stamped as
 * `data-theme` on <html>, and the absence of a stamp means "follow the OS",
 * which the stylesheet handles with prefers-color-scheme. The initial stamp is
 * applied by an inline script in index.html so it lands before first paint;
 * this module only handles changes made after the app has booted.
 */

const KEY = "eva-theme";

/** Reading storage throws in some private-browsing modes; never let that break the page. */
function read() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function write(value) {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* not fatal: the choice just will not survive a reload */
  }
}

/** What the viewer is actually looking at right now, stamp or OS. */
export function activeTheme() {
  const stamped = document.documentElement.getAttribute("data-theme");
  if (stamped === "light" || stamped === "dark") return stamped;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  write(theme);

  // Keep the browser chrome in step with the page, otherwise mobile Safari and
  // Chrome keep painting the old colour behind the address bar.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg")
      .trim();
    if (bg) meta.setAttribute("content", bg);
  }
}

export function toggleTheme() {
  const next = activeTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}

/** True when the viewer has never chosen, so we are following the OS. */
export function followsSystem() {
  return read() === null;
}

/**
 * Style props for an agent's accent colour.
 *
 * `--on-accent` is the readable ink for text sitting *on* the accent, chosen by
 * the accent's own luminance rather than by the theme. That distinction matters:
 * a mid-dark accent like the brand violet wants white on it even on the dark
 * theme, while Bright Blue and Yellow want near-black. Picking by theme instead
 * is what forced the accents to be lightened for contrast, which is exactly the
 * washed-out look we are undoing.
 */
export function accentVars(hex) {
  return { "--accent": hex, "--on-accent": readableInk(hex) };
}

/** WCAG relative luminance, then whichever of ink/paper contrasts better. */
function readableInk(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return "#060b18";
  const channel = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L =
    0.2126 * channel(h.slice(0, 2)) +
    0.7152 * channel(h.slice(2, 4)) +
    0.0722 * channel(h.slice(4, 6));
  // Contrast against near-black vs against near-white, and take the winner.
  const vsDark = (L + 0.05) / (0.0055 + 0.05);
  const vsLight = (0.973 + 0.05) / (L + 0.05);
  return vsDark >= vsLight ? "#060b18" : "#f8faf9";
}
