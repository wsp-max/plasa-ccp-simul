import React from "react";
import type { AdminUser } from "../types/api";

type UserDraft = {
  role: "user" | "admin";
  compare_access_enabled: boolean;
  compare_access_expires_at: string;
};

type UpdatePayload = {
  role?: "user" | "admin";
  compare_access_enabled?: boolean;
  compare_access_expires_at?: string;
};

type AdminPageProps = {
  users: AdminUser[];
  loading: boolean;
  error: string | null;
  currentUserId: number | null;
  onRefresh: () => Promise<void> | void;
  onUpdateUser: (userId: number, payload: UpdatePayload) => Promise<void> | void;
};

const toInputDateTime = (isoValue?: string | null) => {
  if (!isoValue) {
    return "";
  }
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
};

const toIsoOrEmpty = (value: string) => {
  if (!value.trim()) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString();
};

const AdminPage = ({
  users,
  loading,
  error,
  currentUserId,
  onRefresh,
  onUpdateUser,
}: AdminPageProps) => {
  const [drafts, setDrafts] = React.useState<Record<number, UserDraft>>({});

  React.useEffect(() => {
    const nextDrafts: Record<number, UserDraft> = {};
    users.forEach((user) => {
      nextDrafts[user.id] = {
        role: user.role,
        compare_access_enabled: user.compare_access_granted,
        compare_access_expires_at: toInputDateTime(user.compare_access_expires_at),
      };
    });
    setDrafts(nextDrafts);
  }, [users]);

  const updateDraft = (userId: number, patch: Partial<UserDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [userId]: {
        ...(prev[userId] || {
          role: "user",
          compare_access_enabled: false,
          compare_access_expires_at: "",
        }),
        ...patch,
      },
    }));
  };

  const saveUser = async (user: AdminUser) => {
    const draft = drafts[user.id];
    if (!draft) {
      return;
    }

    const payload: UpdatePayload = {};
    if (draft.role !== user.role) {
      payload.role = draft.role;
    }
    if (draft.compare_access_enabled !== user.compare_access_granted) {
      payload.compare_access_enabled = draft.compare_access_enabled;
    }
    const nextIso = toIsoOrEmpty(draft.compare_access_expires_at);
    const currentIso = user.compare_access_expires_at || "";
    if (nextIso !== currentIso) {
      payload.compare_access_expires_at = nextIso;
    }

    if (Object.keys(payload).length === 0) {
      return;
    }
    await onUpdateUser(user.id, payload);
  };

  return (
    <section className="admin-page">
      <div className="admin-page-head">
        <h3>User Management</h3>
        <button type="button" className="ghost-button" onClick={() => void onRefresh()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      <p className="section-note">
        결제 상태/수동 권한을 계정 단위로 관리합니다. `compare_access_enabled`는 강제 권한 부여(수동)이고,
        Stripe 상태는 `subscription status`에 표시됩니다.
      </p>
      {error ? <p className="status-error">Error: {error}</p> : null}
      <div className="admin-user-list">
        {users.map((user) => {
          const draft = drafts[user.id];
          return (
            <article className="admin-user-card" key={`admin-user-${user.id}`}>
              <div className="admin-user-head">
                <strong>{user.email}</strong>
                <span>ID {user.id}</span>
              </div>
              <div className="admin-user-grid">
                <label className="auth-field">
                  <span>Role</span>
                  <select
                    value={draft?.role || user.role}
                    onChange={(event) =>
                      updateDraft(user.id, { role: event.target.value as "user" | "admin" })
                    }
                    disabled={loading}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                <label className="auth-field">
                  <span>Manual Compare Grant</span>
                  <input
                    type="checkbox"
                    checked={draft?.compare_access_enabled ?? user.compare_access_granted}
                    onChange={(event) =>
                      updateDraft(user.id, { compare_access_enabled: event.target.checked })
                    }
                    disabled={loading}
                  />
                </label>
                <label className="auth-field">
                  <span>Access Expire (local)</span>
                  <input
                    type="datetime-local"
                    value={draft?.compare_access_expires_at || ""}
                    onChange={(event) =>
                      updateDraft(user.id, { compare_access_expires_at: event.target.value })
                    }
                    disabled={loading}
                  />
                </label>
              </div>
              <p className="section-note">
                subscription status: {user.stripe_subscription_status || "none"} | effective access:{" "}
                {user.compare_access_enabled ? "enabled" : "locked"}
                {user.id === currentUserId ? " | current admin account" : ""}
              </p>
              <button type="button" className="run-button" onClick={() => void saveUser(user)} disabled={loading}>
                Save User
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
};

export default AdminPage;
