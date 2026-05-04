from pydantic_settings import BaseSettings, SettingsConfigDict
import os
from datetime import datetime, timezone

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')
    BOT_TOKEN: str
    SUPABASE_URL: str
