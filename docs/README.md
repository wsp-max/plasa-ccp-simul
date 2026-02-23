# Workspace Structure

This workspace is organized by role:

- `app/`: FastAPI backend and simulation services.
- `frontend/`: React/Vite UI source and build outputs.
- `tests/`: Python test suite.
- `assets/screenshots/`: screenshot/image files.
- `deploy/ops/`: operational files (`plasma-key.pem`, EC2 notes, helper scripts).
- `deploy/checks/`: deployment check payloads/responses/headers.
- `deploy/tmp/`: temporary large payload/response files.
- `deploy/bundles/`: deployment bundles (`.tgz`, frontend zip archives).
- `docs/playbooks/`: deployment and operation playbooks.

## Compare Billing (Monthly $5)

Compare page access is now gated by authenticated user account status.

- Backend env vars:
  - `AUTH_DB_PATH`: SQLite path for user/session/billing state (default: `${LOCAL_STORAGE_DIR}/auth.sqlite3`)
  - `AUTH_SESSION_DAYS`: login session duration in days (default: `14`)
  - `AUTH_COOKIE_NAME`: auth cookie name (default: `plasma_session`)
  - `AUTH_COOKIE_SECURE`: set `true` in HTTPS production
  - `ADMIN_BOOTSTRAP_EMAIL`: optional first admin account email
  - `ADMIN_BOOTSTRAP_PASSWORD`: optional first admin account password
  - `STRIPE_SECRET_KEY`: Stripe secret key (required for billing endpoints)
  - `STRIPE_COMPARE_PRICE_ID`: optional recurring price ID (if omitted, backend creates an inline `$5/month` price data item)
  - `COMPARE_MONTHLY_PRICE_CENTS`: optional monthly amount in cents (default `500`)
- Frontend flow:
  - User registers/logs in.
  - User opens `Compare` page and starts checkout.
  - Stripe returns to `?compare_checkout_session_id=...#/compare`.
  - App confirms session via `/api/billing/compare/confirm` for the logged-in user.
  - Access state is read from `/api/billing/compare/access`.
  - Admins can manage users from `/api/admin/users` and `/api/admin/users/{id}`.
