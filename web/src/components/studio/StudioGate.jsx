import { useEffect, useState } from "react";
import { api } from "../../lib/api";

function MicrosoftMark() {
  // The four-square Microsoft logo, in its own colours -- brand guidelines for
  // "Sign in with Microsoft" require the mark be shown unaltered.
  return (
    <svg width="17" height="17" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export default function StudioGate({ onSignedIn }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [methods, setMethods] = useState(null);

  useEffect(() => {
    // A failed SSO round trip comes back as a query flag rather than a body,
    // because the callback is a redirect and has nowhere else to put it.
    if (new URLSearchParams(window.location.search).get("sso") === "failed") {
      setError("Microsoft sign-in did not complete. Try again, or use the password.");
    }
    api
      .authMethods()
      .then(setMethods)
      // If this call fails the studio is unreachable anyway; showing the
      // password form is the more useful guess.
      .catch(() => setMethods({ sso: false, password: true }));
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.login(password, name);
      onSignedIn(result.who);
    } catch (err) {
      setError(err.message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="card" onSubmit={submit}>
        <h2>Sales engineer studio</h2>
        <p className="card-sub">
          Clone an agent, give it your own instructions, and get a URL you can
          demo from.
        </p>

        {error && (
          <div className="notice" role="alert" style={{ marginBottom: "1.1rem" }}>
            {error}
          </div>
        )}

        {methods?.sso && (
          <>
            <a className="btn btn-primary btn-lg sso-btn" href="/api/studio/sso/start">
              <MicrosoftMark />
              Sign in with Microsoft
            </a>
            {methods.password && <div className="or-rule"><span>or</span></div>}
          </>
        )}

        {methods && !methods.password && !methods.sso && (
          <div className="notice" role="alert">
            No sign-in method is configured on this deployment.
          </div>
        )}

        {/* Rendered rather than hidden: a `required` input inside a hidden
            block still blocks submission, and the browser cannot focus an
            invisible field to explain why. */}
        {methods?.password && (
          <>
            <div className="field">
              <label htmlFor="studio-name">Your name</label>
              <input
                id="studio-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="So your agents are labelled"
                autoComplete="name"
              />
            </div>

            <div className="field">
              <label htmlFor="studio-password">Studio password</label>
              <input
                id="studio-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            <button
              className={methods.sso ? "btn" : "btn btn-primary"}
              type="submit"
              disabled={busy || !password}
            >
              {busy ? (
                <>
                  <span className="spinner" /> Checking
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
