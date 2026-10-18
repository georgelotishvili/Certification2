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
        # 1. Configure API key and model
        updated = ai_assistant.update_ai_settings(
            payload=ai_assistant.AISettingsPayload(
                api_key="AIzaSyTestKey123456789",
                model="gemini-4-argon",
                custom_system_prompt="ყოველთვის შეამოწმე დიპლომი.",
            ),
            authorization=None,
            db=self.db,
        )
        self.assertTrue(updated["configured"])
        self.assertEqual(updated["model"], "gemini-4-argon")
        self.assertEqual(updated["allowed_models"], ["gemini-4-argon"])
        self.assertEqual(updated["masked_key"], "AIzaSy...6789")

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
        ) as mocked_gemini:
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


if __name__ == "__main__":
    unittest.main()
