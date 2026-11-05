"""Explicit step-up fixtures for synthetic, isolated administrative tests only."""
from datetime import datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import patch

from cryptography.fernet import Fernet

from backend.app.models import AdminMfaCredential, AdminMfaElevation
from backend.app.services import admin_mfa


TEST_MFA_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="


def install_mfa_settings(test_case, founder_email="founder@example.test"):
    settings_patch = patch.object(admin_mfa, "get_settings", return_value=SimpleNamespace(
        founder_admin_email=founder_email, admin_mfa_encryption_key=TEST_MFA_KEY,
    ))
    settings_patch.start()
    test_case.addCleanup(settings_patch.stop)


def add_admin_mfa_elevation(db, user_id, token):
    """Seed an enrolled, verified synthetic admin; caller owns its transaction."""
    now = datetime.utcnow()
    credential = db.get(AdminMfaCredential, user_id)
    if credential is None:
        credential = AdminMfaCredential(
            user_id=user_id, generation=0, enabled_at=now,
            secret_ciphertext=Fernet(TEST_MFA_KEY.encode()).encrypt(
                b"JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP").decode(),
        )
        db.add(credential)
    db.add(AdminMfaElevation(
        token_hash=sha256(token.encode()).hexdigest(), user_id=user_id,
        generation=credential.generation, verified_at=now, last_used_at=now,
        expires_at=now + timedelta(hours=1),
    ))
