"""FastAPI entrypoint for the plasma simulation API.

Run locally with:
    uvicorn app.main:app --reload
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import settings
from schemas import SimulationRequest, SimulationResponse, StorageInfo
from services.auth_store import (
    admin_update_user,
    authenticate_user,
    bootstrap_admin_user,
    create_session,
    create_user,
    delete_session,
    get_user_by_session_token,
    init_auth_db,
    list_users,
    parse_utc_iso,
    update_user_billing,
)
from services.compute_poisson_v1 import run_simulation_poisson_v1
from services.compute_stub import run_simulation_stub
from services.s3_store import build_store

app = FastAPI(title="Plasma Simulation API", version="0.2.0")
store = build_store()

init_auth_db(settings.auth_db_path)
bootstrap_admin_user(
    settings.auth_db_path,
    settings.admin_bootstrap_email,
    settings.admin_bootstrap_password,
)


def _estimate_json_size(payload: dict) -> tuple[int, bytes]:
    """Estimate JSON payload size in bytes and return the encoded payload."""
    json_bytes = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return len(json_bytes), json_bytes


SIM_MAX_CONCURRENCY = max(1, int(os.getenv("SIM_MAX_CONCURRENCY", "2")))
SIM_QUEUE_WAIT_SECONDS = max(0.1, float(os.getenv("SIM_QUEUE_WAIT_SECONDS", "8")))
SIM_SEMAPHORE = asyncio.Semaphore(SIM_MAX_CONCURRENCY)
# Default timeout is intentionally higher because compare page often runs two heavy cases.
SIM_TIMEOUT_SECONDS = float(os.getenv("SIM_TIMEOUT_SECONDS", "90"))
COMPARE_ACCESS_ACTIVE_STATUSES = {"active", "trialing"}


class AuthUserResponse(BaseModel):
    id: int
    email: str
    role: str
    compare_access_enabled: bool
    compare_access_granted: bool
    compare_access_expires_at: str | None = None
    stripe_subscription_status: str | None = None
    created_at: str
    updated_at: str


class AuthSessionResponse(BaseModel):
    user: AuthUserResponse


class AuthRegisterRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: str = Field(min_length=8, max_length=256)


class AuthLoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: str = Field(min_length=1, max_length=256)


class BasicOkResponse(BaseModel):
    ok: bool = True


class AdminUserUpdateRequest(BaseModel):
    role: str | None = Field(default=None, max_length=16)
    compare_access_enabled: bool | None = None
    compare_access_expires_at: str | None = Field(default=None, max_length=64)


class AdminUserResponse(AuthUserResponse):
    stripe_customer_id: str | None = None
    stripe_subscription_id: str | None = None


class AdminUsersResponse(BaseModel):
    users: list[AdminUserResponse]


class CompareCheckoutSessionCreateRequest(BaseModel):
    success_url: str = Field(min_length=1, max_length=2048)
    cancel_url: str = Field(min_length=1, max_length=2048)


class CompareCheckoutSessionCreateResponse(BaseModel):
    checkout_url: str
    checkout_session_id: str


class CompareCheckoutConfirmRequest(BaseModel):
    checkout_session_id: str = Field(min_length=1, max_length=255)


class CompareAccessStatusResponse(BaseModel):
    enabled: bool
    status: str
    customer_email: str | None = None
    current_period_end: str | None = None
    message: str | None = None


def _require_http_url(url: str, field_name: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{field_name} must be an absolute http/https URL.")
    return url


def _load_stripe() -> Any:
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Billing is not configured (missing STRIPE_SECRET_KEY).")
    try:
        import stripe  # type: ignore
    except Exception as exc:  # pragma: no cover - import path guard
        raise HTTPException(status_code=503, detail="Stripe SDK is unavailable. Install dependency 'stripe'.") from exc

    stripe.api_key = settings.stripe_secret_key
    stripe.max_network_retries = 2
    return stripe


def _as_dict(obj: Any) -> dict[str, Any]:
    if isinstance(obj, dict):
        return obj
    to_dict_recursive = getattr(obj, "to_dict_recursive", None)
    if callable(to_dict_recursive):
        data = to_dict_recursive()
        if isinstance(data, dict):
            return data
    return {}


def _build_compare_line_items() -> list[dict[str, Any]]:
    if settings.stripe_compare_price_id:
        return [{"price": settings.stripe_compare_price_id, "quantity": 1}]

    return [
        {
            "price_data": {
                "currency": "usd",
                "unit_amount": settings.compare_monthly_price_cents,
                "recurring": {"interval": "month"},
                "product_data": {"name": "PlasmaCCP Compare Access"},
            },
            "quantity": 1,
        }
    ]


def _period_end_to_iso(unix_ts: Any) -> str | None:
    if isinstance(unix_ts, (int, float)) and unix_ts > 0:
        return datetime.fromtimestamp(float(unix_ts), tz=timezone.utc).isoformat()
    return None


def _serialize_auth_user(user: dict[str, Any]) -> AuthUserResponse:
    return AuthUserResponse(
        id=int(user["id"]),
        email=str(user["email"]),
        role=str(user["role"]),
        compare_access_enabled=bool(user["compare_access_enabled"]),
        compare_access_granted=bool(user["compare_access_granted"]),
        compare_access_expires_at=user.get("compare_access_expires_at"),
        stripe_subscription_status=user.get("stripe_subscription_status"),
        created_at=str(user["created_at"]),
        updated_at=str(user["updated_at"]),
    )


def _serialize_admin_user(user: dict[str, Any]) -> AdminUserResponse:
    return AdminUserResponse(
        id=int(user["id"]),
        email=str(user["email"]),
        role=str(user["role"]),
        compare_access_enabled=bool(user["compare_access_enabled"]),
        compare_access_granted=bool(user["compare_access_granted"]),
        compare_access_expires_at=user.get("compare_access_expires_at"),
        stripe_subscription_status=user.get("stripe_subscription_status"),
        stripe_customer_id=user.get("stripe_customer_id"),
        stripe_subscription_id=user.get("stripe_subscription_id"),
        created_at=str(user["created_at"]),
        updated_at=str(user["updated_at"]),
    )


def _set_auth_cookie(response: Response, token: str, expires_at_iso: str) -> None:
    expires_at = parse_utc_iso(expires_at_iso)
    if expires_at is None:
        max_age = settings.auth_session_days * 24 * 60 * 60
    else:
        delta_seconds = int((expires_at - datetime.now(tz=timezone.utc)).total_seconds())
        max_age = max(60, delta_seconds)

    response.set_cookie(
        key=settings.auth_cookie_name,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path="/",
    )


def _clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.auth_cookie_name,
        path="/",
        secure=settings.auth_cookie_secure,
        samesite="lax",
    )


def _get_session_token(request: Request) -> str | None:
    token = request.cookies.get(settings.auth_cookie_name)
    if not token:
        return None
    stripped = token.strip()
    return stripped if stripped else None


def _get_current_user_optional(request: Request) -> dict[str, Any] | None:
    token = _get_session_token(request)
    if not token:
        return None
    return get_user_by_session_token(settings.auth_db_path, token)


def require_current_user(request: Request) -> dict[str, Any]:
    user = _get_current_user_optional(request)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    return user


def require_admin_user(current_user: dict[str, Any] = Depends(require_current_user)) -> dict[str, Any]:
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required.")
    return current_user


def _build_compare_access_response(user: dict[str, Any]) -> CompareAccessStatusResponse:
    enabled = bool(user["compare_access_enabled"])
    expires = user.get("compare_access_expires_at")
    subscription_status = user.get("stripe_subscription_status")

    if enabled:
        status_text = subscription_status or "granted"
        message = None
    elif bool(user["compare_access_granted"]) and expires:
        status_text = subscription_status or "expired"
        message = "Compare subscription exists but access has expired."
    else:
        status_text = subscription_status or "inactive"
        message = "Compare is locked. Subscribe or ask admin to grant access."

    return CompareAccessStatusResponse(
        enabled=enabled,
        status=status_text,
        customer_email=str(user["email"]),
        current_period_end=expires,
        message=message,
    )


def _sync_user_from_subscription(
    user: dict[str, Any], subscription_data: dict[str, Any]
) -> tuple[dict[str, Any], CompareAccessStatusResponse]:
    status_raw = subscription_data.get("status")
    status_value = str(status_raw) if status_raw is not None else "unknown"
    enabled = status_value in COMPARE_ACCESS_ACTIVE_STATUSES
    current_period_end = _period_end_to_iso(subscription_data.get("current_period_end"))
    expires_patch = current_period_end if current_period_end is not None else ""

    updated_user = update_user_billing(
        settings.auth_db_path,
        int(user["id"]),
        stripe_subscription_id=str(subscription_data.get("id") or ""),
        stripe_subscription_status=status_value,
        compare_access_enabled=enabled,
        compare_access_expires_at=expires_patch,
    )

    response = CompareAccessStatusResponse(
        enabled=enabled,
        status=status_value,
        customer_email=updated_user["email"],
        current_period_end=current_period_end,
        message=None if enabled else "Subscription is not active. Update billing and retry.",
    )
    return updated_user, response


@app.post("/auth/register", response_model=AuthSessionResponse)
@app.post("/api/auth/register", response_model=AuthSessionResponse)
def register(payload: AuthRegisterRequest, response: Response) -> AuthSessionResponse:
    try:
        user = create_user(settings.auth_db_path, payload.email, payload.password, role="user")
    except ValueError as exc:
        message = str(exc)
        code = status.HTTP_409_CONFLICT if "exists" in message.lower() else status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=code, detail=message) from exc

    token, expires_at = create_session(settings.auth_db_path, int(user["id"]), settings.auth_session_days)
    _set_auth_cookie(response, token, expires_at)
    return AuthSessionResponse(user=_serialize_auth_user(user))


@app.post("/auth/login", response_model=AuthSessionResponse)
@app.post("/api/auth/login", response_model=AuthSessionResponse)
def login(payload: AuthLoginRequest, response: Response) -> AuthSessionResponse:
    user = authenticate_user(settings.auth_db_path, payload.email, payload.password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password.")

    token, expires_at = create_session(settings.auth_db_path, int(user["id"]), settings.auth_session_days)
    _set_auth_cookie(response, token, expires_at)
    return AuthSessionResponse(user=_serialize_auth_user(user))


@app.post("/auth/logout", response_model=BasicOkResponse)
@app.post("/api/auth/logout", response_model=BasicOkResponse)
def logout(request: Request, response: Response) -> BasicOkResponse:
    token = _get_session_token(request)
    if token:
        delete_session(settings.auth_db_path, token)
    _clear_auth_cookie(response)
    return BasicOkResponse(ok=True)


@app.get("/auth/me", response_model=AuthSessionResponse)
@app.get("/api/auth/me", response_model=AuthSessionResponse)
def me(current_user: dict[str, Any] = Depends(require_current_user)) -> AuthSessionResponse:
    return AuthSessionResponse(user=_serialize_auth_user(current_user))


@app.get("/admin/users", response_model=AdminUsersResponse)
@app.get("/api/admin/users", response_model=AdminUsersResponse)
def admin_list_users(_: dict[str, Any] = Depends(require_admin_user)) -> AdminUsersResponse:
    users = list_users(settings.auth_db_path)
    return AdminUsersResponse(users=[_serialize_admin_user(user) for user in users])


@app.patch("/admin/users/{user_id}", response_model=AdminUserResponse)
@app.patch("/api/admin/users/{user_id}", response_model=AdminUserResponse)
def admin_patch_user(
    user_id: int,
    payload: AdminUserUpdateRequest,
    current_admin: dict[str, Any] = Depends(require_admin_user),
) -> AdminUserResponse:
    if int(current_admin["id"]) == user_id and payload.role is not None and payload.role.strip().lower() != "admin":
        raise HTTPException(status_code=400, detail="You cannot remove your own admin role.")

    try:
        updated_user = admin_update_user(
            settings.auth_db_path,
            user_id,
            role=payload.role,
            compare_access_enabled=payload.compare_access_enabled,
            compare_access_expires_at=payload.compare_access_expires_at,
        )
    except ValueError as exc:
        message = str(exc)
        status_code = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message) from exc

    return _serialize_admin_user(updated_user)


@app.post("/billing/compare/checkout-session", response_model=CompareCheckoutSessionCreateResponse)
@app.post("/api/billing/compare/checkout-session", response_model=CompareCheckoutSessionCreateResponse)
def create_compare_checkout_session(
    payload: CompareCheckoutSessionCreateRequest,
    current_user: dict[str, Any] = Depends(require_current_user),
) -> CompareCheckoutSessionCreateResponse:
    stripe = _load_stripe()
    success_url = _require_http_url(payload.success_url.strip(), "success_url")
    cancel_url = _require_http_url(payload.cancel_url.strip(), "cancel_url")

    customer_id = current_user.get("stripe_customer_id")
    if not customer_id:
        try:
            customer = stripe.Customer.create(
                email=current_user["email"],
                metadata={"user_id": str(current_user["id"]), "app": "plasmaccp"},
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Stripe customer creation failed: {exc}") from exc
        customer_data = _as_dict(customer)
        customer_id = customer_data.get("id")
        if not isinstance(customer_id, str) or not customer_id:
            raise HTTPException(status_code=502, detail="Stripe response missing customer ID.")
        current_user = update_user_billing(
            settings.auth_db_path,
            int(current_user["id"]),
            stripe_customer_id=customer_id,
        )

    try:
        session = stripe.checkout.Session.create(
            mode="subscription",
            success_url=success_url,
            cancel_url=cancel_url,
            line_items=_build_compare_line_items(),
            customer=customer_id,
            client_reference_id=str(current_user["id"]),
            allow_promotion_codes=True,
            billing_address_collection="auto",
            metadata={"feature": "compare", "user_id": str(current_user["id"])},
            subscription_data={
                "metadata": {"feature": "compare", "user_id": str(current_user["id"])},
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Stripe checkout session creation failed: {exc}") from exc

    session_data = _as_dict(session)
    checkout_url = session_data.get("url")
    checkout_session_id = session_data.get("id")
    if not isinstance(checkout_url, str) or not isinstance(checkout_session_id, str):
        raise HTTPException(status_code=502, detail="Stripe response missing checkout URL or session ID.")

    return CompareCheckoutSessionCreateResponse(
        checkout_url=checkout_url,
        checkout_session_id=checkout_session_id,
    )


@app.post("/billing/compare/confirm", response_model=CompareAccessStatusResponse)
@app.post("/api/billing/compare/confirm", response_model=CompareAccessStatusResponse)
def confirm_compare_checkout(
    payload: CompareCheckoutConfirmRequest,
    current_user: dict[str, Any] = Depends(require_current_user),
) -> CompareAccessStatusResponse:
    stripe = _load_stripe()
    session_id = payload.checkout_session_id.strip()
    try:
        session = stripe.checkout.Session.retrieve(session_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Checkout session lookup failed: {exc}") from exc

    session_data = _as_dict(session)
    customer_id = session_data.get("customer")
    if not isinstance(customer_id, str) or not customer_id:
        raise HTTPException(status_code=400, detail="Checkout session has no customer.")

    user_customer_id = current_user.get("stripe_customer_id")
    if user_customer_id and customer_id != user_customer_id:
        raise HTTPException(status_code=403, detail="This checkout session belongs to a different account.")

    if not user_customer_id:
        current_user = update_user_billing(
            settings.auth_db_path,
            int(current_user["id"]),
            stripe_customer_id=customer_id,
        )

    subscription_id = session_data.get("subscription")
    if not isinstance(subscription_id, str) or not subscription_id:
        return CompareAccessStatusResponse(
            enabled=False,
            status="no_subscription",
            customer_email=current_user["email"],
            current_period_end=current_user.get("compare_access_expires_at"),
            message="No subscription is attached to this checkout session yet.",
        )

    try:
        subscription = stripe.Subscription.retrieve(subscription_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Subscription lookup failed: {exc}") from exc

    _, access_response = _sync_user_from_subscription(current_user, _as_dict(subscription))
    return access_response


@app.get("/billing/compare/access", response_model=CompareAccessStatusResponse)
@app.get("/api/billing/compare/access", response_model=CompareAccessStatusResponse)
def get_compare_access_status(current_user: dict[str, Any] = Depends(require_current_user)) -> CompareAccessStatusResponse:
    return _build_compare_access_response(current_user)


@app.post("/simulate", response_model=SimulationResponse)
@app.post("/api/simulate", response_model=SimulationResponse)
async def simulate(
    request: SimulationRequest, mode: Literal["stub", "poisson_v1"] = "stub"
) -> SimulationResponse:
    """Run a stubbed or Poisson-based axisymmetric r-z simulation and return results."""
    try:
        await asyncio.wait_for(SIM_SEMAPHORE.acquire(), timeout=SIM_QUEUE_WAIT_SECONDS)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=429,
            detail=(
                "Server busy. "
                f"Max concurrency={SIM_MAX_CONCURRENCY}, queue wait>{SIM_QUEUE_WAIT_SECONDS:.0f}s. "
                "Try again in a moment."
            ),
        )

    try:
        if not request.geometry.axisymmetric:
            raise HTTPException(status_code=400, detail="Only axisymmetric r-z geometry is supported.")

        coord = request.geometry.coordinate_system.strip().lower()
        if coord not in {"r-z", "rz", "r_z", "r/z"}:
            raise HTTPException(status_code=400, detail="Only axisymmetric r-z geometry is supported.")

        request_id = request.meta.request_id or str(uuid4())

        if mode == "poisson_v1":
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(run_simulation_poisson_v1, request, request_id),
                    timeout=SIM_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                raise HTTPException(
                    status_code=504,
                    detail=f"Simulation timeout (>{SIM_TIMEOUT_SECONDS:.0f}s). Reduce grid size or complexity.",
                )
        else:
            result = run_simulation_stub(request, request_id)

        payload = result.model_dump(mode="json", exclude_none=True)
        size_bytes, json_bytes = _estimate_json_size(payload)

        if size_bytes > settings.inline_max_bytes:
            stored = store.store_bytes(json_bytes, request_id=request_id)
            storage = StorageInfo(
                backend=stored.backend,
                url=stored.url,
                bucket=stored.bucket,
                key=stored.key,
                local_path=stored.local_path,
                expires_in=settings.presign_expiry_seconds if stored.backend == "s3" else None,
            )
            return SimulationResponse(
                request_id=request_id,
                stored=True,
                size_bytes=size_bytes,
                result=None,
                result_url=stored.url,
                storage=storage,
            )

        storage = StorageInfo(backend="inline", url=None, bucket=None, key=None, local_path=None, expires_in=None)
        return SimulationResponse(
            request_id=request_id,
            stored=False,
            size_bytes=size_bytes,
            result=result,
            result_url=None,
            storage=storage,
        )
    finally:
        SIM_SEMAPHORE.release()


def _resolve_result_path(result_path: str) -> Path:
    base_dir = Path(settings.local_storage_dir).resolve()
    candidate = (base_dir / result_path).resolve()
    try:
        candidate.relative_to(base_dir)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid result path.")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Result not found.")
    return candidate


@app.get("/results/{result_path:path}")
@app.get("/api/results/{result_path:path}")
def get_result(result_path: str) -> FileResponse:
    file_path = _resolve_result_path(result_path)
    return FileResponse(file_path, media_type="application/json", filename=file_path.name)


def _resolve_frontend_dist() -> Path | None:
    base_dir = Path(__file__).resolve().parent
    candidates = [
        base_dir / "frontend" / "dist",
        base_dir.parent / "frontend" / "dist",
    ]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


frontend_dist = _resolve_frontend_dist()
if frontend_dist and (frontend_dist / "index.html").is_file():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
