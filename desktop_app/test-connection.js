/**
 * Test script to check backend and database connection
 * Run with: node test-connection.js
 */

const API_CONFIG = {
  baseURL: 'http://localhost:8000',
  timeout: 5000,
};

async function testConnection() {
  console.log('🔍 შემოწმება backend-ისა და ბაზასთან კავშირის...\n');

  // Test 1: Backend server availability
  console.log('1️⃣ Backend server-ის შემოწმება...');
  try {
    const response = await fetch(`${API_CONFIG.baseURL}/docs`, {
      method: 'GET',
      signal: AbortSignal.timeout(API_CONFIG.timeout),
    });
    
    if (response.ok) {
      console.log('✅ Backend server გაშვებულია და მუშაობს\n');
    } else {
      console.log(`⚠️ Backend server მუშაობს, მაგრამ status: ${response.status}\n`);
    }
  } catch (error) {
    console.log('❌ Backend server არ არის გაშვებული ან ვერ მიიღწევა');
    console.log(`   შეცდომა: ${error.message}\n`);
    console.log('💡 გაუშვით backend:');
    console.log('   cd ../certification/backend');
    console.log('   uvicorn app.main:app --reload --host 127.0.0.1 --port 8000\n');
    return;
  }

  // Test 2: Database connection (via API endpoint)
  console.log('2️⃣ ბაზასთან კავშირის შემოწმება...');
  try {
    // Try to get users list or any endpoint that requires DB
    const response = await fetch(`${API_CONFIG.baseURL}/users/profile?email=test@test.com`, {
      method: 'GET',
      headers: {
        'x-actor-email': 'test@test.com',
      },
      signal: AbortSignal.timeout(API_CONFIG.timeout),
    });

    // 404 or 401 is OK - means DB is connected but user doesn't exist
    if (response.status === 404 || response.status === 401 || response.status === 400) {
      console.log('✅ ბაზასთან კავშირი მუშაობს (endpoint-მა გამოიძახა, მაგრამ user არ მოიძებნა - ეს ნორმალურია)\n');
    } else if (response.ok) {
      console.log('✅ ბაზასთან კავშირი მუშაობს\n');
    } else {
      console.log(`⚠️ ბაზასთან კავშირი: status ${response.status}\n`);
    }
  } catch (error) {
    console.log('❌ ბაზასთან კავშირის შემოწმება ვერ მოხერხდა');
    console.log(`   შეცდომა: ${error.message}\n`);
  }

  // Test 3: Login endpoint availability
  console.log('3️⃣ Login endpoint-ის შემოწმება...');
  try {
    const response = await fetch(`${API_CONFIG.baseURL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'test@test.com',
        password: 'test',
      }),
      signal: AbortSignal.timeout(API_CONFIG.timeout),
    });

    const data = await response.json();
    
    if (response.status === 401) {
      console.log('✅ Login endpoint მუშაობს (401 - არასწორი credentials, ეს ნორმალურია)\n');
    } else if (response.status === 200) {
      console.log('✅ Login endpoint მუშაობს და authentication წარმატებულია\n');
    } else {
      console.log(`⚠️ Login endpoint: status ${response.status}`);
      console.log(`   Response: ${JSON.stringify(data, null, 2)}\n`);
    }
  } catch (error) {
    console.log('❌ Login endpoint-ის შემოწმება ვერ მოხერხდა');
    console.log(`   შეცდომა: ${error.message}\n`);
  }

  // Test 4: Check database file exists
  console.log('4️⃣ Database ფაილის არსებობის შემოწმება...');
  const fs = require('fs');
  const path = require('path');
  const dbPath = path.join(__dirname, '..', 'certification', 'backend', 'app.db');
  
  try {
    if (fs.existsSync(dbPath)) {
      const stats = fs.statSync(dbPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`✅ Database ფაილი არსებობს: ${dbPath}`);
      console.log(`   ზომა: ${sizeMB} MB\n`);
    } else {
      console.log(`⚠️ Database ფაილი არ მოიძებნა: ${dbPath}`);
      console.log('   Backend-მა შექმნის ფაილს პირველი გაშვებისას\n');
    }
  } catch (error) {
    console.log(`❌ Database ფაილის შემოწმება ვერ მოხერხდა: ${error.message}\n`);
  }

  console.log('✨ შემოწმება დასრულდა!\n');
  console.log('💡 თუ ყველა ტესტი წარმატებულია, შეგიძლიათ გამოიყენოთ Electron აპლიკაცია');
  console.log('   npm start\n');
}

// Run tests
testConnection().catch(error => {
  console.error('❌ კრიტიკული შეცდომა:', error);
  process.exit(1);
});

