"""Admin step-up authorization: real HTTP routes, synthetic in-memory records.

No app startup, production database, external messages or live users are used.
The broad GET sweep ensures every administrative read/download path rejects a
password-only token before touching protected data; focused writes cover the
alternate role checks that historically did not use the common dependency.
"""
from __future__ import annotations

import ast
from datetime import datetime, timedelta
import hashlib
import inspect
from pathlib import Path
import re
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import Depends, FastAPI, HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.app.database import get_db
from backend.app import security
from backend.app.models import (
    Base, Certificate, Comment, Exam, SiteDocument, User, UserSession,
    AdminMfaCredential, AdminMfaElevation, AdminMfaPending, AdminMfaRecoveryCode,
)
from backend.app.routers import (
    admin, ai_assistant, app_files, documents, exam, exam_schedules,
    expert_uploads, guide, multi_apartment, multi_functional, planning_letters,
    regulations, reviews, statements, taxonomy, users,
)
from backend.app.services import admin_mfa, exam_stage


class AdminMfaEnforcementTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        event.listen(self.engine, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, autoflush=False)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.settings = SimpleNamespace(
            founder_admin_email="founder@example.test",
            admin_mfa_encryption_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        for module in (security, admin, users, expert_uploads, documents, exam_stage, admin_mfa):
            setting_patch = patch.object(module, "get_settings", return_value=self.settings)
            setting_patch.start()
            self.addCleanup(setting_patch.stop)
        self.admin = self.add_user(1, is_admin=True)
        self.founder = self.add_user(2, email="founder@example.test")
        self.candidate = self.add_user(3)
        self.other = self.add_user(4)
        self.db.add(Exam(id=1, title="Synthetic examination", duration_minutes=90))
        self.db.commit()
        self.app = FastAPI()
        self.router_pairs = (
            (admin.router, "/admin"), (ai_assistant.router, "/admin"),
            (exam_schedules.router, "/admin"), (planning_letters.router, "/admin"),
            (users.router, "/users"), (reviews.router, "/reviews"),
            (expert_uploads.router, "/expert-uploads"), (exam.router, "/exam"),
            (statements.router, "/statements"), (taxonomy.router, "/taxonomy"),
            (documents.router, ""), (guide.router, ""), (app_files.router, ""),
            (regulations.router, ""), (multi_apartment.router, ""),
            (multi_functional.router, ""),
        )
        for router, prefix in self.router_pairs:
            self.app.include_router(router, prefix=prefix)
        self.app.dependency_overrides[get_db] = lambda: self.db

        @self.app.get("/synthetic/founder")
        def founder_only(_user=Depends(security.require_founder)):
            return {"ok": True}

        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def add_user(self, number, **overrides):
        data = dict(
            id=number, personal_id=f"{number:011d}", code=f"{number:010d}",
            first_name="Synthetic", last_name=f"User{number}", phone="555000001",
            email=f"person{number}@example.test", password_hash="synthetic-unused-hash",
            is_admin=False,
        )
        data.update(overrides)
        user = User(**data)
        self.db.add(user)
        self.db.flush()
        self.db.add(UserSession(
            user_id=user.id, token=f"synthetic-{number}", client_type="web",
            expires_at=datetime.utcnow() + timedelta(days=1),
        ))
        self.db.commit()
        return user

    def headers(self, user=None):
        return {"Authorization": f"Bearer synthetic-{(user or self.admin).id}"}

    def elevate(self, user=None, *, absolute_expired=False, idle_expired=False):
        user = user or self.admin
        now = datetime.utcnow()
        credential = self.db.get(AdminMfaCredential, user.id)
        if credential is None:
            credential = AdminMfaCredential(
                user_id=user.id, secret_ciphertext="synthetic-ciphertext-not-decrypted-by-authorization",
                enabled_at=now,
            )
            self.db.add(credential)
        elevation = AdminMfaElevation(
            token_hash=hashlib.sha256(f"synthetic-{user.id}".encode()).hexdigest(),
            user_id=user.id, verified_at=now - timedelta(minutes=10),
            last_used_at=now - timedelta(minutes=31) if idle_expired else now,
            expires_at=now - timedelta(seconds=1) if absolute_expired else now + timedelta(hours=1),
        )
        self.db.add(elevation)
        self.db.commit()
        return elevation

    def assert_mfa_required(self, response):
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["detail"]["code"], "ADMIN_MFA_REQUIRED")

    def test_every_admin_get_route_rejects_password_only_admin_and_founder(self):
        routes = [route for route in self.app.routes if isinstance(route, APIRoute)
                  and route.path.startswith("/admin/") and "GET" in route.methods]
        self.assertGreater(len(routes), 30)
        for user in (self.admin, self.founder):
            for route in routes:
                path = re.sub(r"\{[^}]+\}", "1", route.path.replace("{kind}", "exam"))
                with self.subTest(user=user.id, path=path):
                    self.assert_mfa_required(self.client.get(path, headers=self.headers(user)))

    def test_desktop_client_label_never_bypasses_admin_mfa(self):
        session = self.db.scalar(select(UserSession).where(UserSession.user_id == self.admin.id))
        session.client_type = "desktop"
        session.device_id = "00000000-0000-4000-8000-000000000001"
        self.db.commit()
        self.assert_mfa_required(self.client.get("/admin/auth/verify", headers={
            **self.headers(), "User-Agent": "certification-exam-app", "X-Client-Type": "desktop",
        }))

    def test_fresh_verified_admin_and_founder_are_allowed(self):
        for user in (self.admin, self.founder):
            self.elevate(user)
            response = self.client.get("/admin/auth/verify", headers=self.headers(user))
            self.assertEqual(response.status_code, 204, response.text)
            self.assertEqual(response.headers["X-Is-Founder"], str(user.id == self.founder.id).lower())

    def test_idle_expired_and_absolute_expired_elevations_are_denied(self):
        self.elevate(self.admin, idle_expired=True)
        self.elevate(self.founder, absolute_expired=True)
        for user in (self.admin, self.founder):
            self.assert_mfa_required(self.client.get("/admin/auth/verify", headers=self.headers(user)))

    def test_new_session_does_not_inherit_other_session_elevation(self):
        self.elevate()
        self.db.add(UserSession(user_id=self.admin.id, token="another-login",
                                expires_at=datetime.utcnow() + timedelta(hours=1)))
        self.db.commit()
        self.assert_mfa_required(self.client.get("/admin/auth/verify", headers={"Authorization": "Bearer another-login"}))

    def test_non_admin_and_expired_login_stay_denied_even_with_elevation(self):
        self.elevate(self.candidate)
        response = self.client.get("/admin/auth/verify", headers=self.headers(self.candidate))
        self.assertIn(response.status_code, (401, 403))
        self.elevate()
        session = self.db.scalar(select(UserSession).where(UserSession.user_id == self.admin.id))
        session.expires_at = datetime.utcnow() - timedelta(seconds=1)
        self.db.commit()
        self.assertEqual(self.client.get("/admin/auth/verify", headers=self.headers()).status_code, 401)

    def test_common_admin_and_founder_dependencies_require_mfa(self):
        self.assert_mfa_required(self.client.post("/taxonomy/chapters", headers=self.headers(), json={"name": "Synthetic"}))
        self.assert_mfa_required(self.client.get("/synthetic/founder", headers=self.headers(self.founder)))
        self.elevate()
        response = self.client.post("/taxonomy/chapters", headers=self.headers(), json={"name": "Synthetic"})
        self.assertEqual(response.status_code, 201, response.text)
        self.elevate(self.founder)
        self.assertEqual(self.client.get("/synthetic/founder", headers=self.headers(self.founder)).status_code, 200)

    def test_founder_only_admin_toggle_and_delete_require_mfa(self):
        for method, path, body in (
            ("PATCH", f"/admin/users/{self.candidate.id}/admin", {"is_admin": True}),
            ("DELETE", f"/admin/users/{self.candidate.id}", None),
        ):
            response = self.client.request(method, path, headers=self.headers(self.founder), json=body)
            self.assert_mfa_required(response)
        self.db.refresh(self.candidate)
        self.assertFalse(self.candidate.is_admin)
        self.assertIsNotNone(self.db.get(User, self.candidate.id))

    def test_certificate_and_expert_delete_aliases_require_mfa(self):
        self.assert_mfa_required(self.client.post(f"/users/{self.candidate.id}/certificate", headers=self.headers(), json={"level": "architect"}))
        self.assert_mfa_required(self.client.post(f"/users/{self.candidate.id}/certificate/notify", headers=self.headers(), json={}))
        self.assert_mfa_required(self.client.delete("/expert-uploads/999", headers=self.headers()))
        self.assert_mfa_required(self.client.post("/expert-uploads/999/delete", headers=self.headers()))
        self.assertIsNone(self.db.scalar(select(Certificate).where(Certificate.user_id == self.candidate.id)))

    def test_role_change_revokes_only_target_elevation_and_pending_not_enrollment(self):
        self.elevate()
        self.elevate(self.founder)
        now = datetime.utcnow()
        self.db.add(AdminMfaPending(
            user_id=self.admin.id, token_hash="synthetic-pending-hash",
            secret_ciphertext="synthetic-pending-secret", credential_generation=0,
            created_at=now, expires_at=now + timedelta(minutes=5),
        ))
        recovery = AdminMfaRecoveryCode(user_id=self.admin.id, code_hash="synthetic-recovery-hash", created_at=now)
        self.db.add(recovery)
        self.db.commit()
        target_hash = hashlib.sha256(f"synthetic-{self.admin.id}".encode()).hexdigest()
        founder_hash = hashlib.sha256(f"synthetic-{self.founder.id}".encode()).hexdigest()
        path = f"/admin/users/{self.admin.id}/admin"
        # No actual role change must not unexpectedly log out a verified admin.
        same = self.client.patch(path, headers=self.headers(self.founder), json={"is_admin": True})
        self.assertEqual(same.status_code, 204, same.text)
        self.assertIsNotNone(self.db.get(AdminMfaElevation, target_hash))
        for promoted in (False, True):
            response = self.client.patch(path, headers=self.headers(self.founder), json={"is_admin": promoted})
            self.assertEqual(response.status_code, 204, response.text)
            self.assertIsNone(self.db.get(AdminMfaElevation, target_hash))
            self.assertIsNone(self.db.get(AdminMfaPending, self.admin.id))
            self.assertIsNotNone(self.db.get(AdminMfaElevation, founder_hash))
            self.assertTrue(self.db.get(AdminMfaCredential, self.admin.id).secret_ciphertext)
            self.assertIsNotNone(self.db.get(AdminMfaRecoveryCode, recovery.id))
        self.assert_mfa_required(self.client.get("/admin/auth/verify", headers=self.headers()))

    def test_admin_download_alias_outside_admin_prefix_requires_mfa(self):
        self.assert_mfa_required(self.client.get("/app-files/999/download", headers=self.headers()))

    def test_owner_profile_and_me_work_without_mfa_but_cross_user_profile_is_gated(self):
        for user in (self.candidate, self.admin, self.founder):
            response = self.client.get("/users/profile", params={"email": user.email}, headers=self.headers(user))
            self.assertEqual(response.status_code, 200, response.text)
            response = self.client.get("/users/me", headers=self.headers(user))
            self.assertEqual(response.status_code, 200, response.text)
        self.assert_mfa_required(self.client.get("/users/profile", params={"email": self.candidate.email}, headers=self.headers()))
        self.elevate()
        response = self.client.get("/users/profile", params={"email": self.candidate.email}, headers=self.headers())
        self.assertEqual(response.status_code, 200, response.text)

    def test_noncertified_photo_owner_access_unchanged_admin_override_gated(self):
        with tempfile.TemporaryDirectory(prefix="gipc-mfa-photo-") as directory:
            path = Path(directory) / "synthetic.jpg"
            path.write_bytes(b"synthetic-test-image")
            self.candidate.photo_path = "synthetic.jpg"
            self.db.commit()
            with patch.object(users, "resolve_storage_path", return_value=path):
                url = f"/users/{self.candidate.id}/photo/file"
                self.assertEqual(self.client.get(url, headers=self.headers(self.candidate)).status_code, 200)
                self.assertEqual(self.client.get(url).status_code, 404)
                self.assert_mfa_required(self.client.get(url, headers=self.headers()))
                self.assert_mfa_required(self.client.get(url, params={"token": "synthetic-1"}))
                self.elevate()
                self.assertEqual(self.client.get(url, headers=self.headers()).status_code, 200)

    def test_certified_photo_remains_public(self):
        with tempfile.TemporaryDirectory(prefix="gipc-mfa-public-photo-") as directory:
            path = Path(directory) / "synthetic.jpg"
            path.write_bytes(b"synthetic-test-image")
            self.candidate.photo_path = "synthetic.jpg"
            self.db.add(Certificate(user_id=self.candidate.id, unique_code="CERT-MFA", level="architect", status="active"))
            self.db.commit()
            with patch.object(users, "resolve_storage_path", return_value=path):
                self.assertEqual(self.client.get(f"/users/{self.candidate.id}/photo/file").status_code, 200)

    def test_personalized_contract_gate_includes_token_query_without_affecting_public(self):
        self.db.add(SiteDocument(id=1, title="Synthetic contract", content="<p>Template</p>", contract_type="universal", order_index=1))
        self.db.commit()
        with patch.object(documents, "_ensure_default_contracts"), patch.object(documents, "_resolve_existing_document_file", return_value=None):
            for url in ("/documents", "/documents/1"):
                self.assertEqual(self.client.get(url).status_code, 200)
                self.assertEqual(self.client.get(url, headers=self.headers()).status_code, 200)
                self.assert_mfa_required(self.client.get(url, params={"user_id": self.candidate.id}, headers=self.headers()))
                self.assert_mfa_required(self.client.get(url, params={"user_id": self.candidate.id, "token": "synthetic-1"}))
            self.elevate()
            self.assertEqual(self.client.get("/documents/1", params={"user_id": self.candidate.id}, headers=self.headers()).status_code, 200)

    def test_own_comment_deletion_unchanged_admin_moderation_requires_mfa(self):
        self.db.add(Certificate(user_id=self.other.id, unique_code="CERT-OTHER", level="architect", status="active"))
        first = Comment(author_user_id=self.candidate.id, target_user_id=self.other.id, message="Synthetic owner")
        second = Comment(author_user_id=self.candidate.id, target_user_id=self.other.id, message="Synthetic moderated")
        self.db.add_all([first, second])
        self.db.commit()
        url = f"/reviews/{self.other.id}/comments/"
        self.assertEqual(self.client.delete(url + str(first.id), headers=self.headers(self.candidate)).status_code, 204)
        self.assert_mfa_required(self.client.delete(url + str(second.id), headers=self.headers()))
        self.assertIsNotNone(self.db.get(Comment, second.id))
        self.elevate()
        self.assertEqual(self.client.delete(url + str(second.id), headers=self.headers()).status_code, 204)

    def test_admin_starting_other_candidates_exam_requires_mfa_before_grant_checks(self):
        response = self.client.post("/exam/session/start", headers=self.headers(), json={
            "exam_id": 1, "candidate_code": self.candidate.code, "prepare_only": True,
            "candidate_first_name": "Synthetic", "candidate_last_name": "User",
        })
        self.assert_mfa_required(response)
        # Own candidate admission still reaches the ordinary stage-grant rule,
        # never the administrative step-up challenge.
        response = self.client.post("/exam/session/start", headers=self.headers(self.candidate), json={
            "exam_id": 1, "candidate_code": self.candidate.code, "prepare_only": True,
            "candidate_first_name": "Synthetic", "candidate_last_name": "User",
        })
        self.assertEqual(response.status_code, 403, response.text)
        self.assertNotIn("ADMIN_MFA_REQUIRED", response.text)

    def test_public_exam_material_settings_and_capabilities_stay_public(self):
        for path in ("/exam/offline/capabilities", "/public/multi-apartment/settings", "/public/multi-functional/settings", "/taxonomy/chapters"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_all_admin_routes_have_a_path_to_an_mfa_protected_gate(self):
        """Structural inventory complements HTTP checks for body/file endpoints."""
        gates = {admin._require_admin, users._require_admin, expert_uploads._require_admin,
                 security.require_admin, security.require_founder}

        def reaches_gate(function, seen=None):
            seen = set() if seen is None else seen
            if function in gates:
                return True
            if function in seen or not inspect.isfunction(function):
                return False
            seen.add(function)
            for parameter in inspect.signature(function).parameters.values():
                dependency = getattr(parameter.default, "dependency", None)
                if dependency is not None and reaches_gate(dependency, seen):
                    return True
            tree = ast.parse(textwrap.dedent(inspect.getsource(function)))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    callee = function.__globals__.get(node.func.id)
                    if inspect.isfunction(callee) and callee.__module__.startswith("backend.app"):
                        if reaches_gate(callee, seen):
                            return True
            return False

        routes = [route for route in self.app.routes if isinstance(route, APIRoute) and route.path.startswith("/admin/")]
        self.assertGreater(len(routes), 85)
        for route in routes:
            with self.subTest(path=route.path, methods=route.methods):
                self.assertTrue(reaches_gate(route.endpoint), "Administrative route lacks a shared MFA barrier")
        for gate in gates:
            self.assertIn("require_admin_mfa(", inspect.getsource(gate))


if __name__ == "__main__":
    unittest.main()
