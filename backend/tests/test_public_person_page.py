from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

try:
    from backend.app.database import get_db
    from backend.app.models import Base, Certificate, Comment, ExpertUpload, Rating, User, UserCodeReservation, UserSession
    from backend.app.routers import expert_uploads, reviews, users
    from backend.app.schemas import UserCreateWithVerification
    from backend.app.services.user_codes import remember_user_code
except ModuleNotFoundError:
    from app.database import get_db
    from app.models import Base, Certificate, Comment, ExpertUpload, Rating, User, UserCodeReservation, UserSession
    from app.routers import expert_uploads, reviews, users
    from app.schemas import UserCreateWithVerification
    from app.services.user_codes import remember_user_code


class PublicPersonPageTests(unittest.TestCase):
    """Actual HTTP contracts in an isolated database, without live media/email."""

    def setUp(self):
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        event.listen(self.engine, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.app = FastAPI()
        self.app.include_router(users.router, prefix="/users")
        self.app.include_router(reviews.router, prefix="/reviews")
        self.app.include_router(expert_uploads.router, prefix="/expert-uploads")
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.person = self.add_user(1)
        self.certificate = self.add_certificate(self.person)

    def add_user(self, number, **overrides):
        fields = dict(
            personal_id=f"{number:011d}", first_name=f"Person{number}", last_name="Example",
            email=f"person{number}@example.com", phone=f"555{number:06d}",
            code=f"{number:010d}", password_hash="secret-password-hash",
            photo_path="private/photo.jpg", photo_filename="private-photo.jpg",
            is_admin=False, exam_permission=False,
        )
        fields.update(overrides)
        user = User(**fields)
        self.db.add(user)
        self.db.commit()
        return user

    def add_certificate(self, person, **overrides):
        fields = dict(
            user_id=person.id, unique_code=f"CERT-{person.code}", level="architect", status="active",
            issue_date=datetime.utcnow() - timedelta(days=2), validity_term=5,
            valid_until=datetime.utcnow() + timedelta(days=365),
            file_path="private/certificate.pdf", filename="certificate.pdf", exam_score=100,
        )
        fields.update(overrides)
        cert = Certificate(**fields)
        self.db.add(cert)
        self.db.commit()
        return cert

    def url(self, person=None):
        return f"/users/public/by-code/{(person or self.person).code}"

    def auth(self, person):
        token = f"session-{person.id}"
        self.db.add(UserSession(user_id=person.id, token=token, expires_at=datetime.utcnow() + timedelta(hours=1)))
        self.db.commit()
        return {"Authorization": f"Bearer {token}"}

    def test_guest_response_is_explicitly_whitelisted(self):
        self.person.is_admin = True
        self.person.exam_permission = True
        self.db.commit()
        response = self.client.get(self.url())
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(set(data), {"id", "code", "first_name", "last_name", "email", "created_at", "certificate"})
        self.assertEqual(set(data["certificate"]), {"unique_code", "level", "status", "issue_date", "validity_term", "valid_until"})
        self.assertEqual(data["code"], self.person.code)
        self.assertEqual(data["certificate"]["unique_code"], self.certificate.unique_code)
        for private in ("personal_id", "phone", "password_hash", "file_path", "exam_score", "is_admin", "is_founder", "exam_permission", "photo_path"):
            self.assertNotIn(private, response.text)

    def test_id_and_code_routes_match_for_guest_and_authenticated_other(self):
        actor = self.add_user(2)
        headers = self.auth(actor)
        expected = self.client.get(self.url()).json()
        for url in (self.url(), f"/users/{self.person.id}/public-details"):
            for auth_headers in ({}, headers, {"Authorization": "Bearer invalid-or-expired"}):
                response = self.client.get(url, headers=auth_headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), expected)

    def test_all_existing_public_statuses_and_qualifications_resolve(self):
        for cert_status in ("active", "suspended", "expired"):
            for level in ("architect", "expert", "municipal", "legacy-level"):
                with self.subTest(status=cert_status, level=level):
                    self.certificate.status = cert_status
                    self.certificate.level = level
                    self.db.commit()
                    data = self.client.get(self.url()).json()
                    self.assertEqual(data["certificate"]["status"], cert_status)
                    self.assertEqual(data["certificate"]["level"], level)

    def test_active_past_end_date_is_reported_expired_without_database_write(self):
        self.certificate.valid_until = datetime.utcnow() - timedelta(seconds=1)
        self.db.commit()
        for url in (self.url(), f"/users/{self.person.id}/public-details"):
            self.assertEqual(self.client.get(url).json()["certificate"]["status"], "expired")
        self.db.expire_all()
        self.assertEqual(self.db.get(Certificate, self.certificate.id).status, "active")
        self.assertFalse(self.db.dirty)

    def test_null_end_date_preserves_status_and_nullable_fields(self):
        self.certificate.valid_until = None
        self.certificate.issue_date = None
        self.certificate.validity_term = None
        self.certificate.unique_code = None
        self.db.commit()
        cert = self.client.get(self.url()).json()["certificate"]
        self.assertEqual(cert["status"], "active")
        for field in ("unique_code", "issue_date", "validity_term", "valid_until"):
            self.assertIsNone(cert[field])

    def test_expiry_boundary_uses_utc_strictly_before_not_on_equal_instant(self):
        now = datetime(2026, 10, 8, 12, 0)
        for offset, expected in ((-1, "expired"), (0, "active"), (1, "active")):
            self.certificate.valid_until = now + timedelta(seconds=offset)
            self.db.commit()
            with patch.object(users, "datetime") as clock:
                clock.utcnow.return_value = now
                self.assertEqual(users.public_person_page(self.person.id, db=self.db).certificate.status, expected)

    def test_aware_end_date_uses_utc_offset_not_local_wall_time(self):
        now = datetime(2026, 10, 8, 12, 0)
        self.certificate.valid_until = datetime(2026, 10, 8, 15, 0, tzinfo=timezone(timedelta(hours=4)))
        # Keep the aware value in memory; SQLite DateTime normally reloads naive UTC.
        with self.db.no_autoflush, patch.object(users, "datetime") as clock:
            clock.utcnow.return_value = now
            result = users.public_person_page(self.person.id, db=self.db)
        self.assertEqual(result.certificate.status, "expired")

    def test_suspended_remains_suspended_even_after_end_date(self):
        self.certificate.status = "suspended"
        self.certificate.valid_until = datetime.utcnow() - timedelta(days=1)
        self.db.commit()
        self.assertEqual(self.client.get(self.url()).json()["certificate"]["status"], "suspended")

    def test_hidden_or_missing_certificates_and_unknown_users_return_404(self):
        for hidden in ("draft", "revoked", "inactive", "Active", ""):
            self.certificate.status = hidden
            self.db.commit()
            for url in (self.url(), f"/users/{self.person.id}/public-details"):
                self.assertEqual(self.client.get(url).status_code, 404)
        self.db.delete(self.certificate)
        self.db.commit()
        self.assertEqual(self.client.get(self.url()).status_code, 404)
        for url in ("/users/public/by-code/9999999999", "/users/999/public-details", "/users/0/public-details"):
            self.assertEqual(self.client.get(url).status_code, 404)

    def test_malformed_or_personal_number_codes_do_not_resolve(self):
        for code in ("abc", "123456789", "12345678901", "１２３４５６７８９０", "000000000x", "+000000001", " 000000001"):
            with self.subTest(code=code):
                self.assertEqual(self.client.get(f"/users/public/by-code/{code}").status_code, 404)

    def test_editable_certificate_code_never_controls_stable_lookup(self):
        other = self.add_user(2)
        self.add_certificate(other, unique_code=self.person.code)
        self.certificate.unique_code = other.code
        self.db.commit()
        self.assertEqual(self.client.get(self.url()).json()["id"], self.person.id)
        self.assertEqual(self.client.get(self.url(other)).json()["id"], other.id)

    def test_deleted_account_id_reuse_and_reregistration_never_redirect_old_qr_to_new_person(self):
        original_id, original_pid, original_code = self.person.id, self.person.personal_id, self.person.code
        qr_url = self.url()
        remember_user_code(self.db, self.person)
        self.db.delete(self.person)
        self.db.commit()
        self.assertEqual(self.client.get(qr_url).status_code, 404)
        self.assertEqual(self.db.get(UserCodeReservation, original_pid).code, original_code)

        replacement = self.add_user(2, id=original_id)
        self.add_certificate(replacement, unique_code=original_code)
        self.assertEqual(self.client.get(qr_url).status_code, 404)
        self.assertEqual(self.client.get(self.url(replacement)).json()["id"], original_id)

        payload = UserCreateWithVerification(
            personal_id=original_pid, first_name="Returned", last_name="Person", phone="555999999",
            email="returned@example.com", password="Test-password-123!", verification_code="1234",
        )
        with patch.object(users.email_verification, "verify_code", return_value=True), \
                patch.object(users, "hash_code", return_value="test-hash"), \
                patch.object(users, "get_settings", return_value=SimpleNamespace(founder_admin_email="founder@example.com")):
            returned = users.register(payload, db=self.db)
        self.assertEqual(returned.code, original_code)
        self.assertNotEqual(returned.id, original_id)
        self.assertEqual(self.client.get(qr_url).status_code, 404, "A reservation or uncertified account is not a public registry entry")
        self.add_certificate(self.db.get(User, returned.id))
        result = self.client.get(qr_url)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["id"], returned.id)
        self.assertEqual(result.json()["first_name"], "Returned")

    def test_existing_public_profile_contract_is_unchanged(self):
        response = self.client.get(f"/users/{self.person.id}/public")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {"first_name", "last_name", "email", "created_at"})

    def test_existing_authenticated_certificate_contract_is_unchanged(self):
        url = f"/users/{self.person.id}/certificate"
        self.assertEqual(self.client.get(url).status_code, 401)
        actor = self.add_user(2)
        response = self.client.get(url, headers=self.auth(actor))
        self.assertEqual(response.status_code, 200)
        self.assertIn("filename", response.json())
        self.assertEqual(response.json()["user_id"], self.person.id)

    def test_guests_cannot_write_ratings_comments_or_delete_comments(self):
        criteria = {key: 4 for key in ("integrity", "responsibility", "knowledge_experience", "professional_skills", "price_quality")}
        for headers in ({}, {"Authorization": "Bearer invalid"}):
            self.assertEqual(self.client.post(f"/reviews/{self.person.id}/rating", json={"criteria": criteria}, headers=headers).status_code, 401)
            self.assertEqual(self.client.post(f"/reviews/{self.person.id}/comments", json={"message": "Anonymous"}, headers=headers).status_code, 401)
            self.assertEqual(self.client.delete(f"/reviews/{self.person.id}/comments/1", headers=headers).status_code, 401)
        self.assertEqual(self.db.query(Rating).count(), 0)
        self.assertEqual(self.db.query(Comment).count(), 0)

    def test_guest_can_read_existing_comments_and_ratings_while_logged_actor_can_still_write(self):
        actor = self.add_user(2)
        headers = self.auth(actor)
        criteria = {key: 4 for key in ("integrity", "responsibility", "knowledge_experience", "professional_skills", "price_quality")}
        self.assertEqual(self.client.post(f"/reviews/{self.person.id}/rating", json={"criteria": criteria}, headers=headers).status_code, 201)
        self.assertEqual(self.client.post(f"/reviews/{self.person.id}/comments", json={"message": "Public review"}, headers=headers).status_code, 201)
        guest = self.client.get(f"/reviews/{self.person.id}/summary").json()
        signed = self.client.get(f"/reviews/{self.person.id}/summary", headers=headers).json()
        for field in ("target_user_id", "average", "ratings_count", "comments"):
            self.assertEqual(guest[field], signed[field])
        self.assertEqual(guest["average"], 4)
        self.assertEqual(guest["comments"][0]["message"], "Public review")
        self.assertIsNone(guest["actor_score"])
        self.assertEqual(signed["actor_score"], 4)

    def test_existing_expert_public_list_is_same_for_guest_and_other_without_drafts(self):
        self.certificate.level = "expert"
        self.db.add_all([
            ExpertUpload(user_id=self.person.id, unique_code="PUBLIC-ONE", status="submitted", building_function="Public project"),
            ExpertUpload(user_id=self.person.id, unique_code="PRIVATE-DRAFT", status="draft", building_function="Unpublished"),
        ])
        self.db.commit()
        actor = self.add_user(2)
        url = f"/expert-uploads/of/{self.person.id}"
        guest = self.client.get(url)
        signed = self.client.get(url, headers=self.auth(actor))
        self.assertEqual(guest.status_code, 200)
        self.assertEqual(guest.json(), signed.json())
        self.assertEqual([item["unique_code"] for item in guest.json()], ["PUBLIC-ONE"])

    def test_public_routes_are_reads_only_and_do_not_grant_permissions(self):
        before = (self.person.is_admin, self.person.exam_permission, self.person.exam_stage)
        self.client.get(self.url())
        self.client.get(f"/users/{self.person.id}/public-details")
        self.db.expire_all()
        user = self.db.get(User, self.person.id)
        self.assertEqual((user.is_admin, user.exam_permission, user.exam_stage), before)
        self.assertEqual(self.db.query(UserSession).count(), 0)
        self.assertEqual(self.db.query(UserCodeReservation).count(), 0)


if __name__ == "__main__":
    unittest.main()
