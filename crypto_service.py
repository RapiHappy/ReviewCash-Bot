import asyncio
import logging
import config

log = logging.getLogger("reviewcash.crypto")

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

async def get_payout_status(withdraw_id: str) -> str:
    """Check payout status in CryptoBot by spend_id (withdraw_id)."""
    if not crypto: return "unknown"
    try:
        # get_transfers allows filtering by spend_id
        txs = await crypto.get_transfers(spend_id=str(withdraw_id))
        if txs:
            # If exists, it's completed (CryptoBot doesn't show 'pending' transfers in get_transfers usually, 
            # they are either executed or failed)
            return "completed"
        return "not_found"
    except Exception as e:
        log.warning(f"Failed to check CryptoBot status for {withdraw_id}: {e}")
        return "error"
