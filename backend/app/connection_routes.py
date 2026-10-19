"""API connection management routes.

CRUD for connections, credentials, and models; connection testing; and agent
defaults. All responses exclude secrets — only masked metadata is returned.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.db import connect
from app.connection_repos import (
    ConnectionRepo,
    ConnectionModelRepo,
    CredentialRepo,
    AgentDefaultsRepo,
    ADAPTERS,
)
from app.adapters import resolve_adapter, supported_adapters, AdapterError
from app.crypto import is_encryption_available
from app.utils import now_ms


router = APIRouter(prefix="/connections", tags=["connections"])


# --- Connection CRUD ---

class ConnectionCreate(BaseModel):
    displayName: str = Field(min_length=1, max_length=120)
    adapter: str = Field(min_length=1, max_length=60)
    providerLabel: Optional[str] = Field(default=None, max_length=120)
    baseUrl: Optional[str] = Field(default=None, max_length=512)
    enabled: bool = True


class ConnectionUpdate(BaseModel):
    displayName: Optional[str] = Field(default=None, max_length=120)
    providerLabel: Optional[str] = None
    baseUrl: Optional[str] = None
    enabled: Optional[bool] = None
    status: Optional[str] = Field(default=None, max_length=60)
    defaultModel: Optional[str] = None


@router.get("")
def list_connections():
    with connect() as conn:
        items = ConnectionRepo.list(conn)
        # Attach model + key counts to each connection for the UI.
        for item in items:
            models = ConnectionModelRepo.list(conn, item["id"])
            creds = CredentialRepo.list(conn, item["id"])
            item["models"] = models
            item["credentials"] = creds
            item["hasKey"] = any(c["enabled"] for c in creds)
        return items


@router.post("", status_code=status.HTTP_201_CREATED)
def create_connection(body: ConnectionCreate):
    if body.adapter not in ADAPTERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown adapter. Supported: {', '.join(supported_adapters())}")
    with connect() as conn:
        return ConnectionRepo.create(
            conn,
            display_name=body.displayName,
            adapter=body.adapter,
            provider_label=body.providerLabel,
            base_url=body.baseUrl,
            enabled=body.enabled,
        )


@router.get("/{cid}")
def get_connection(cid: str):
    with connect() as conn:
        item = ConnectionRepo.get(conn, cid)
        if not item:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        item["models"] = ConnectionModelRepo.list(conn, cid)
        item["credentials"] = CredentialRepo.list(conn, cid)
        item["hasKey"] = any(c["enabled"] for c in item["credentials"])
        return item


@router.patch("/{cid}")
def update_connection(cid: str, body: ConnectionUpdate):
    with connect() as conn:
        item = ConnectionRepo.update(
            conn,
            cid,
            display_name=body.displayName,
            provider_label=body.providerLabel,
            base_url=body.baseUrl,
            enabled=body.enabled,
            status=body.status,
            default_model=body.defaultModel,
        )
        if not item:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        return item


@router.delete("/{cid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_connection(cid: str):
    with connect() as conn:
        if not ConnectionRepo.remove(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        # Clear agent defaults if they pointed here.
        defaults = AgentDefaultsRepo.get(conn)
        if defaults["connectionId"] == cid:
            AgentDefaultsRepo.set(conn, connection_id=None, model=None)


# --- Credentials ---

class CredentialAdd(BaseModel):
    secret: str = Field(min_length=1, max_length=2000)
    label: Optional[str] = Field(default=None, max_length=120)
    isPrimary: bool = False


class CredentialUpdate(BaseModel):
    label: Optional[str] = None
    enabled: Optional[bool] = None
    isPrimary: Optional[bool] = None


@router.get("/{cid}/credentials")
def list_credentials(cid: str):
    with connect() as conn:
        if not ConnectionRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        return CredentialRepo.list(conn, cid)


@router.post("/{cid}/credentials", status_code=status.HTTP_201_CREATED)
def add_credential(cid: str, body: CredentialAdd):
    if not is_encryption_available():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Credential encryption is not configured. Generate a master key "
            "with `python -m app.crypto generate-key` and set PAIDE_ENC_KEY.",
        )
    with connect() as conn:
        if not ConnectionRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        try:
            return CredentialRepo.add(
                conn,
                connection_id=cid,
                secret=body.secret,
                label=body.label,
                enabled=True,
                is_primary=body.isPrimary,
            )
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.patch("/{cid}/credentials/{cred_id}")
def update_credential(cid: str, cred_id: str, body: CredentialUpdate):
    with connect() as conn:
        if not ConnectionRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        item = CredentialRepo.update(
            conn,
            cred_id,
            label=body.label,
            enabled=body.enabled,
            is_primary=body.isPrimary,
        )
        if not item:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Credential not found")
        return item


@router.delete("/{cid}/credentials/{cred_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_credential(cid: str, cred_id: str):
    with connect() as conn:
        if not ConnectionRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        if not CredentialRepo.remove(conn, cred_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Credential not found")


# --- Models ---

class ModelAdd(BaseModel):
    modelId: str = Field(min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=120)
    isDefault: bool = False


class ModelUpdate(BaseModel):
    label: Optional[str] = None
    enabled: Optional[bool] = None
    isDefault: Optional[bool] = None


@router.get("/{cid}/models")
def list_models(cid: str):
    with connect() as conn:
        if not ConnectionRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        return ConnectionModelRepo.list(conn, cid)


@router.post("/{cid}/models", status_code=status.HTTP_201_CREATED)
def add_model(cid: str, body: ModelAdd):
    with connect() as conn:
        if not ConnectionRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        return ConnectionModelRepo.add(
            conn,
            connection_id=cid,
            model_id=body.modelId,
            label=body.label,
            enabled=True,
            is_default=body.isDefault,
        )


@router.patch("/{cid}/models/{mid}")
def update_model(cid: str, mid: str, body: ModelUpdate):
    with connect() as conn:
        if not ConnectionRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        item = ConnectionModelRepo.update(
            conn, mid, label=body.label, enabled=body.enabled, is_default=body.isDefault
        )
        if not item:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Model not found")
        return item


@router.delete("/{cid}/models/{mid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(cid: str, mid: str):
    with connect() as conn:
        if not ConnectionRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        if not ConnectionModelRepo.remove(conn, mid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Model not found")


# --- Connection testing ---

class TestRequest(BaseModel):
    model: str = Field(min_length=1, max_length=120)
    credentialId: Optional[str] = Field(default=None, max_length=120)


class TestResponse(BaseModel):
    category: str
    message: str
    statusCode: Optional[int] = None


@router.post("/{cid}/test", response_model=TestResponse)
def test_connection(cid: str, body: TestRequest):
    with connect() as conn:
        item = ConnectionRepo.get(conn, cid)
        if not item:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        try:
            adapter = resolve_adapter(item["adapter"])
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown adapter for this connection.")

        # Resolve the credential to test.
        if body.credentialId:
            row = None
            for c in CredentialRepo.list(conn, cid):
                if c["id"] == body.credentialId:
                    row = c
                    break
            if not row:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Credential not found")
            from app.crypto import decrypt, EncryptionError
            try:
                secret = decrypt(_get_encrypted(conn, body.credentialId))  # type: ignore[arg-type]
            except EncryptionError:
                return TestResponse(category="auth_failed", message="Credential could not be decrypted.")
        else:
            secret, _ = CredentialRepo.select_secret(conn, cid)
            if not secret:
                return TestResponse(category="auth_failed", message="No enabled API key for this connection.")

        result = adapter.test(item["baseUrl"], secret, body.model)
        # Persist the status on the connection.
        status_str = "connected" if result.category == "ok" else "error"
        ConnectionRepo.update(conn, cid, status=status_str)
        return TestResponse(category=result.category, message=result.message, statusCode=result.status_code)


def _get_encrypted(conn, cred_id: str) -> str:
    from app.db import query_one
    row = query_one(conn, "SELECT encrypted_secret FROM connection_credentials WHERE id = ?", (cred_id,))
    return row["encrypted_secret"] if row else ""


# --- Agent defaults ---

class DefaultsBody(BaseModel):
    connectionId: Optional[str] = None
    model: Optional[str] = Field(default=None, max_length=120)


@router.get("/defaults")
def get_defaults():
    with connect() as conn:
        return AgentDefaultsRepo.get(conn)


@router.put("/defaults")
def set_defaults(body: DefaultsBody):
    with connect() as conn:
        if body.connectionId:
            if not ConnectionRepo.get(conn, body.connectionId):
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        return AgentDefaultsRepo.set(conn, connection_id=body.connectionId, model=body.model)


@router.get("/adapters")
def list_adapters():
    return {"adapters": supported_adapters()}
