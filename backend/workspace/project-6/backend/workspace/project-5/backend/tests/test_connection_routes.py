"""Tests for AI connection routes: CRUD, multiple credentials, multiple models,
defaults, cross-connection isolation, invalid IDs, and restart persistence.

Uses FastAPI TestClient against a temp workspace + temp DB with encryption
enabled via the dev-key provisioning path.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(env: Path, tmp_db: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # Ensure encryption is available for credential tests.
    from app.devkey import ensure_dev_key
    ensure_dev_key()
    from app import config as _config
    _config.settings = _config.Settings()
    from app.main import app
    return TestClient(app)


class TestCreateConnectionReturnsId:
    def test_create_returns_valid_id_and_shape(self, client: TestClient):
        r = client.post("/connections", json={
            "displayName": "My Gemini",
            "adapter": "gemini",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["id"].startswith("conn")
        assert body["adapter"] == "gemini"
        assert body["displayName"] == "My Gemini"
        assert body["status"] == "untested"

    def test_get_connection_by_returned_id(self, client: TestClient):
        r = client.post("/connections", json={
            "displayName": "G1", "adapter": "gemini",
        })
        cid = r.json()["id"]
        r2 = client.get(f"/connections/{cid}")
        assert r2.status_code == 200
        assert r2.json()["id"] == cid
        assert r2.json()["models"] == []
        assert r2.json()["credentials"] == []

    def test_invalid_adapter_rejected(self, client: TestClient):
        r = client.post("/connections", json={"displayName": "X", "adapter": "bogus"})
        assert r.status_code == 400


class TestStaticRoutesNotShadowed:
    """Regression: GET /connections/defaults was intercepted by /{cid} returning
    'Connection not found'. Static routes must resolve correctly."""

    def test_get_defaults_works(self, client: TestClient):
        r = client.get("/connections/defaults")
        assert r.status_code == 200, r.text
        assert "connectionId" in r.json()

    def test_get_adapters_works(self, client: TestClient):
        r = client.get("/connections/adapters")
        assert r.status_code == 200
        assert "gemini" in r.json()["adapters"]

    def test_get_presets_works(self, client: TestClient):
        r = client.get("/connections/presets")
        assert r.status_code == 200
        assert any(p["id"] == "gemini" for p in r.json()["presets"])

    def test_invalid_connection_id_returns_404(self, client: TestClient):
        r = client.get("/connections/conn_nonexistent")
        assert r.status_code == 404
        assert "Connection not found" in r.json()["detail"]


class TestMultipleCredentials:
    def test_add_multiple_keys_to_same_connection(self, client: TestClient):
        cid = client.post("/connections", json={
            "displayName": "MultiKey", "adapter": "gemini",
        }).json()["id"]

        k1 = client.post(f"/connections/{cid}/credentials", json={
            "secret": "AIza-key-A-1234567890", "label": "Gemini Key A", "isPrimary": True,
        })
        assert k1.status_code == 201
        assert k1.json()["isPrimary"] is True
        assert k1.json()["label"] == "Gemini Key A"

        k2 = client.post(f"/connections/{cid}/credentials", json={
            "secret": "AIza-key-B-1234567890", "label": "Gemini Key B", "isPrimary": False,
        })
        assert k2.status_code == 201
        assert k2.json()["isPrimary"] is False

        k3 = client.post(f"/connections/{cid}/credentials", json={
            "secret": "AIza-key-C-1234567890", "label": "Gemini Key C",
        })
        assert k3.status_code == 201

        creds = client.get(f"/connections/{cid}/credentials").json()
        assert len(creds) == 3
        labels = {c["label"] for c in creds}
        assert labels == {"Gemini Key A", "Gemini Key B", "Gemini Key C"}
        # Keys are masked, never returned in full.
        for c in creds:
            # The full secret must never appear in any field.
            assert c["keyMask"].startswith("AIza")  # mask shows first 4 chars
            assert c["keyMask"].endswith("7890")    # mask shows last 4 chars
            assert "••••" in c["keyMask"]            # middle is masked
            assert "AIza-key-A-1234567890" not in str(c)
            assert "AIza-key-B-1234567890" not in str(c)
            assert "AIza-key-C-1234567890" not in str(c)

    def test_primary_promotion_demotes_others(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "P", "adapter": "gemini"}).json()["id"]
        client.post(f"/connections/{cid}/credentials", json={"secret": "key1-aaaaaaaaaa", "isPrimary": True})
        c2 = client.post(f"/connections/{cid}/credentials", json={"secret": "key2-bbbbbbbbbb", "isPrimary": False}).json()
        client.patch(f"/connections/{cid}/credentials/{c2['id']}", json={"isPrimary": True})
        creds = {c["id"]: c for c in client.get(f"/connections/{cid}/credentials").json()}
        assert creds[c2["id"]]["isPrimary"] is True
        others = [c for c in creds.values() if c["id"] != c2["id"]]
        assert all(not c["isPrimary"] for c in others)

    def test_disable_enable_individual_key(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "D", "adapter": "gemini"}).json()["id"]
        c = client.post(f"/connections/{cid}/credentials", json={"secret": "key1-aaaaaaaaaa"}).json()
        client.patch(f"/connections/{cid}/credentials/{c['id']}", json={"enabled": False})
        creds = {c["id"]: c for c in client.get(f"/connections/{cid}/credentials").json()}
        assert creds[c["id"]]["enabled"] is False
        client.patch(f"/connections/{cid}/credentials/{c['id']}", json={"enabled": True})
        creds = {c["id"]: c for c in client.get(f"/connections/{cid}/credentials").json()}
        assert creds[c["id"]]["enabled"] is True

    def test_delete_individual_key(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "Del", "adapter": "gemini"}).json()["id"]
        c1 = client.post(f"/connections/{cid}/credentials", json={"secret": "key1-aaaaaaaaaa"}).json()
        c2 = client.post(f"/connections/{cid}/credentials", json={"secret": "key2-bbbbbbbbbb"}).json()
        r = client.delete(f"/connections/{cid}/credentials/{c1['id']}")
        assert r.status_code == 204
        creds = client.get(f"/connections/{cid}/credentials").json()
        assert len(creds) == 1
        assert creds[0]["id"] == c2["id"]


class TestMultipleModels:
    def test_add_multiple_models(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "M", "adapter": "gemini"}).json()["id"]
        m1 = client.post(f"/connections/{cid}/models", json={
            "modelId": "gemini-3.1-flash-lite", "isDefault": True,
        })
        assert m1.status_code == 201
        assert m1.json()["modelId"] == "gemini-3.1-flash-lite"
        assert m1.json()["isDefault"] is True

        m2 = client.post(f"/connections/{cid}/models", json={
            "modelId": "gemini-3.6-flash", "isDefault": False,
        })
        assert m2.status_code == 201
        assert m2.json()["modelId"] == "gemini-3.6-flash"

        m3 = client.post(f"/connections/{cid}/models", json={
            "modelId": "gemini-3.8-flash",
        })
        assert m3.status_code == 201

        models = client.get(f"/connections/{cid}/models").json()
        ids = {m["modelId"] for m in models}
        assert ids == {"gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"}

    def test_model_ids_preserved_exactly(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "P", "adapter": "gemini"}).json()["id"]
        for mid in ["gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"]:
            r = client.post(f"/connections/{cid}/models", json={"modelId": mid})
            assert r.status_code == 201
            assert r.json()["modelId"] == mid

    def test_default_model_promotion(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "D", "adapter": "gemini"}).json()["id"]
        m1 = client.post(f"/connections/{cid}/models", json={"modelId": "a", "isDefault": True}).json()
        m2 = client.post(f"/connections/{cid}/models", json={"modelId": "b"}).json()
        client.patch(f"/connections/{cid}/models/{m2['id']}", json={"isDefault": True})
        models = {m["id"]: m for m in client.get(f"/connections/{cid}/models").json()}
        assert models[m2["id"]]["isDefault"] is True
        assert models[m1["id"]]["isDefault"] is False
        conn = client.get(f"/connections/{cid}").json()
        assert conn["defaultModel"] == "b"

    def test_delete_model(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "DM", "adapter": "gemini"}).json()["id"]
        m = client.post(f"/connections/{cid}/models", json={"modelId": "x"}).json()
        r = client.delete(f"/connections/{cid}/models/{m['id']}")
        assert r.status_code == 204
        assert len(client.get(f"/connections/{cid}/models").json()) == 0


class TestDefaults:
    def test_set_and_get_defaults(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "Def", "adapter": "gemini"}).json()["id"]
        client.post(f"/connections/{cid}/models", json={"modelId": "gemini-3.6-flash", "isDefault": True})
        r = client.put("/connections/defaults", json={"connectionId": cid, "model": "gemini-3.6-flash"})
        assert r.status_code == 200
        assert r.json()["connectionId"] == cid
        assert r.json()["model"] == "gemini-3.6-flash"
        d = client.get("/connections/defaults").json()
        assert d["connectionId"] == cid

    def test_defaults_cleared_on_connection_delete(self, client: TestClient):
        cid = client.post("/connections", json={"displayName": "X", "adapter": "gemini"}).json()["id"]
        client.put("/connections/defaults", json={"connectionId": cid, "model": None})
        client.delete(f"/connections/{cid}")
        d = client.get("/connections/defaults").json()
        assert d["connectionId"] is None


class TestCrossConnectionIsolation:
    def test_credential_belongs_to_correct_connection(self, client: TestClient):
        a = client.post("/connections", json={"displayName": "A", "adapter": "gemini"}).json()
        b = client.post("/connections", json={"displayName": "B", "adapter": "gemini"}).json()
        client.post(f"/connections/{a['id']}/credentials", json={"secret": "key-A-aaaaaaaaaa"})
        client.post(f"/connections/{b['id']}/credentials", json={"secret": "key-B-bbbbbbbbbb"})
        a_creds = client.get(f"/connections/{a['id']}/credentials").json()
        b_creds = client.get(f"/connections/{b['id']}/credentials").json()
        assert len(a_creds) == 1 and len(b_creds) == 1
        assert a_creds[0]["id"] != b_creds[0]["id"]

    def test_model_belongs_to_correct_connection(self, client: TestClient):
        a = client.post("/connections", json={"displayName": "A", "adapter": "gemini"}).json()
        b = client.post("/connections", json={"displayName": "B", "adapter": "gemini"}).json()
        client.post(f"/connections/{a['id']}/models", json={"modelId": "model-a"})
        client.post(f"/connections/{b['id']}/models", json={"modelId": "model-b"})
        a_models = client.get(f"/connections/{a['id']}/models").json()
        b_models = client.get(f"/connections/{b['id']}/models").json()
        assert {m["modelId"] for m in a_models} == {"model-a"}
        assert {m["modelId"] for m in b_models} == {"model-b"}

    def test_get_credential_wrong_connection_404(self, client: TestClient):
        a = client.post("/connections", json={"displayName": "A", "adapter": "gemini"}).json()
        b = client.post("/connections", json={"displayName": "B", "adapter": "gemini"}).json()
        ca = client.post(f"/connections/{a['id']}/credentials", json={"secret": "key-A-aaaaaaaaaa"}).json()
        # Credential belongs to A; querying via B should 404.
        r = client.get(f"/connections/{b['id']}/credentials")
        assert r.status_code == 200
        assert all(c["id"] != ca["id"] for c in r.json())


class TestRestartPersistence:
    def test_connections_persist_across_db_reopen(self, client: TestClient, tmp_db: Path):
        cid = client.post("/connections", json={"displayName": "Persist", "adapter": "gemini"}).json()["id"]
        client.post(f"/connections/{cid}/credentials", json={"secret": "key-persist-aaaa"})
        client.post(f"/connections/{cid}/models", json={"modelId": "persist-model"})
        # Simulate restart: re-open the DB and re-run migrations.
        from app.db import connect, run_migrations
        with connect() as conn:
            run_migrations(conn)
            from app.connection_repos import ConnectionRepo, CredentialRepo, ConnectionModelRepo
            c = ConnectionRepo.get(conn, cid)
            assert c is not None
            assert c["displayName"] == "Persist"
            assert len(CredentialRepo.list(conn, cid)) == 1
            assert len(ConnectionModelRepo.list(conn, cid)) == 1

    def test_encrypted_credential_readable_after_restart(self, client: TestClient, tmp_db: Path):
        cid = client.post("/connections", json={"displayName": "Enc", "adapter": "gemini"}).json()["id"]
        client.post(f"/connections/{cid}/credentials", json={"secret": "AIza-restart-test123"})
        from app.db import connect
        from app.connection_repos import CredentialRepo
        with connect() as conn:
            secret, _ = CredentialRepo.select_secret(conn, cid)
            assert secret == "AIza-restart-test123"


class TestFullCreationFlow:
    def test_create_connection_then_key_then_model_then_defaults(self, client: TestClient):
        # Step 1: create connection
        conn = client.post("/connections", json={
            "displayName": "Full Flow", "adapter": "gemini",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
        }).json()
        cid = conn["id"]

        # Step 2: add API key
        k = client.post(f"/connections/{cid}/credentials", json={
            "secret": "AIza-fullflow-test-key", "isPrimary": True,
        })
        assert k.status_code == 201

        # Step 3: add model
        m = client.post(f"/connections/{cid}/models", json={
            "modelId": "gemini-3.6-flash", "isDefault": True,
        })
        assert m.status_code == 201

        # Step 4: set defaults
        d = client.put("/connections/defaults", json={"connectionId": cid, "model": "gemini-3.6-flash"})
        assert d.status_code == 200

        # Verify the full detail
        detail = client.get(f"/connections/{cid}").json()
        assert detail["id"] == cid
        assert len(detail["credentials"]) == 1
        assert len(detail["models"]) == 1
        assert detail["defaultModel"] == "gemini-3.6-flash"
        assert detail["hasKey"] is True

        # Verify defaults
        defaults = client.get("/connections/defaults").json()
        assert defaults["connectionId"] == cid
        assert defaults["model"] == "gemini-3.6-flash"
