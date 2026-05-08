import asyncio
import logging
from aiohttp import ClientSession, ClientTimeout, ClientError
from services.metrics import track_success, track_failure

log = logging.getLogger("reviewcash.http")

# Default timeout for all requests
DEFAULT_TIMEOUT = ClientTimeout(total=15, connect=5, sock_read=10)

class HTTPClient:
    _session: ClientSession | None = None

    @classmethod
    async def get_session(cls) -> ClientSession:
        if cls._session is None or cls._session.closed:
            cls._session = ClientSession(timeout=DEFAULT_TIMEOUT)
        return cls._session

    @classmethod
    async def close(cls):
        if cls._session and not cls._session.closed:
            await cls._session.close()

    @classmethod
    async def request_with_retry(cls, method: str, url: str, retries: int = 3, backoff: float = 1.0, **kwargs):
        import random
        session = await cls.get_session()
        last_err = None
        
        for i in range(retries):
            try:
                async with session.request(method, url, **kwargs) as resp:
                    # Non-retryable: 400, 401, 403 (except 429), 404
                    if resp.status in (400, 401, 403, 404):
                        return await resp.json()
                    
                    # Retryable: 429 and 5xx
                    if resp.status == 429 or 500 <= resp.status <= 599:
                        if i < retries - 1:
                            await track_failure(f"http_{resp.status}")
                            # Exponential backoff with jitter
                            sleep_time = (backoff * (2 ** i)) + random.uniform(0, 1)
                            await asyncio.sleep(sleep_time)
                            continue
                    
                    await track_success("http")
                    return await resp.json()
            except (asyncio.TimeoutError, ClientError) as e:
                last_err = e
                # Connection reset, timeouts are retryable
                if i < retries - 1:
                    await track_failure(f"http_{type(e).__name__}")
                    sleep_time = (backoff * (2 ** i)) + random.uniform(0, 1)
                    log.warning(f"Retryable error {type(e).__name__} on {method} {url} (retry {i+1}/{retries}): {e}")
                    await asyncio.sleep(sleep_time)
                    continue
                    
        if last_err:
            log.error(f"HTTP {method} {url} failed after {retries} retries: {last_err}")
            await track_failure("http_final")
            raise last_err
        return None
