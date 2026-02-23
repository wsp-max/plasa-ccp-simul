import React from "react";
import type { AuthUser } from "../types/api";

type AuthPanelProps = {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  onLogin: (email: string, password: string) => Promise<void> | void;
  onRegister: (email: string, password: string) => Promise<void> | void;
  onLogout: () => Promise<void> | void;
};

const AuthPanel = ({ user, loading, error, onLogin, onRegister, onLogout }: AuthPanelProps) => {
  const [mode, setMode] = React.useState<"login" | "register">("login");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  if (user) {
    return (
      <section className="auth-panel">
        <div className="auth-panel-row">
          <strong>{user.email}</strong>
          <span className={`auth-role ${user.role === "admin" ? "admin" : ""}`}>{user.role}</span>
        </div>
        <p className="section-note">
          Compare access: {user.compare_access_enabled ? "Enabled" : "Locked"}
          {user.compare_access_expires_at ? ` | Exp: ${new Date(user.compare_access_expires_at).toLocaleString()}` : ""}
        </p>
        <button type="button" className="ghost-button" onClick={() => void onLogout()} disabled={loading}>
          {loading ? "Signing out..." : "Logout"}
        </button>
        {error ? <p className="status-error">Error: {error}</p> : null}
      </section>
    );
  }

  const submit = async () => {
    if (!email.trim() || !password.trim()) {
      return;
    }
    if (mode === "login") {
      await onLogin(email.trim(), password);
    } else {
      await onRegister(email.trim(), password);
    }
  };

  return (
    <section className="auth-panel">
      <div className="auth-tabs">
        <button
          type="button"
          className={`chip-button ${mode === "login" ? "chip-primary" : ""}`}
          onClick={() => setMode("login")}
          disabled={loading}
        >
          Login
        </button>
        <button
          type="button"
          className={`chip-button ${mode === "register" ? "chip-primary" : ""}`}
          onClick={() => setMode("register")}
          disabled={loading}
        >
          Register
        </button>
      </div>
      <label className="auth-field">
        <span>Email</span>
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={loading}
        />
      </label>
      <label className="auth-field">
        <span>Password</span>
        <input
          type="password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={loading}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void submit();
            }
          }}
        />
      </label>
      <button type="button" className="run-button" onClick={() => void submit()} disabled={loading}>
        {loading ? "Please wait..." : mode === "login" ? "Login" : "Create Account"}
      </button>
      {error ? <p className="status-error">Error: {error}</p> : null}
    </section>
  );
};

export default AuthPanel;
