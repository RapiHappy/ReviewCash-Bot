import asyncio
import config

try:
    from aiocryptopay import AioCryptoPay, Networks
    if config.CRYPTO_PAY_TOKEN:
        crypto = AioCryptoPay(
            token=config.CRYPTO_PAY_TOKEN,
            network=getattr(Networks, config.CRYPTO_PAY_NETWORK, Networks.MAIN_NET) if config.CRYPTO_PAY_NETWORK else Networks.MAIN_NET
        )
    else:
        crypto = None
except Exception:
    AioCryptoPay = None
    Networks = None
    crypto = None

async def auto_payout_crypto(tg_user_id: int, amount_usdt: float, withdraw_id: str):
    """Функция автоматической выплаты крипты пользователю."""
    try:
        transfer = await crypto.transfer(
            user_id=int(tg_user_id),
            asset='USDT',
            amount=float(amount_usdt),
            spend_id=str(withdraw_id),
            comment="🎉 Выплата от ReviewCash! Спасибо за работу."
        )
        return True, "Успешно"
    except Exception as e:
        return False, str(e)
