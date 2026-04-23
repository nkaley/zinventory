from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    database_url: str = "postgresql+psycopg2://zinventory_user:zinventory_pass@db:5432/zinventory"

    zoho_accounts_url: str = "https://accounts.zoho.eu"
    zoho_inventory_base_url: str = "https://inventory.zoho.eu/api/v1"
    zoho_organization_id: str = "20074990370"

    zoho_client_id: str = ""
    zoho_client_secret: str = ""
    zoho_refresh_token: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()