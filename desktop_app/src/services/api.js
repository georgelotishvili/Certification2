/**
 * API Client Service
 * Handles all HTTP requests to the backend
 */

// Import configuration
// Note: Configuration can come from:
// 1. window.API_CONFIG (if config/api.js is loaded via script tag) - PREFERRED
// 2. require('../config/api.js') (Node.js context)
// 3. Fallback configuration (if neither is available)
// Use a function to get config to avoid redeclaration errors
function getAPIConfig() {
    if (typeof window !== 'undefined' && window.API_CONFIG) {
        // Use config from window (loaded via script tag)
        console.log('Using API_CONFIG from window:', window.API_CONFIG.baseURL);
        return window.API_CONFIG;
    }
    
    try {
        // Try to use config file if available (Node.js context)
        if (typeof require !== 'undefined') {
            const config = require('../config/api.js');
            console.log('Using API_CONFIG from require:', config.baseURL);
            return config;
        }
    } catch (e) {
        // Ignore require errors in browser context
    }
    
    // Fallback configuration (browser/Electron context)
    console.warn('Using fallback API_CONFIG');
    return {
        // Backend URL - შეიცვალეთ production-ისთვის
        // შეგიძლიათ შეცვალოთ config/api.js ფაილში
        baseURL: 'http://localhost:8000',
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
        timeout: 30000,
    };
}

// Get configuration (don't declare as const/let to avoid conflicts)
const API_CONFIG = getAPIConfig();

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

class ApiClient {
  constructor() {
    this.baseURL = API_CONFIG.baseURL;
    this.timeout = API_CONFIG.timeout;
    this.token = null;
  }

  /**
   * Set authentication token
   */
  setToken(token) {
    this.token = token;
    // Store in localStorage for persistence
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  }

  /**
   * Get authentication token from localStorage
   */
  getToken() {
    if (!this.token) {
      this.token = localStorage.getItem('auth_token');
    }
    return this.token;
  }

  /**
   * Build full URL
   */
  buildURL(endpoint) {
    return `${this.baseURL}${endpoint}`;
  }

  /**
   * Make HTTP request
   */
  async request(method, endpoint, data = null, options = {}) {
    const url = this.buildURL(endpoint);
    const token = this.getToken();

    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Add authentication token if available
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // Add actor email header if user is logged in
    if (token && options.actorEmail) {
      headers['x-actor-email'] = options.actorEmail;
    }

    const config = {
      method,
      headers,
      ...options,
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      config.body = JSON.stringify(data);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      config.signal = controller.signal;

      const response = await fetch(url, config);
      clearTimeout(timeoutId);

      // Handle non-JSON responses
      const contentType = response.headers.get('content-type');
      let responseData;
      
      if (contentType && contentType.includes('application/json')) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }

      if (!response.ok) {
        throw new ApiError(
          responseData.detail || responseData.message || `HTTP ${response.status}`,
          response.status,
          responseData
        );
      }

      return responseData;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      
      // Handle network errors
      if (error.name === 'AbortError') {
        throw new ApiError('Request timeout', 408);
      }
      
      throw new ApiError(
        error.message || 'Network error',
        0,
        error
      );
    }
  }

  /**
   * GET request
   */
  async get(endpoint, options = {}) {
    return this.request('GET', endpoint, null, options);
  }

  /**
   * POST request
   */
  async post(endpoint, data, options = {}) {
    return this.request('POST', endpoint, data, options);
  }

  /**
   * PUT request
   */
  async put(endpoint, data, options = {}) {
    return this.request('PUT', endpoint, data, options);
  }

  /**
   * DELETE request
   */
  async delete(endpoint, options = {}) {
    return this.request('DELETE', endpoint, null, options);
  }

  /**
   * Login with email and password
   */
  async login(email, password) {
    const response = await this.post(API_CONFIG.endpoints.auth.login, {
      email,
      password,
    });
    
    // Store token
    if (response.token) {
      this.setToken(response.token);
    }
    
    // Store user info
    if (response.user) {
      localStorage.setItem('current_user', JSON.stringify(response.user));
    }
    
    return response;
  }

  /**
   * Logout - clear token and user data
   */
  logout() {
    this.setToken(null);
    localStorage.removeItem('current_user');
  }

  /**
   * Get current user from localStorage
   */
  getCurrentUser() {
    const userStr = localStorage.getItem('current_user');
    if (userStr) {
      try {
        return JSON.parse(userStr);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return !!this.getToken() && !!this.getCurrentUser();
  }
}

// Export singleton instance
let apiClient;
try {
  apiClient = new ApiClient();
} catch (error) {
  console.error('Failed to create ApiClient:', error);
  // Create a minimal fallback client
  apiClient = {
    login: () => Promise.reject(new Error('API client initialization failed')),
    logout: () => {},
    getCurrentUser: () => null,
    isAuthenticated: () => false,
  };
}

// Export for ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = apiClient;
}

// Export for browser/ES6
if (typeof window !== 'undefined') {
  window.apiClient = apiClient;
  console.log('API client initialized:', !!window.apiClient);
}

