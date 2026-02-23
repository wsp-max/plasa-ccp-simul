"""Storage layer for large simulation payloads."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import settings

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:  # pragma: no cover - boto3 optional
    boto3 = None
    BotoCoreError = Exception
    ClientError = Exception


@dataclass(frozen=True)
class StorageResult:
    """Represents a stored payload and its access information."""

    backend: str
    url: Optional[str]
    bucket: Optional[str]
    key: Optional[str]
    local_path: Optional[str]


class S3Store:
    """Store JSON payloads in S3 when available, otherwise on local disk."""

    def __init__(self) -> None:
        self.bucket = settings.s3_bucket
        self.prefix = settings.s3_prefix
        self.expiry = settings.presign_expiry_seconds
        self.local_dir = settings.local_storage_dir

    def store_bytes(self, payload: bytes, request_id: str) -> StorageResult:
        """Persist JSON bytes and return access metadata."""
        key = self._build_key(request_id)
        client = self._get_s3_client()
        if client is not None:
            try:
                client.put_object(
                    Bucket=self.bucket,
                    Key=key,
                    Body=payload,
                    ContentType="application/json",
                )
                url = client.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": self.bucket, "Key": key},
                    ExpiresIn=self.expiry,
                )
                return StorageResult(
                    backend="s3",
                    url=url,
                    bucket=self.bucket,
                    key=key,
                    local_path=None,
                )
            except (BotoCoreError, ClientError):
                return self._store_local(payload, key)

        return self._store_local(payload, key)

    def _build_key(self, request_id: str) -> str:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        filename = f"{request_id}-{timestamp}.json"
        if self.prefix:
            return f"{self.prefix.rstrip('/')}/{filename}"
        return filename

    def _get_s3_client(self):
        if not self.bucket:
            return None
        if boto3 is None:
            return None
        session = boto3.Session()
        credentials = session.get_credentials()
        if credentials is None:
            return None
        return session.client("s3")

    def _store_local(self, payload: bytes, key: str) -> StorageResult:
        base_path = Path(self.local_dir)
        full_path = base_path / key
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_bytes(payload)
        return StorageResult(
            backend="local",
            url=f"/results/{key}",
            bucket=None,
            key=key,
            local_path=str(full_path),
        )


def build_store() -> S3Store:
    """Build a storage backend instance."""
    return S3Store()
