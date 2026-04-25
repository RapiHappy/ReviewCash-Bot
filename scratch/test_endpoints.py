import asyncio
from aiohttp import web
from multidict import CIMultiDict
import json
from unittest.mock import MagicMock

from config import *
from main import app, require_init, RATE_LIMIT_STATE
from api.user import api_bonus_claim
from api.payments import api_cryptobot_create
from services.balances import get_balance

# Mock request class
class MockRequest:
    def __init__(self, headers, json_data):
        self.headers = headers
        self._json_data = json_data
        self.method = "POST"
        self.path = "/api/test"
        self.host = "localhost"

    async def json(self):
        return self._json_data

# Simple mock for test
async def run_tests():
    print(f"RATE_LIMIT_STATE initialized: {type(RATE_LIMIT_STATE)}")
    
    # We will need a valid user ID from the database for the test. Let's use 12345 as dummy, but require_init checks the DB.
    # So instead of full require_init, we can patch require_init for the test or just run it with a valid token if we had one.
    # Let's mock require_init temporarily just for this script so we can reach the actual endpoint logic.
    
    import api.user
    import api.payments
    
    original_require_init = api.user.require_init
    
    async def mock_require_init(req):
        return ("dummy_token", {"id": 12345, "first_name": "TestUser", "username": "test_user"})
    
    api.user.require_init = mock_require_init
    api.payments.require_init = mock_require_init

    # 1. Test Daily Bonus
    print("\n--- Testing Daily Bonus ---")
    req_bonus = MockRequest(CIMultiDict(), {})
    try:
        resp = await api_bonus_claim(req_bonus)
        resp_text = json.loads(resp.text)
        print(f"Response status: {resp.status}, Body: {resp_text}")
    except Exception as e:
        print(f"Daily Bonus Test Failed with exception: {e}")

    # 2. Test CryptoBot Topup
    print("\n--- Testing CryptoBot Topup ---")
    # We pass 150 RUB
    req_topup = MockRequest(CIMultiDict(), {"amount_rub": 150})
    try:
        resp2 = await api_cryptobot_create(req_topup)
        resp2_text = json.loads(resp2.text)
        print(f"Response status: {resp2.status}, Body: {resp2_text}")
    except Exception as e:
        print(f"CryptoBot Topup Test Failed with exception: {e}")
        
    print("\nTests completed.")

if __name__ == "__main__":
    asyncio.run(run_tests())
