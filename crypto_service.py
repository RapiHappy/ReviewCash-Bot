import asyncio
from aiocryptopay import AioCryptoPay, Networks
import config

# Инициализируем клиента (кассира)
# Используем токены и настройки из config.py
crypto = AioCryptoPay(token=config.CRYPTO_PAY_TOKEN, network=config.CRYPTO_PAY_NETWORK or Networks.MAIN_NET)

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
