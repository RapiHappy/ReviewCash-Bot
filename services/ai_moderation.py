import os
import re
import io
import logging
import asyncio
from PIL import Image
import google.generativeai as genai
from config import GEMINI_API_KEY

log = logging.getLogger("reviewcash.ai")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel('gemini-1.5-flash')
else:
    model = None

async def analyze_review_quality(text: str, instructions: str = "") -> dict:
    """
    Analyze review text using Gemini AI.
    Returns: { "score": float (0-1), "is_ok": bool, "reason": str }
    """
    if not model:
        return {"score": 1.0, "is_ok": True, "reason": "AI moderation disabled"}

    prompt = f"""
    Analyze the following user review for a product/service.
    Instructions from owner: {instructions}
    
    User Review:
    "{text}"
    
    Evaluate:
    1. Does it look natural (not gibberish, not AI-generated)?
    2. Does it follow the instructions (if any)?
    3. Is it at least 2 sentences and meaningful?
    
    Respond ONLY in JSON format:
    {{
      "score": 0.0 to 1.0,
      "reason": "short explanation"
    }}
    """
    
    try:
        def _call():
            return model.generate_content(prompt)
        
        response = await asyncio.to_thread(_call)
        import json
        
        # Extract JSON from response
        match = re.search(r'\{.*\}', response.text, re.DOTALL)
        if match:
            data = json.loads(match.group(0))
            score = float(data.get("score", 0.5))
            return {
                "score": score,
                "is_ok": score >= 0.6,
                "reason": data.get("reason", "")
            }
    except Exception as e:
        log.error(f"AI Moderation failed: {e}")
        
    return {"score": 1.0, "is_ok": True, "reason": "AI check failed, bypassing"}

async def ai_moderation_check_image(image_bytes: bytes, task: dict) -> int:
    """
    Принимает байты картинки (скриншота из Telegram) и контекст задания.
    Возвращает оценку от 0 до 100.
    """
    if not model:
        log.warning("Gemini AI model not initialized (missing API key)")
        return 100
        
    platform = task.get("platform") or task.get("type", "не указана")
    title = task.get("title", "без названия")
    
    prompt = f"""
    Ты — строгий, но справедливый AI-модератор сервиса по написанию отзывов.
    Тебе отправлен скриншот, который сделал исполнитель.
    
    Платформа: {platform}
    Тема/Задание: {title}
    
    Твоя задача:
    1. Найди на скриншоте текст опубликованного отзыва.
    2. Прочитай его и оцени качество текста по шкале от 0 до 100.
    
    Критерии оценки:
    - 0-10: На скриншоте вообще нет текста отзыва, это посторонняя картинка или скриншот не читаем.
    - 11-40: Откровенный спам, текст совершенно не относится к теме задания ({title}).
    - 41-69: Слишком шаблонно ("Хороший сервис", "Всё супер"), не хватает деталей.
    - 70-100: Естественный текст, похож на реальный опыт человека, релевантен заданию.
    
    Верни ТОЛЬКО одно целое число (оценку). Никаких других слов или пояснений.
    """
    
    try:
        # Преобразуем байты от Telegram в объект картинки для Gemini
        img = Image.open(io.BytesIO(image_bytes))
        
        # Модель Flash — она отлично работает с картинками (Vision)
        # Мы используем асинхронную версию
        response = await model.generate_content_async([prompt, img])
        
        # Парсим ответ
        match = re.search(r'\d+', response.text.strip())
        if match:
            score = int(match.group())
            log.info(f"AI Vision Score: {score} for task {title}")
            return max(0, min(100, score))
        else:
            log.warning(f"AI не вернул число: {response.text}")
            return 100
            
    except Exception as e:
        log.error(f"Ошибка Gemini API (Vision): {e}")
        return 100
