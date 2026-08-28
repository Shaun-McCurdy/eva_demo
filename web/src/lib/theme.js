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
