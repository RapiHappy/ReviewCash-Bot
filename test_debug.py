import asyncio
from config import CRYPTO_PAY_TOKEN
import traceback

async def main():
    try:
        from aiocryptopay import AioCryptoPay, Networks
        print("aiocryptopay is installed")
        crypto = AioCryptoPay(token=CRYPTO_PAY_TOKEN, network=Networks.MAIN_NET)
        import inspect
        print("create_invoice args:", inspect.signature(crypto.create_invoice))
    except Exception as e:
        print("Error:", traceback.format_exc())

asyncio.run(main())
