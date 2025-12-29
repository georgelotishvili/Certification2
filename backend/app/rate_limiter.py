"""
Simple in-memory rate limiter for API endpoints.
For production with multiple servers, use Redis-based rate limiting.
"""
from __future__ import annotations

import time
from collections import defaultdict
from threading import Lock
from typing import Dict, Tuple
from fastapi import HTTPException, status, Request


class RateLimiter:
    """Simple in-memory rate limiter."""
    
    def __init__(self, max_requests: int = 5, window_seconds: int = 60):
        """
        Initialize rate limiter.
        
        Args:
            max_requests: Maximum requests allowed in the time window
            window_seconds: Time window in seconds
        """
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._requests: Dict[str, list] = defaultdict(list)
        self._lock = Lock()
    
    def _get_client_ip(self, request: Request) -> str:
        """Get client IP from request."""
        # Check for proxy headers first
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip.strip()
        
        # Fall back to direct client IP
        if request.client:
            return request.client.host
        
        return "unknown"
    
    def _cleanup_old_requests(self, key: str, now: float) -> None:
        """Remove requests outside the current time window."""
        cutoff = now - self.window_seconds
        self._requests[key] = [t for t in self._requests[key] if t > cutoff]
    
    def check(self, request: Request) -> None:
        """
        Check if request is allowed. Raises HTTPException if rate limited.
        
        Args:
            request: FastAPI Request object
        """
        client_ip = self._get_client_ip(request)
        now = time.time()
        
        with self._lock:
            self._cleanup_old_requests(client_ip, now)
            
            if len(self._requests[client_ip]) >= self.max_requests:
                # Calculate wait time
                oldest = min(self._requests[client_ip]) if self._requests[client_ip] else now
                wait_seconds = int(self.window_seconds - (now - oldest)) + 1
                
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"ძალიან ბევრი მცდელობა. სცადე {wait_seconds} წამში."
                )
            
            # Record this request
            self._requests[client_ip].append(now)
    
    def reset(self, request: Request) -> None:
        """Reset rate limit for a client (e.g., after successful login)."""
        client_ip = self._get_client_ip(request)
        with self._lock:
            self._requests[client_ip] = []


# Pre-configured rate limiters for different endpoints
login_limiter = RateLimiter(max_requests=5, window_seconds=60)  # 5 attempts per minute
verification_limiter = RateLimiter(max_requests=3, window_seconds=60)  # 3 codes per minute
code_verify_limiter = RateLimiter(max_requests=5, window_seconds=60)  # 5 verifications per minute

