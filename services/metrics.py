import time
from services.redis_client import redis_client

METRICS_PREFIX = "metrics:"

async def track_success(action: str):
    key = f"{METRICS_PREFIX}{action}:success"
    await redis_client.incr(key)

async def track_failure(action: str):
    key = f"{METRICS_PREFIX}{action}:failure"
    await redis_client.incr(key)

async def track_latency(action: str, duration_ms: float):
    # Store average/last latency in Redis
    key = f"{METRICS_PREFIX}{action}:latency"
    await redis_client.set(key, str(duration_ms))
    # Also keep a list for percentile calculation if needed
    await redis_client.lpush(f"{key}:history", str(duration_ms))
    await redis_client.ltrim(f"{key}:history", 0, 99) # Keep last 100

async def get_metrics(action: str) -> dict:
    success = await redis_client.get(f"{METRICS_PREFIX}{action}:success")
    failure = await redis_client.get(f"{METRICS_PREFIX}{action}:failure")
    latency = await redis_client.get(f"{METRICS_PREFIX}{action}:latency")
    
    s = int(success or 0)
    f = int(failure or 0)
    total = s + f
    rate = (s / total * 100) if total > 0 else 0
    
    return {
        "success": s,
        "failure": f,
        "success_rate": round(rate, 2),
        "last_latency_ms": round(float(latency or 0), 2)
    }
