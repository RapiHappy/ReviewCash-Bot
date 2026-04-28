import logging
import asyncio
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
        import re
        
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
