from __future__ import annotations

from types import SimpleNamespace
import unittest

try:
    from backend.app.models import User, UserSession
    from backend.app.routers import auth
except ModuleNotFoundError:
    from app.models import User, UserSession
    from app.routers import auth


class _LogoutDb:
    def __init__(self, sessions=None):
        self.sessions = dict(sessions or {})
        self.info = {}
        self.users = {
            row.user_id: SimpleNamespace(id=row.user_id, is_admin=False)
            for row in self.sessions.values() if hasattr(row, "user_id")
        }
        self.user_lookups = []
        self.scalar_statements = []
        self.deleted = []
        self.commit_calls = 0

    def scalar(self, statement):
        self.scalar_statements.append(statement)
        params = statement.compile().params
        token = next(
            (value for key, value in params.items() if "token" in key),
            None,
        )
        return self.sessions.get(token)

    def delete(self, session) -> None:
        self.deleted.append(session)
        for token, stored_session in list(self.sessions.items()):
            if stored_session is session:
                del self.sessions[token]

    def get(self, model, identity):
        if model is not User:
            raise AssertionError("Logout must only look up its authenticated user")
        self.user_lookups.append(identity)
        return self.users.get(identity)

    def commit(self) -> None:
        self.commit_calls += 1


class LogoutSecurityTests(unittest.TestCase):
    def assert_empty_204(self, response) -> None:
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.body, b"")

    def test_valid_bearer_revokes_only_the_exact_user_session(self) -> None:
        target = SimpleNamespace(id=1, user_id=10, token="web-token")
        other = SimpleNamespace(id=2, user_id=20, token="other-token")
        db = _LogoutDb({"web-token": target, "other-token": other})

        response = auth.logout(authorization="Bearer web-token", db=db)

        self.assert_empty_204(response)
        self.assertEqual(db.deleted, [target])
        self.assertEqual(db.commit_calls, 1)
        self.assertNotIn("web-token", db.sessions)
        self.assertIs(db.sessions["other-token"], other)
        self.assertEqual(db.user_lookups, [target.user_id])
        self.assertEqual(db.info["audit_actor"]["id"], target.user_id)
        self.assertEqual(db.info["audit_logout_session_id"], target.id)

        statement = db.scalar_statements[0]
        self.assertIs(statement.column_descriptions[0]["entity"], UserSession)
        self.assertNotIn("exam_sessions", str(statement).lower())

    def test_logout_is_idempotent_for_an_already_revoked_token(self) -> None:
        target = SimpleNamespace(id=1, user_id=10, token="web-token")
        db = _LogoutDb({"web-token": target})

        first = auth.logout(authorization="Bearer web-token", db=db)
        second = auth.logout(authorization="Bearer web-token", db=db)

        self.assert_empty_204(first)
        self.assert_empty_204(second)
        self.assertEqual(db.deleted, [target])
        self.assertEqual(db.commit_calls, 1)
        self.assertEqual(db.user_lookups, [target.user_id])

    def test_missing_and_malformed_authorization_are_no_op_204(self) -> None:
        for authorization in (None, "", "Basic abc", "Bearer", "Bearer   "):
            with self.subTest(authorization=authorization):
                db = _LogoutDb({"abc": SimpleNamespace(token="abc")})

                response = auth.logout(authorization=authorization, db=db)

                self.assert_empty_204(response)
                self.assertEqual(db.scalar_statements, [])
                self.assertEqual(db.deleted, [])
                self.assertEqual(db.commit_calls, 0)
                self.assertEqual(db.user_lookups, [])
                self.assertEqual(db.info, {})

    def test_unknown_valid_bearer_is_no_op_204(self) -> None:
        db = _LogoutDb({"other-token": SimpleNamespace(token="other-token")})

        response = auth.logout(authorization="Bearer missing-token", db=db)

        self.assert_empty_204(response)
        self.assertEqual(len(db.scalar_statements), 1)
        self.assertEqual(db.deleted, [])
        self.assertEqual(db.commit_calls, 0)
        self.assertEqual(db.user_lookups, [])
        self.assertEqual(db.info, {})

    def test_bearer_scheme_is_case_insensitive_and_token_is_trimmed(self) -> None:
        target = SimpleNamespace(id=1, user_id=10, token="web-token")
        db = _LogoutDb({"web-token": target})

        response = auth.logout(authorization="bEaReR    web-token   ", db=db)

        self.assert_empty_204(response)
        self.assertEqual(db.deleted, [target])

    def test_router_exposes_post_logout_with_204_contract(self) -> None:
        route = next(
            route
            for route in auth.router.routes
            if getattr(route, "path", None) == "/logout"
        )

        self.assertEqual(route.methods, {"POST"})
        self.assertEqual(route.status_code, 204)


if __name__ == "__main__":
    unittest.main()
