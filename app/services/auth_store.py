"""SQLite-backed authentication and user management helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import secrets
import sqlite3
from typing import Any


ALLOWED_ROLES = {"user", "admin"}
PASSWORD_HASH_SCHEME = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 210_000


def utc_now() -> datetime:
    return datetime.now(tz=timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def parse_utc_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _connect(db_path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _column_names(connection: sqlite3.Connection, table_name: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row["name"]) for row in rows}


def init_auth_db(db_path: str) -> None:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                compare_access_enabled INTEGER NOT NULL DEFAULT 0,
                compare_access_expires_at TEXT,
                stripe_customer_id TEXT,
                stripe_subscription_id TEXT,
                stripe_subscription_status TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_subscription_id ON users(stripe_subscription_id);
            """
        )

        user_columns = _column_names(connection, "users")
        required_user_columns = {
            "compare_access_enabled": "INTEGER NOT NULL DEFAULT 0",
            "compare_access_expires_at": "TEXT",
            "stripe_customer_id": "TEXT",
            "stripe_subscription_id": "TEXT",
            "stripe_subscription_status": "TEXT",
            "role": "TEXT NOT NULL DEFAULT 'user'",
            "updated_at": "TEXT",
        }
        for column_name, column_ddl in required_user_columns.items():
            if column_name not in user_columns:
                connection.execute(f"ALTER TABLE users ADD COLUMN {column_name} {column_ddl}")

        session_columns = _column_names(connection, "sessions")
        required_session_columns = {
            "last_seen_at": "TEXT",
            "expires_at": "TEXT",
        }
        for column_name, column_ddl in required_session_columns.items():
            if column_name not in session_columns:
                connection.execute(f"ALTER TABLE sessions ADD COLUMN {column_name} {column_ddl}")


def _hash_password(password: str, salt_hex: str | None = None) -> str:
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    )
    return f"{PASSWORD_HASH_SCHEME}${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def _verify_password(password: str, encoded_hash: str) -> bool:
    parts = encoded_hash.split("$")
    if len(parts) != 4:
        return False
    scheme, iteration_text, salt_hex, digest_hex = parts
    if scheme != PASSWORD_HASH_SCHEME:
        return False
    try:
        iterations = int(iteration_text)
        salt = bytes.fromhex(salt_hex)
    except (ValueError, TypeError):
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations).hex()
    return secrets.compare_digest(digest, digest_hex)


def _session_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _is_compare_access_active(raw_enabled: bool, expires_at: str | None) -> bool:
    if not raw_enabled:
        return False
    if not expires_at:
        return True
    expires_dt = parse_utc_iso(expires_at)
    if expires_dt is None:
        return False
    return expires_dt > utc_now()


def _user_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    raw_enabled = bool(row["compare_access_enabled"])
    expires_at = row["compare_access_expires_at"] if isinstance(row["compare_access_expires_at"], str) else None
    return {
        "id": int(row["id"]),
        "email": str(row["email"]),
        "role": str(row["role"] or "user"),
        "compare_access_granted": raw_enabled,
        "compare_access_enabled": _is_compare_access_active(raw_enabled, expires_at),
        "compare_access_expires_at": expires_at,
        "stripe_customer_id": row["stripe_customer_id"] if isinstance(row["stripe_customer_id"], str) else None,
        "stripe_subscription_id": row["stripe_subscription_id"] if isinstance(row["stripe_subscription_id"], str) else None,
        "stripe_subscription_status": row["stripe_subscription_status"]
        if isinstance(row["stripe_subscription_status"], str)
        else None,
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def _require_valid_email(email: str) -> str:
    normalized = _normalize_email(email)
    if len(normalized) < 5 or "@" not in normalized or "." not in normalized.split("@")[-1]:
        raise ValueError("A valid email address is required.")
    return normalized


def _require_valid_password(password: str) -> str:
    trimmed = password.strip()
    if len(trimmed) < 8:
        raise ValueError("Password must be at least 8 characters.")
    if len(trimmed) > 256:
        raise ValueError("Password is too long.")
    return trimmed


def get_user_by_id(db_path: str, user_id: int) -> dict[str, Any] | None:
    with _connect(db_path) as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return None
    return _user_row_to_dict(row)


def get_user_by_email(db_path: str, email: str) -> dict[str, Any] | None:
    normalized = _normalize_email(email)
    with _connect(db_path) as connection:
        row = connection.execute("SELECT * FROM users WHERE email = ?", (normalized,)).fetchone()
    if row is None:
        return None
    return _user_row_to_dict(row)


def _get_user_row_by_email(connection: sqlite3.Connection, email: str) -> sqlite3.Row | None:
    return connection.execute("SELECT * FROM users WHERE email = ?", (_normalize_email(email),)).fetchone()


def create_user(db_path: str, email: str, password: str, role: str = "user") -> dict[str, Any]:
    normalized_email = _require_valid_email(email)
    normalized_password = _require_valid_password(password)
    normalized_role = role.strip().lower()
    if normalized_role not in ALLOWED_ROLES:
        raise ValueError("Role must be 'user' or 'admin'.")

    now_iso = utc_now_iso()
    password_hash = _hash_password(normalized_password)
    with _connect(db_path) as connection:
        if _get_user_row_by_email(connection, normalized_email) is not None:
            raise ValueError("Email already exists.")
        cursor = connection.execute(
            """
            INSERT INTO users (
                email,
                password_hash,
                role,
                compare_access_enabled,
                compare_access_expires_at,
                stripe_customer_id,
                stripe_subscription_id,
                stripe_subscription_status,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)
            """,
            (normalized_email, password_hash, normalized_role, now_iso, now_iso),
        )
        user_id = int(cursor.lastrowid)
    user = get_user_by_id(db_path, user_id)
    if user is None:
        raise RuntimeError("Created user could not be loaded.")
    return user


def bootstrap_admin_user(db_path: str, email: str, password: str) -> dict[str, Any] | None:
    normalized_email = _normalize_email(email)
    normalized_password = password.strip()
    if not normalized_email or not normalized_password:
        return None

    try:
        _require_valid_email(normalized_email)
        _require_valid_password(normalized_password)
    except ValueError:
        return None

    existing = get_user_by_email(db_path, normalized_email)
    if existing is not None:
        if existing["role"] == "admin":
            return existing
        return admin_update_user(db_path, int(existing["id"]), role="admin")
    return create_user(db_path, normalized_email, normalized_password, role="admin")


def authenticate_user(db_path: str, email: str, password: str) -> dict[str, Any] | None:
    normalized_email = _normalize_email(email)
    with _connect(db_path) as connection:
        row = connection.execute("SELECT * FROM users WHERE email = ?", (normalized_email,)).fetchone()
    if row is None:
        return None
    password_hash = str(row["password_hash"])
    if not _verify_password(password, password_hash):
        return None
    return _user_row_to_dict(row)


def create_session(db_path: str, user_id: int, session_days: int) -> tuple[str, str]:
    token = secrets.token_urlsafe(48)
    token_hash = _session_hash(token)
    created_at = utc_now()
    expires_at = created_at + timedelta(days=max(1, session_days))
    created_at_iso = created_at.isoformat()
    expires_at_iso = expires_at.isoformat()
    with _connect(db_path) as connection:
        connection.execute(
            """
            INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (user_id, token_hash, created_at_iso, created_at_iso, expires_at_iso),
        )
    return token, expires_at_iso


def delete_session(db_path: str, token: str) -> None:
    token_hash = _session_hash(token)
    with _connect(db_path) as connection:
        connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


def get_user_by_session_token(db_path: str, token: str) -> dict[str, Any] | None:
    token_hash = _session_hash(token)
    with _connect(db_path) as connection:
        row = connection.execute(
            """
            SELECT u.*, s.id AS session_id, s.expires_at AS session_expires_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()

        if row is None:
            return None

        expires_at = parse_utc_iso(row["session_expires_at"])
        if expires_at is None or expires_at <= utc_now():
            connection.execute("DELETE FROM sessions WHERE id = ?", (row["session_id"],))
            return None

        connection.execute("UPDATE sessions SET last_seen_at = ? WHERE id = ?", (utc_now_iso(), row["session_id"]))
    return _user_row_to_dict(row)


def list_users(db_path: str) -> list[dict[str, Any]]:
    with _connect(db_path) as connection:
        rows = connection.execute("SELECT * FROM users ORDER BY created_at DESC, id DESC").fetchall()
    return [_user_row_to_dict(row) for row in rows]


def admin_update_user(
    db_path: str,
    user_id: int,
    *,
    role: str | None = None,
    compare_access_enabled: bool | None = None,
    compare_access_expires_at: str | None = None,
) -> dict[str, Any]:
    patches: list[str] = []
    values: list[Any] = []

    if role is not None:
        normalized_role = role.strip().lower()
        if normalized_role not in ALLOWED_ROLES:
            raise ValueError("Role must be 'user' or 'admin'.")
        patches.append("role = ?")
        values.append(normalized_role)

    if compare_access_enabled is not None:
        patches.append("compare_access_enabled = ?")
        values.append(1 if compare_access_enabled else 0)

    if compare_access_expires_at is not None:
        normalized_expires: str | None
        trimmed = compare_access_expires_at.strip()
        if trimmed == "":
            normalized_expires = None
        else:
            parsed = parse_utc_iso(trimmed)
            if parsed is None:
                raise ValueError("compare_access_expires_at must be an ISO-8601 datetime or empty.")
            normalized_expires = parsed.isoformat()
        patches.append("compare_access_expires_at = ?")
        values.append(normalized_expires)

    if not patches:
        user = get_user_by_id(db_path, user_id)
        if user is None:
            raise ValueError("User not found.")
        return user

    patches.append("updated_at = ?")
    values.append(utc_now_iso())
    values.append(user_id)
    with _connect(db_path) as connection:
        cursor = connection.execute(f"UPDATE users SET {', '.join(patches)} WHERE id = ?", tuple(values))
        if cursor.rowcount == 0:
            raise ValueError("User not found.")

    user = get_user_by_id(db_path, user_id)
    if user is None:
        raise RuntimeError("Updated user could not be loaded.")
    return user


def update_user_billing(
    db_path: str,
    user_id: int,
    *,
    stripe_customer_id: str | None = None,
    stripe_subscription_id: str | None = None,
    stripe_subscription_status: str | None = None,
    compare_access_enabled: bool | None = None,
    compare_access_expires_at: str | None = None,
) -> dict[str, Any]:
    patches: list[str] = []
    values: list[Any] = []

    if stripe_customer_id is not None:
        patches.append("stripe_customer_id = ?")
        values.append(stripe_customer_id.strip() or None)

    if stripe_subscription_id is not None:
        patches.append("stripe_subscription_id = ?")
        values.append(stripe_subscription_id.strip() or None)

    if stripe_subscription_status is not None:
        patches.append("stripe_subscription_status = ?")
        values.append(stripe_subscription_status.strip() or None)

    if compare_access_enabled is not None:
        patches.append("compare_access_enabled = ?")
        values.append(1 if compare_access_enabled else 0)

    if compare_access_expires_at is not None:
        trimmed = compare_access_expires_at.strip()
        if trimmed:
            parsed = parse_utc_iso(trimmed)
            if parsed is None:
                raise ValueError("compare_access_expires_at must be an ISO-8601 datetime.")
            values.append(parsed.isoformat())
        else:
            values.append(None)
        patches.append("compare_access_expires_at = ?")

    if not patches:
        user = get_user_by_id(db_path, user_id)
        if user is None:
            raise ValueError("User not found.")
        return user

    patches.append("updated_at = ?")
    values.append(utc_now_iso())
    values.append(user_id)
    with _connect(db_path) as connection:
        cursor = connection.execute(f"UPDATE users SET {', '.join(patches)} WHERE id = ?", tuple(values))
        if cursor.rowcount == 0:
            raise ValueError("User not found.")

    user = get_user_by_id(db_path, user_id)
    if user is None:
        raise RuntimeError("Updated user could not be loaded.")
    return user


def get_user_by_stripe_customer_id(db_path: str, stripe_customer_id: str) -> dict[str, Any] | None:
    normalized = stripe_customer_id.strip()
    if not normalized:
        return None
    with _connect(db_path) as connection:
        row = connection.execute("SELECT * FROM users WHERE stripe_customer_id = ?", (normalized,)).fetchone()
    if row is None:
        return None
    return _user_row_to_dict(row)
