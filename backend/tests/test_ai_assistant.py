from __future__ import annotations

from datetime import datetime
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

try:
    from backend.app.models import Base, Statement, User
    from backend.app.routers import ai_assistant
except ModuleNotFoundError:
    from app.models import Base, Statement, User
    from app.routers import ai_assistant


class AiAssistantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.media_root = Path(self.temp_dir.name)

        auth_patch = patch.object(
            ai_assistant,
            "_require_admin",
            return_value=SimpleNamespace(email="admin@example.test"),
        )
        auth_patch.start()
        self.addCleanup(auth_patch.stop)

        media_patch = patch.object(
            ai_assistant,
            "ensure_media_root",
            return_value=self.media_root,
        )
        media_patch.start()
        self.addCleanup(media_patch.stop)

        resolve_patch = patch.object(
            ai_assistant,
            "resolve_storage_path",
            side_effect=lambda rel: self.media_root / rel,
        )
        resolve_patch.start()
        self.addCleanup(resolve_patch.stop)

    def test_settings_and_chat_with_attachment_and_letter_proposal(self):
        updated = ai_assistant.update_ai_settings(
            payload=ai_assistant.AISettingsPayload(
                api_key="AIzaSyTestKey123456789",
                openai_api_key="sk-test-openai-key-123456",
                model="gemini-4-argon",
                reasoning_level="ultra",
                custom_system_prompt="ყოველთვის შეამოწმე დიპლომი.",
            ),
            authorization=None,
            db=self.db,
        )
        self.assertTrue(updated["configured"])
        self.assertEqual(updated["model"], "gemini-4-argon")
        self.assertEqual(updated["reasoning_level"], "ultra")
        self.assertEqual(
            updated["allowed_models"],
            ["gemini-4-argon", "chatgpt-sol", "chatgpt-astra"],
        )
        self.assertEqual(updated["masked_key"], "AIzaSy...6789")
        self.assertEqual(updated["masked_openai_key"], "sk-tes...3456")

        # 2. Add a user and a statement with a PDF attachment
        user = User(
            id=1,
            personal_id="01001011111",
            first_name="გიორგი",
            last_name="ბერიძე",
            phone="599112233",
            email="giorgi@example.test",
            password_hash="hash",
            code="1000000001",
            created_at=datetime(2026, 10, 18, 8, 0),
        )
        self.db.add(user)
        self.db.flush()

        pdf_rel = "statements/1/diploma.pdf"
        pdf_file = self.media_root / pdf_rel
        pdf_file.parent.mkdir(parents=True, exist_ok=True)
        pdf_file.write_bytes(b"%PDF-1.4 Fake Diploma Content")

        stmt = Statement(
            id=10,
            user_id=user.id,
            message="1) კატეგორია A — გთხოვთ დამიშვათ გამოცდაზე.",
            attachment_path=pdf_rel,
            attachment_filename="diploma.pdf",
            attachment_mime_type="application/pdf",
            attachment_size_bytes=29,
            created_at=datetime(2026, 10, 18, 9, 0),
        )
        self.db.add(stmt)
        self.db.commit()

        fake_gemini_response = """შევისწავლე გიორგი ბერიძის განცხადება და მიბმული დიპლომი (diploma.pdf).
დოკუმენტები სრულად აკმაყოფილებს A კატეგორიის მოთხოვნებს. გთავაზობთ გამოცდის დაგეგმვის წერილის გაგზავნას თქვენი დასტურის შემდეგ:

<PROPOSED_LETTER>
{
  "user_id": 1,
  "statement_id": 10,
  "template_mode": "exam",
  "period": "morning",
  "event_date": "2026-10-22",
  "event_time": "10:00",
  "candidate_category": "A",
  "reason": "წარმოდგენილია არქიტექტურის დიპლომი და განცხადება A კატეგორიაზე.",
  "subject": "გამოცდაზე დაშვება",
  "body": "ადრესატი: {name}\\n\\nთქვენი გამოცდა დაიგეგმა {date}, {time}-ზე."
}
</PROPOSED_LETTER>"""

        with patch.object(
            ai_assistant, "_call_gemini_api", return_value=fake_gemini_response
        ) as mocked_gemini, patch.object(
            ai_assistant, "_today_in_tbilisi", return_value=datetime(2026, 10, 14).date()
        ):
            resp = ai_assistant.ai_chat(
                payload=ai_assistant.AIChatRequest(
                    messages=[
                        ai_assistant.AIChatMessage(
                            role="user",
                            content="გააანალიზე გიორგი ბერიძის განცხადება",
                        )
                    ],
                    mode="statements_analysis",
                    statement_id=10,
                ),
                authorization=None,
                db=self.db,
            )

            # Verify Gemini received the inline PDF attachment
            call_kwargs = mocked_gemini.call_args.kwargs
            sent_parts = call_kwargs["contents"][-1]["parts"]
            has_inline_pdf = any(
                p.get("inline_data", {}).get("mime_type") == "application/pdf"
                for p in sent_parts
            )
            self.assertTrue(has_inline_pdf)

        self.assertIn("შევისწავლე გიორგი ბერიძის განცხადება", resp["reply"])
        self.assertNotIn("<PROPOSED_LETTER>", resp["reply"])
        self.assertEqual(len(resp["inspected_attachments"]), 1)
        self.assertIn("diploma.pdf", resp["inspected_attachments"][0])

        self.assertEqual(len(resp["proposed_letters"]), 1)
        prop = resp["proposed_letters"][0]
        self.assertEqual(prop["user_id"], 1)
        self.assertEqual(prop["statement_id"], 10)
        self.assertEqual(prop["to_email"], "giorgi@example.test")
        self.assertEqual(prop["candidate_category"], "A")
        self.assertIn("გიორგი ბერიძე", prop["body"])
        self.assertIn("2026-10-22", prop["body"])

    def test_recipient_resolution_prevents_sending_letter_to_wrong_user(self):
        user_a = User(
            id=48,
            personal_id="36001053988",
            first_name="ნათია",
            last_name="ფოფხაძე",
            phone="599000048",
            email="natiap4@gmail.com",
            password_hash="hash",
            code="1000000048",
            created_at=datetime(2026, 10, 17, 10, 0),
        )
        user_b = User(
            id=51,
            personal_id="01019077888",
            first_name="გიორგი",
            last_name="ლოთიშვილი",
            phone="599000051",
            email="lotishvili@example.test",
            password_hash="hash",
            code="1000000051",
            created_at=datetime(2026, 10, 18, 9, 0),
        )
        self.db.add_all([user_a, user_b])
        self.db.commit()

        users_by_id = {48: user_a, 51: user_b}
        templates_map = {"exam": ai_assistant._template_out("exam", None)}

        # Even if AI puts user_id=48 by mistake when admin asked about გიორგი ლოთიშვილს,
        # _parse_proposed_letters resolves to user_b (51) and fills official template with user_b's data.
        raw_ai_output = """მოვამზადე წერილი გიორგი ლოთიშვილისთვის:
<PROPOSED_LETTER>
{
  "user_id": 48,
  "template_mode": "exam",
  "period": "morning",
  "event_date": "2026-10-23",
  "event_time": "10:00",
  "candidate_category": "A",
  "subject": "გამოცდა",
  "body": "ადრესატი: ნათია ფოფხაძე"
}
</PROPOSED_LETTER>"""

        _, proposals = ai_assistant._parse_proposed_letters(
            raw_ai_output,
            users_by_id=users_by_id,
            templates_map=templates_map,
            default_date="2026-10-23",
            schedule_times={"morning": "10:00", "evening": "15:00"},
            last_user_message="გიორგი ლოთიშვილს მოუმზადე გამოცდის წერილი",
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["user_id"], 51)
        self.assertEqual(proposals[0]["user_name"], "გიორგი ლოთიშვილი")
        self.assertEqual(proposals[0]["to_email"], "lotishvili@example.test")
        self.assertIn("გიორგი ლოთიშვილი", proposals[0]["body"])
        self.assertNotIn("ნათია ფოფხაძე", proposals[0]["body"])

    def test_full_site_context_download_files_and_computer_attachments(self):
        ai_assistant.update_ai_settings(
            payload=ai_assistant.AISettingsPayload(
                api_key="AIzaSyTestKey123456789",
                model="gemini-4-argon",
                reasoning_level="high",
            ),
            authorization=None,
            db=self.db,
        )
        user = User(
            id=5,
            personal_id="01001055555",
            first_name="დავით",
            last_name="კაპანაძე",
            phone="599555555",
            email="davit@example.test",
            password_hash="hash",
            code="1000000005",
            created_at=datetime(2026, 10, 18, 8, 0),
        )
        self.db.add(user)
        self.db.flush()

        try:
            from backend.app.models import (
                AppFile,
                Certificate,
                Comment,
                ExpertUpload,
                PlanningLetter,
                Regulation,
                SiteDocument,
            )
        except ModuleNotFoundError:
            from app.models import (
                AppFile,
                Certificate,
                Comment,
                ExpertUpload,
                PlanningLetter,
                Regulation,
                SiteDocument,
            )

        cert = Certificate(
            id=1,
            user_id=user.id,
            level="architect_expert",
            status="active",
            exam_score=92,
            issue_date=datetime(2026, 1, 10),
            filename="cert.pdf",
            file_path="certificates/5/cert.pdf",
            mime_type="application/pdf",
        )
        comment = Comment(
            id=1,
            target_user_id=user.id,
            author_user_id=user.id,
            message="ძალიან კარგი სერვისია",
        )
        site_doc = SiteDocument(
            id=1,
            title="წესდება",
            content="წესდების ტექსტი",
            filename="charter.pdf",
            file_path="documents/charter.pdf",
            file_size_bytes=2048,
        )
        reg = Regulation(
            id=1,
            title="41-ე დადგენილება",
            filename="reg41.pdf",
            file_path="regulations/reg41.pdf",
            order_index=1,
        )
        exp_up = ExpertUpload(
            id=1,
            user_id=user.id,
            unique_code="EXP-001",
            building_function="საცხოვრებელი",
            cadastral_code="01.10.12.001.001",
            project_address="თბილისი",
            expertise_filename="exp.pdf",
            expertise_path="expert_uploads/5/exp.pdf",
            project_filename="proj.pdf",
            project_path="expert_uploads/5/proj.pdf",
            status="submitted",
        )
        letter = PlanningLetter(
            id=1,
            user_id=user.id,
            kind="exam",
            event_date=datetime(2026, 10, 22).date(),
            event_time="10:00",
            request_id="req-001",
            request_fingerprint="fp-001",
            to_email=user.email,
            subject="შეტყობინება",
            body="ტექსტი",
            created_by="admin@example.test",
            status="sent",
        )
        app_file = AppFile(
            id=1,
            filename="stmt.pdf",
            mime_type="application/pdf",
            size_bytes=512,
            storage_path="statements/5/stmt.pdf",
        )
        self.db.add_all([cert, comment, site_doc, reg, exp_up, letter, app_file])
        self.db.commit()

        fake_reply = """მოვამზადე ანგარიში და წერილი კომპიუტერის ფაილით:
<PROPOSED_LETTER>
{
  "user_id": 5,
  "template_mode": "custom",
  "subject": "დოკუმენტის გადაგზავნა",
  "body": "ადრესატი: დავით კაპანაძე\\n\\nგთხოვთ იხილოთ მიბმული ფაილი.",
  "computer_attachment_path": "docs/charter.pdf"
}
</PROPOSED_LETTER>
<DOWNLOAD_FILE>
{
  "mode": "generated",
  "filename": "sia.csv",
  "mime_type": "text/csv",
  "title": "რეგისტრირებულ პირთა სია",
  "auto_download": true,
  "content": "სახელი,პირადი ნომერი\\nდავით კაპანაძე,01001055555"
}
</DOWNLOAD_FILE>"""

        with patch.object(ai_assistant, "_call_gemini_api", return_value=fake_reply) as mocked_gemini:
            resp = ai_assistant.ai_chat(
                payload=ai_assistant.AIChatRequest(
                    messages=[
                        ai_assistant.AIChatMessage(
                            role="user",
                            content="ჩამოწერე სია და გაუგზავნე დავით კაპანაძეს docs/charter.pdf",
                        )
                    ],
                    attachments=[
                        ai_assistant.AIChatAttachment(
                            filename="screen1.png",
                            mime_type="image/png",
                            data_base64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        )
                    ],
                    computer_files=[
                        ai_assistant.AIComputerFileEntry(
                            path="docs/charter.pdf",
                            name="charter.pdf",
                            size_bytes=1024,
                            mime_type="application/pdf",
                        )
                    ],
                ),
                authorization=None,
                db=self.db,
            )
            sent_context = mocked_gemini.call_args.kwargs["contents"][-1]["parts"][0]["text"]
            for required_section in (
                "registered_users",
                "certificates_registry",
                "statements",
                "exam_schedules_calendar",
                "public_reviews_and_ratings",
                "expert_portfolio_uploads",
                "site_documents",
                "regulations",
                "guide_videos",
                "app_files_and_forms",
                "local_computer_files",
            ):
                self.assertIn(required_section, sent_context)

        self.assertEqual(len(resp["proposed_letters"]), 1)
        self.assertEqual(resp["proposed_letters"][0]["computer_attachment_path"], "docs/charter.pdf")
        self.assertEqual(len(resp["download_files"]), 1)
        self.assertEqual(resp["download_files"][0]["filename"], "sia.csv")
        self.assertTrue(resp["download_files"][0]["data_base64"])

    def test_ensure_kb_seeded_is_atomic_and_self_healing(self):
        import zipfile
        seed_zip = self.media_root / "test_seed.zip"
        with zipfile.ZipFile(seed_zip, "w") as zf:
            zf.writestr("კანონმდებლობა/doc1.txt", "დოკუმენტი 1 ტექსტი".encode("utf-8"))
            zf.writestr("კანონმდებლობა/doc2.txt", "დოკუმენტი 2 ტექსტი".encode("utf-8"))

        with patch.object(ai_assistant, "_seed_zip_path", return_value=seed_zip):
            items1 = ai_assistant._ensure_kb_seeded(force=True)
            self.assertEqual(len(items1), 2)
            kb_dir = ai_assistant._kb_root_dir()
            first_id = items1[0]["id"]
            first_txt = kb_dir / "texts" / f"{first_id}.txt"
            self.assertTrue(first_txt.is_file())

            # 1. Self-healing: delete one extracted text file without changing manifest or zip
            first_txt.unlink()
            self.assertFalse(first_txt.is_file())
            items2 = ai_assistant._ensure_kb_seeded(force=False)
            self.assertEqual(len(items2), 2)
            self.assertTrue(first_txt.is_file(), "Missing seed text file should be self-healed")

            # 2. Atomic failure safety: corrupt seed zip and force re-seed -> old files and manifest remain intact
            seed_zip.write_bytes(b"corrupt-not-a-zip")
            items3 = ai_assistant._ensure_kb_seeded(force=True)
            self.assertEqual(items3, items2)
            self.assertTrue(first_txt.is_file(), "Existing seed files must not be wiped when seed zip is unreadable")

            # 3. Mid-replace failure rolls back .bak files so files on disk match manifest.json
            with zipfile.ZipFile(seed_zip, "w") as zf:
                zf.writestr("კანონმდებლობა/doc1.txt", "განახლებული ტექსტი 1".encode("utf-8"))
                zf.writestr("კანონმდებლობა/doc2.txt", "განახლებული ტექსტი 2".encode("utf-8"))

            orig_replace = Path.replace
            replace_calls = {"count": 0}

            def fail_on_manifest_replace(self_path, target):
                replace_calls["count"] += 1
                if str(target).endswith("manifest.json"):
                    raise OSError("Simulated failure replacing manifest.json after files were replaced")
                return orig_replace(self_path, target)

            with patch.object(Path, "replace", fail_on_manifest_replace):
                items4 = ai_assistant._ensure_kb_seeded(force=True)
            self.assertEqual(len(items4), 2)
            self.assertEqual(first_txt.read_text(encoding="utf-8").strip(), "დოკუმენტი 1 ტექსტი")

    def test_concurrent_kb_uploads_deletes_and_reseeds_do_not_clobber_each_other(self):
        import asyncio
        from concurrent.futures import ThreadPoolExecutor
        import io
        import zipfile
        from fastapi import UploadFile

        seed_zip = self.media_root / "concurrent_seed.zip"
        with zipfile.ZipFile(seed_zip, "w") as zf:
            for i in range(1, 5):
                zf.writestr(f"კანონმდებლობა/seed_{i}.txt", f"საბაზისო დოკუმენტი {i}".encode("utf-8"))

        with patch.object(ai_assistant, "_seed_zip_path", return_value=seed_zip):
            initial = ai_assistant._ensure_kb_seeded(force=True)
            self.assertEqual(len(initial), 4)
            seed_ids_by_name = {it["filename"]: it["id"] for it in initial}

            def upload_worker(idx: int):
                uf = UploadFile(
                    filename=f"custom_{idx}.md",
                    file=io.BytesIO(f"# დამატებითი დოკუმენტი {idx}\nშინაარსი {idx}".encode("utf-8")),
                )
                return asyncio.run(
                    ai_assistant.upload_ai_knowledge_base_files(
                        files=[uf],
                        folder_name="ატვირთული",
                        authorization=None,
                        db=self.db,
                    )
                )

            def delete_worker(seed_fname: str):
                return ai_assistant.delete_ai_knowledge_base_file(
                    doc_id=seed_ids_by_name[seed_fname],
                    authorization=None,
                    db=self.db,
                )

            def reader_worker():
                return ai_assistant._load_kb_cache()

            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = []
                for i in range(1, 7):
                    futures.append(pool.submit(upload_worker, i))
                futures.append(pool.submit(delete_worker, "seed_2.txt"))
                futures.append(pool.submit(delete_worker, "seed_3.txt"))
                for _ in range(4):
                    futures.append(pool.submit(reader_worker))
                for fut in futures:
                    fut.result()

            items, texts_by_id = ai_assistant._load_kb_cache()
            filenames = {it["filename"] for it in items}
            for i in range(1, 7):
                self.assertIn(f"custom_{i}.md", filenames)
            self.assertIn("seed_1.txt", filenames)
            self.assertIn("seed_4.txt", filenames)
            self.assertNotIn("seed_2.txt", filenames)
            self.assertNotIn("seed_3.txt", filenames)
            self.assertEqual(len(items), 8)
            for it in items:
                self.assertTrue(texts_by_id.get(it["id"]), f"Missing text for {it['filename']}")

            # Restoring defaults brings back deleted seeds while preserving all 6 concurrent uploads
            restored = ai_assistant.restore_ai_knowledge_base_defaults(authorization=None, db=self.db)
            restored_names = {it["filename"] for it in restored["items"]}
            self.assertEqual(len(restored["items"]), 10)
            for i in range(1, 5):
                self.assertIn(f"seed_{i}.txt", restored_names)
            for i in range(1, 7):
                self.assertIn(f"custom_{i}.md", restored_names)


if __name__ == "__main__":
    unittest.main()


