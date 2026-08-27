import { Link, useLocation } from "react-router-dom";

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
