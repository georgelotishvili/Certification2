/**
 * API Configuration
 * Backend URL - შეიცვალეთ production-ისთვის
 * 
 * მაგალითები:
 * - Development: 'http://localhost:8000'
 * - Production: 'https://gipc.org.ge' ან 'http://gipc.org.ge'
 */
(function() {
  'use strict';
  
  // Use IIFE to avoid global scope pollution
  const API_CONFIG = {
    // Backend URL - შეიცვალეთ production-ისთვის
    // Local development
    baseURL: 'http://localhost:8000',
    
    // Production (uncomment when ready and change URL)
    // baseURL: 'https://gipc.org.ge',
    
    endpoints: {
      auth: {
        login: '/auth/login',
        code: '/auth/code',
      },
      users: {
        profile: '/users/profile',
        public: '/users/{id}/public',
      },
      exam: {
        config: '/exam/config',
        verifyGate: '/exam/verify-gate',
      },
    },
    
    // Request timeout in milliseconds
    timeout: 30000,
  };

  // Export for Node.js (module.exports)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API_CONFIG;
  }

  // Export for browser/Electron (window.API_CONFIG)
  if (typeof window !== 'undefined') {
    window.API_CONFIG = API_CONFIG;
    console.log('API_CONFIG loaded:', API_CONFIG.baseURL);
  }
})();

