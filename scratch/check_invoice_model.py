import asyncio
from aiocryptopay import AioCryptoPay, Networks

async def test():
    # We don't need a real token just to check the model attributes if we can inspect the class
    from aiocryptopay.models.invoice import Invoice
    print("Invoice attributes:", [a for a in dir(Invoice) if not a.startswith("_")])
    
    # Or just check what's in a mock response if we had one.
    # But let's check the constructor of Invoice
    import inspect
    print("Invoice init signature:", inspect.signature(Invoice.__init__))

if __name__ == "__main__":
    asyncio.run(test())
