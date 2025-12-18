Certification — Local Run Guide (Windows)

Requirements
- Python 3.10+ installed and available as `py -3`

Quick start (one click)
1) Double–click `start.ps1` (or right–click → Run with PowerShell).
   - Starts backend (FastAPI) at `http://127.0.0.1:8000`
   - Starts static frontend at `http://127.0.0.1:3000`
   - Opens the landing page automatically

Structure overview
```
frontend/
  assets/ (fonts, svg, future images)
  pages/  (index, admin, exam, registrations)
  scripts/
  styles/
backend/
  app/      (FastAPI application)
  scripts/  (seed, migrations, utilities)
```

Manual start (optional)
- Backend
  ```powershell
  cd backend
  py -3 -m venv .venv
  .\.venv\Scripts\Activate.ps1
  pip install -r requirements.txt
  uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
  ```
- Frontend
  ```powershell
  cd <project-root>
  py -3 -m http.server 3000
  ```

How to use
- Open `http://127.0.0.1:3000/frontend/pages/index.html`
- Authorize (email saved locally). If you use `naormala@gmail.com`, you are the founder admin.
- Admin page: `http://127.0.0.1:3000/frontend/pages/admin.html`
  - „გამოცდა“ — exam settings section
  - „შედეგები“ — results section (Admin API Key optional)
  - „რეგისტრაციები“ — registered users list (search/filter/sort)

Notes
- Database file `backend/app.db` is created automatically on first run via SQLAlchemy.
- Admin API Key is optional; keep it empty for local testing.


