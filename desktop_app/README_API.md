# API Integration Guide

## Backend Connection

ეს Electron აპლიკაცია დაკავშირებულია FastAPI backend-თან API-ის მეშვეობით.

### Backend Setup

1. **Backend-ის გაშვება:**
   ```bash
   cd ../certification/backend
   # ან
   cd "C:\Users\george\Desktop\certification kode\certification\backend"
   
   # Python virtual environment (თუ საჭიროა)
   python -m venv venv
   venv\Scripts\activate  # Windows
   
   # Dependencies installation
   pip install -r requirements.txt
   
   # Backend-ის გაშვება
   uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
   ```

2. **Backend URL Configuration:**
   - ლოკალური განვითარება: `http://localhost:8000` (default)
   - Production: `https://gipc.org.ge`
   
   URL შეიძლება შეიცვალოს `src/services/api.js` ფაილში:
   ```javascript
   const API_CONFIG = {
     baseURL: 'http://localhost:8000',  // ან 'https://gipc.org.ge'
   };
   ```

### API Endpoints

#### Authentication
- `POST /auth/login` - შესვლა email/password-ით
  - Request: `{ email: string, password: string }`
  - Response: `{ token: string, user: UserOut }`

#### Users
- `GET /users/profile?email={email}` - მომხმარებლის პროფილი
- `GET /users/{id}/public` - პუბლიკური პროფილი

#### Exam
- `GET /exam/config` - გამოცდის კონფიგურაცია
- `POST /exam/verify-gate` - gate password verification

### Session Management

- Token ინახება `localStorage`-ში (`auth_token`)
- User info ინახება `localStorage`-ში (`current_user`)
- Token ავტომატურად ემატება ყველა request-ში `Authorization: Bearer {token}` header-ით

### Error Handling

API client აბრუნებს `ApiError` კლასს შეცდომებისთვის:
- `401` - Unauthorized (არასწორი credentials)
- `404` - Not Found
- `0` - Network error (backend არ არის გაშვებული)

### Testing

1. დარწმუნდით რომ backend გაშვებულია `http://localhost:8000`
2. გახსენით Electron აპლიკაცია
3. დააკლიკეთ "შესვლა" ღილაკს
4. შეიყვანეთ email და password
5. შესვლის შემდეგ ღილაკი განახლდება მომხმარებლის სახელით

### Notes

- Backend-ის გაშვება აუცილებელია აპლიკაციის გამოსაყენებლად
- Production-ში URL შეიცვლება `https://gipc.org.ge`-ზე
- CORS middleware backend-ში უნდა იყოს კონფიგურირებული Electron-ისთვის

