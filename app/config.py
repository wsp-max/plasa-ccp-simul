"""App configuration for storage and response sizing."""

from __future__ import annotations

from dataclasses import dataclass
import os
import tempfile


@dataclass(frozen=True)
class Settings:
    """Runtime settings loaded from environment variables."""

    s3_bucket: str
    s3_prefix: str
    inline_max_bytes: int
    presign_expiry_seconds: int
    local_storage_dir: str
    stripe_secret_key: str
    stripe_compare_price_id: str
    compare_monthly_price_cents: int
    auth_db_path: str
    auth_session_days: int
    auth_cookie_name: str
    auth_cookie_secure: bool
    admin_bootstrap_email: str
    admin_bootstrap_password: str


    @staticmethod
    def from_env() -> "Settings":
        """Create settings from environment variables with defaults."""
        def to_bool(value: str | None, default: bool) -> bool:
            if value is None:
                return default
            normalized = value.strip().lower()
            if normalized in {"1", "true", "yes", "on"}:
                return True
            if normalized in {"0", "false", "no", "off"}:
                return False
            return default

        s3_bucket = os.getenv("S3_BUCKET", "").strip()
        s3_prefix = os.getenv("S3_PREFIX", "plasma-results/").strip()
        inline_max_bytes = int(os.getenv("INLINE_MAX_BYTES", "200000"))
        presign_expiry_seconds = int(os.getenv("PRESIGN_EXPIRY_SECONDS", "3600"))
        default_local_dir = os.path.join(tempfile.gettempdir(), "plasma_results")
        local_storage_dir = os.getenv("LOCAL_STORAGE_DIR", default_local_dir)
        stripe_secret_key = os.getenv("STRIPE_SECRET_KEY", "").strip()
        stripe_compare_price_id = os.getenv("STRIPE_COMPARE_PRICE_ID", "").strip()
        compare_monthly_price_cents = max(50, int(os.getenv("COMPARE_MONTHLY_PRICE_CENTS", "500")))
        auth_db_path = os.getenv("AUTH_DB_PATH", os.path.join(local_storage_dir, "auth.sqlite3")).strip()
        auth_session_days = max(1, int(os.getenv("AUTH_SESSION_DAYS", "14")))
        auth_cookie_name = os.getenv("AUTH_COOKIE_NAME", "plasma_session").strip() or "plasma_session"
        auth_cookie_secure = to_bool(os.getenv("AUTH_COOKIE_SECURE"), False)
        admin_bootstrap_email = os.getenv("ADMIN_BOOTSTRAP_EMAIL", "").strip().lower()
        admin_bootstrap_password = os.getenv("ADMIN_BOOTSTRAP_PASSWORD", "").strip()
        return Settings(
            s3_bucket=s3_bucket,
            s3_prefix=s3_prefix,
            inline_max_bytes=inline_max_bytes,
            presign_expiry_seconds=presign_expiry_seconds,
            local_storage_dir=local_storage_dir,
            stripe_secret_key=stripe_secret_key,
            stripe_compare_price_id=stripe_compare_price_id,
            compare_monthly_price_cents=compare_monthly_price_cents,
            auth_db_path=auth_db_path,
            auth_session_days=auth_session_days,
            auth_cookie_name=auth_cookie_name,
            auth_cookie_secure=auth_cookie_secure,
            admin_bootstrap_email=admin_bootstrap_email,
            admin_bootstrap_password=admin_bootstrap_password,
        )


settings = Settings.from_env()
