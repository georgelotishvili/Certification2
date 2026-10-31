from __future__ import annotations

from datetime import datetime, timedelta
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

try:
    from backend.app.database import get_db
    from backend.app.models import Base, Certificate, Rating, User
    from backend.app.routers import registry, reviews
except ModuleNotFoundError:
    from app.database import get_db
    from app.models import Base, Certificate, Rating, User
    from app.routers import registry, reviews


class RegistryPaginationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        self.app = FastAPI()
        self.app.include_router(registry.router, prefix="/certified-persons")
        self.app.include_router(reviews.router, prefix="/reviews")
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.counter = 0

    def add_person(self, *, name=None, level="architect", status="active", certificate_code=None, **overrides):
        self.counter += 1
        number = self.counter
        fields = dict(personal_id=f"{number:011d}", first_name=name or f"Person{number:04d}", last_name="Example",
                      email=f"person{number}@example.invalid", phone=f"555{number:06d}",
                      code=f"{number:010d}", password_hash="PRIVATE-HASH", photo_path="PRIVATE-PHOTO",
                      created_at=datetime(2026, 1, 1) + timedelta(minutes=number))
        fields.update(overrides)
        user = User(**fields)
        self.db.add(user)
        self.db.flush()
        if status is not None:
            self.db.add(Certificate(user_id=user.id, unique_code=certificate_code, level=level, status=status))
        return user

    def get_page(self, **params):
        self.db.commit()
        response = self.client.get("/certified-persons/registry/page", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def add_rating(self, person, author, values):
        self.db.add(Rating(target_user_id=person.id, author_user_id=author.id, score=10,
                           **dict(zip(("integrity", "responsibility", "knowledge_experience", "professional_skills", "price_quality"), values))))

    def test_search_finds_older_person_beyond_original_500_cap(self):
        for _ in range(601):
            self.add_person()
        first = self.get_page()
        self.assertEqual((first["total"], first["filtered_total"], len(first["items"])), (601, 601, 50))
        self.assertNotIn("Person0001 Example", [person["full_name"] for person in first["items"]])
        found = self.get_page(q="Person0001")
        self.assertEqual((found["total"], found["filtered_total"]), (601, 1))
        self.assertEqual(found["items"][0]["full_name"], "Person0001 Example")
        self.assertEqual(self.get_page(q="0000000001")["items"][0]["id"], found["items"][0]["id"])

    def test_every_record_can_be_reached_once_using_bounded_pages(self):
        for _ in range(121):
            self.add_person()
        pages = [self.get_page(offset=offset) for offset in (0, 50, 100)]
        self.assertEqual([len(page["items"]) for page in pages], [50, 50, 21])
        ids = [person["id"] for page in pages for person in page["items"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(ids, list(range(121, 0, -1)))

    def test_last_page_is_clamped_after_deletion_and_empty_filter_has_zero_offset(self):
        for _ in range(51):
            self.add_person()
        self.assertEqual(self.get_page(offset=9999)["offset"], 50)
        self.assertEqual(self.get_page(offset=50, q="missing")["offset"], 0)
        self.db.delete(self.db.get(User, 51))
        self.assertEqual(self.get_page(offset=50)["offset"], 0)

    def test_total_includes_exactly_existing_public_statuses_and_certified_users(self):
        for status in ("active", "suspended", "expired", "draft", "revoked", None):
            self.add_person(status=status)
        page = self.get_page()
        self.assertEqual(page["total"], 3)
        self.assertEqual({person["certificate_status"] for person in page["items"]}, {"active", "suspended", "expired"})

    def test_search_normalizes_case_georgian_capitals_whitespace_and_literal_wildcards(self):
        person = self.add_person(name="ანა", last_name="ბერიძე", certificate_code="CERT_%_X")
        other = self.add_person(name="Ana", last_name="Abashidze")
        for query in ("ანა", "ანა   ბერიძე", "ᲐᲜᲐ", "%", "cert_%_x"):
            self.assertEqual([row["id"] for row in self.get_page(q=query)["items"]], [person.id])
        self.assertEqual([row["id"] for row in self.get_page(q="  ANA    ABASHIDZE  ")["items"]], [other.id])
        self.assertEqual(self.get_page(q="' OR 1=1 --")["filtered_total"], 0)

    def test_search_only_exposes_public_certificate_code_not_private_fields(self):
        self.add_person(certificate_code="VISIBLE-CODE", email="PRIVATE-MAIL@example.invalid", phone="PRIVATE-PHONE")
        for query in ("PRIVATE", "0000000001", "0000000000"):
            self.assertEqual(self.get_page(q=query)["filtered_total"], 0)
        self.assertEqual(self.get_page(q="VISIBLE-CODE")["filtered_total"], 1)
        exact_pid_page = self.get_page(q="00000000001")
        self.assertEqual(exact_pid_page["filtered_total"], 1)
        self.assertNotIn("personal_id", exact_pid_page["items"][0])
        self.assertNotIn("00000000001", str(exact_pid_page))

    def test_qualification_synonyms_unions_and_all_or_none_preserve_legacy_entries(self):
        ids = {}
        for key, aliases in registry.QUALIFICATION_ALIASES.items():
            ids[key] = {self.add_person(level=alias.upper()).id for alias in aliases}
        legacy = self.add_person(level="legacy-level")
        total = sum(len(group) for group in ids.values()) + 1
        for key, expected in ids.items():
            page = self.get_page(qualifications=key)
            self.assertEqual({person["id"] for person in page["items"]}, expected)
            self.assertTrue(all(person["qualification"] == key for person in page["items"]))
            self.assertEqual(page["total"], total)
        union = self.get_page(qualifications="architect,municipal")
        self.assertEqual({person["id"] for person in union["items"]}, ids["architect"] | ids["municipal"])
        for selection in ("", "architect,expert,municipal"):
            page = self.get_page(qualifications=selection)
            self.assertEqual(page["filtered_total"], total)
            self.assertIn(legacy.id, [person["id"] for person in page["items"]])

    def test_search_filters_and_sort_are_applied_before_limit_and_count(self):
        for number in range(75):
            self.add_person(name=f"Match{number:03d}", level="expert" if number % 2 else "architect")
        page = self.get_page(q="Match", qualifications="expert", sort="name_asc", limit=5, offset=5)
        self.assertEqual((page["total"], page["filtered_total"]), (75, 37))
        self.assertEqual([person["full_name"] for person in page["items"]], [f"Match{number:03d} Example" for number in (11, 13, 15, 17, 19)])

    def test_georgian_name_order_matches_alphabet_including_uppercase_punctuation_and_historic_letters(self):
        for name in ("ჰანა", "ბექა", "ანა", "ᲒᲘᲝᲠᲒᲘ", "ა-ბ", "აჰ", "ჱ", "თ", "ჯ", "ჴ", "Ána"):
            self.add_person(name=name, last_name="")
        expected = ["ა-ბ", "ანა", "აჰ", "ბექა", "ᲒᲘᲝᲠᲒᲘ", "ჱ", "თ", "ჴ", "ჯ", "ჰანა", "Ána"]
        self.assertEqual([row["full_name"] for row in self.get_page(sort="name_asc")["items"]], expected)
        self.assertEqual([row["full_name"] for row in self.get_page(sort="name_desc")["items"]], expected[::-1])

    def test_rating_average_and_rounding_match_review_summary_and_sort_across_pages(self):
        low, high, unrated = [self.add_person() for _ in range(3)]
        author, second = self.add_person(status=None), self.add_person(status=None)
        self.add_rating(low, author, [1, 2, 3, 4, 5])
        self.add_rating(low, second, [0, 0, 0, 0, 0])
        self.add_rating(high, author, [4.21, 3.18, 4.17, 5, 3.08])
        self.db.commit()
        items = self.get_page(sort="rating_desc", limit=1)["items"]
        self.assertEqual(items[0]["id"], high.id)
        self.assertEqual(self.get_page(sort="rating_desc", limit=1, offset=1)["items"][0]["id"], low.id)
        self.assertEqual(self.get_page(sort="rating_asc", limit=1)["items"][0]["id"], unrated.id)
        for person in self.get_page()["items"]:
            average = self.client.get(f"/reviews/{person['id']}/summary").json()["average"]
            self.assertEqual(person["rating"], average)

    def test_equal_ratings_and_dates_have_stable_pagination_order(self):
        for _ in range(9):
            self.add_person(created_at=datetime(2026, 1, 1))
        for sort in ("rating_desc", "rating_asc", "date_desc", "date_asc"):
            ids = []
            for offset in (0, 3, 6):
                ids.extend(person["id"] for person in self.get_page(sort=sort, limit=3, offset=offset)["items"])
            self.assertEqual(ids, list(range(9, 0, -1)))

    def test_public_allowlist_and_photo_url_do_not_leak_private_data(self):
        self.add_person(is_admin=True, exam_permission=True)
        page = self.get_page()
        person = page["items"][0]
        self.assertEqual(set(person), {"id", "full_name", "photo_url", "unique_code", "qualification", "certificate_status", "rating", "registration_date"})
        self.assertEqual(person["photo_url"], f"http://testserver/users/{person['id']}/photo/file")
        self.assertNotIn("PRIVATE", str(page))
        self.assertEqual(self.db.query(User).count(), 1)

    def test_legacy_endpoint_remains_list_with_limit_offset_defaults_and_raw_level(self):
        for _ in range(3):
            self.add_person(level="architect_expert")
        self.db.commit()
        response = self.client.get("/certified-persons/registry", params={"limit": 1, "offset": 1})
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.json(), list)
        self.assertEqual(response.json()[0]["id"], 2)
        self.assertEqual(response.json()[0]["qualification"], "architect_expert")
        self.assertEqual(len(self.client.get("/certified-persons/registry").json()), 3)

    def test_response_is_bounded_and_invalid_parameters_are_rejected(self):
        for params in ({"limit": 101}, {"limit": 0}, {"offset": -1}, {"sort": "unknown"}, {"q": "x" * 301}, {"qualifications": "unknown"}):
            response = self.client.get("/certified-persons/registry/page", params=params)
            self.assertEqual(response.status_code, 422)
        self.assertEqual(self.get_page()["items"], [])

    def test_query_count_is_constant_not_one_per_person(self):
        for _ in range(60):
            self.add_person()
        self.db.commit()
        statements = []
        listener = lambda connection, cursor, statement, parameters, context, executemany: statements.append(statement)
        event.listen(self.engine, "before_cursor_execute", listener)
        try:
            for limit in (1, 50):
                statements.clear()
                self.get_page(limit=limit, q="Person")
                self.assertEqual(len(statements), 4)
                self.assertFalse(any("password_hash" in sql or "personal_id" in sql for sql in statements))
        finally:
            event.remove(self.engine, "before_cursor_execute", listener)


if __name__ == "__main__":
    unittest.main()
