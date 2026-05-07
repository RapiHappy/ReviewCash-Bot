import asyncio
import logging
from aiohttp import ClientSession, ClientTimeout, ClientError

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
    async def request_with_retry(cls, method: str, url: str, retries: int = 3, backoff: float = 1.5, **kwargs):
        session = await cls.get_session()
        last_err = None
        for i in range(retries):
            try:
                async with session.request(method, url, **kwargs) as resp:
                    # Retry on 429 and 5xx
                    if resp.status in (429, 500, 502, 503, 504):
                        if i < retries - 1:
                            await asyncio.sleep(backoff * (2 ** i))
                            continue
                    return await resp.json()
            except (asyncio.TimeoutError, ClientError) as e:
                last_err = e
                if i < retries - 1:
                    await asyncio.sleep(backoff * (2 ** i))
                    continue
        if last_err:
            log.error(f"HTTP {method} {url} failed after {retries} retries: {last_err}")
            raise last_err
        return None
