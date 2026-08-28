import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { activeTheme, followsSystem, toggleTheme } from "../lib/theme";

export function SiteHeader() {
  const { pathname } = useLocation();
  const inStudio = pathname.startsWith("/studio");

  return (
    <header className="site-header">
      <div className="shell">
        <Link to="/" className="brand">
          <span className="brand-mark">EVA</span>
          <span>
            Enghouse Virtual Agent{" "}
            <span className="brand-sub">· live demo</span>
          </span>
        </Link>
        <nav className="header-nav">
          <ThemeToggle />
          {pathname !== "/" && (
            <Link className="btn btn-ghost btn-sm" to="/">
              All agents
            </Link>
          )}
          {!inStudio && (
            <Link className="btn btn-ghost btn-sm" to="/studio">
              Studio
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" strokeLinejoin="round" />
    </svg>
  );
}

function ThemeToggle() {
  // Starts as null and is filled in after mount, because until then the true
  // answer depends on an OS media query the server never saw.
  const [theme, setTheme] = useState(null);

  useEffect(() => {
    setTheme(activeTheme());

    // While the viewer has made no explicit choice we are following the OS, so
    // track it if they change it mid-session.
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (followsSystem()) setTheme(activeTheme());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  if (!theme) return null;

  const goingTo = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm theme-toggle"
      onClick={() => setTheme(toggleTheme())}
      aria-label={`Switch to ${goingTo} theme`}
      title={`Switch to ${goingTo} theme`}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell">
        <span>
          A demonstration of the Enghouse Virtual Agent. Scenarios and companies
          shown are fictional.
        </span>
        <Link to="/studio">Sales engineer studio</Link>
      </div>
    </footer>
  );
}
