import { useState } from "react";
import { api } from "../../lib/api";

export default function StudioGate({ onSignedIn }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
          demo from. You'll need the shared studio password.
        </p>

        {error && (
          <div className="notice" role="alert" style={{ marginBottom: "1.1rem" }}>
            {error}
          </div>
        )}

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

        <button className="btn btn-primary" type="submit" disabled={busy || !password}>
          {busy ? (
            <>
              <span className="spinner" /> Checking
            </>
          ) : (
            "Sign in"
          )}
        </button>
      </form>
    </div>
  );
}
