"""
Simple in-memory rate limiter for API endpoints.
For production with multiple servers, use Redis-based rate limiting.

Proxy trust contract:
- X-Forwarded-For is never read here because a direct client can choose it.
- X-Real-IP is accepted only when the ASGI peer is a loopback proxy.
- Before deployment, Nginx must overwrite X-Real-IP with ``$remote_addr`` and
  must not pass an attacker-controlled X-Forwarded-For value to Uvicorn.
"""
from __future__ import annotations

import ipaddress
import time
from collections import defaultdict
from threading import Lock
from typing import Dict, Hashable
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
        self._requests: Dict[Hashable, list[float]] = defaultdict(list)
        self._lock = Lock()
        self._last_full_cleanup = 0.0
        self._full_cleanup_interval = max(
            1.0,
            min(float(window_seconds), 60.0),
        )
    
    def _get_client_ip(self, request: Request) -> str:
        """Return a client-controlled-header-safe address for rate limiting.

        Direct clients are always keyed by their ASGI socket address. A local
        reverse proxy may provide X-Real-IP, but only when the peer address is
        loopback and the header is a syntactically valid IP address.
        """
        peer_host = request.client.host.strip() if request.client else ""
        try:
            peer_ip = ipaddress.ip_address(peer_host)
        except ValueError:
            peer_ip = None

        if peer_ip is not None and peer_ip.is_loopback:
            real_ip_header = (request.headers.get("x-real-ip") or "").strip()
            try:
                return str(ipaddress.ip_address(real_ip_header))
            except ValueError:
                pass

        if peer_ip is not None:
            return str(peer_ip)
        return peer_host or "unknown"
    
    def _cleanup_old_requests(
        self,
        key: Hashable,
        now: float,
    ) -> list[float]:
        """Remove expired timestamps for one key without retaining empty keys."""
        cutoff = now - self.window_seconds
        retained = [
            timestamp
            for timestamp in self._requests.get(key, ())
            if timestamp > cutoff
        ]
        if retained:
            self._requests[key] = retained
        else:
            self._requests.pop(key, None)
        return retained

    def _cleanup_all_requests(self, now: float) -> None:
        """Periodically discard fully expired keys to bound in-memory growth."""
        for key in list(self._requests):
            self._cleanup_old_requests(key, now)
        self._last_full_cleanup = now

    def _maybe_cleanup_all_requests(self, now: float) -> None:
        if (
            now < self._last_full_cleanup
            or now - self._last_full_cleanup >= self._full_cleanup_interval
        ):
            self._cleanup_all_requests(now)

    def check_key(self, key: Hashable) -> None:
        """Check and record an attempt for an arbitrary hashable key."""
        now = time.time()

        with self._lock:
            self._maybe_cleanup_all_requests(now)
            requests = self._cleanup_old_requests(key, now)

            if len(requests) >= self.max_requests:
                oldest = min(requests) if requests else now
                wait_seconds = int(self.window_seconds - (now - oldest)) + 1

                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"ძალიან ბევრი მცდელობა. სცადე {wait_seconds} წამში."
                )

            requests.append(now)
            self._requests[key] = requests

    def reset_key(self, key: Hashable) -> None:
        """Reset one arbitrary key without affecting any other key."""
        with self._lock:
            self._requests.pop(key, None)
    
    def check(self, request: Request) -> None:
        """
        Check if request is allowed. Raises HTTPException if rate limited.
        
        Args:
            request: FastAPI Request object
        """
        self.check_key(self._get_client_ip(request))
    
    def reset(self, request: Request) -> None:
        """Reset rate limit for a client (e.g., after successful login)."""
        self.reset_key(self._get_client_ip(request))


# Pre-configured rate limiters for different endpoints
login_limiter = RateLimiter(max_requests=5, window_seconds=60)  # 5 attempts per minute
login_account_limiter = RateLimiter(max_requests=5, window_seconds=60)
verification_limiter = RateLimiter(max_requests=3, window_seconds=60)  # 3 codes per minute
verification_account_limiter = RateLimiter(max_requests=3, window_seconds=60)
code_verify_limiter = RateLimiter(max_requests=5, window_seconds=60)  # 5 verifications per minute

