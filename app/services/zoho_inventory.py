from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from app.config import settings


class ZohoInventoryClient:
    _cached_access_token: str | None = None
    _access_token_expires_at: datetime | None = None

    def __init__(self) -> None:
        self.accounts_url = settings.zoho_accounts_url.rstrip("/")
        self.base_url = settings.zoho_inventory_base_url.rstrip("/")
        self.organization_id = settings.zoho_organization_id
        self.client_id = settings.zoho_client_id
        self.client_secret = settings.zoho_client_secret
        self.refresh_token = settings.zoho_refresh_token

    @classmethod
    def _token_is_valid(cls) -> bool:
        if not cls._cached_access_token or not cls._access_token_expires_at:
            return False

        now = datetime.now(timezone.utc)
        return now < cls._access_token_expires_at

    def _get_access_token(self) -> str:
        if self._token_is_valid():
            return str(self._cached_access_token)

        if not self.client_id:
            raise ValueError("ZOHO_CLIENT_ID is empty")
        if not self.client_secret:
            raise ValueError("ZOHO_CLIENT_SECRET is empty")
        if not self.refresh_token:
            raise ValueError("ZOHO_REFRESH_TOKEN is empty")

        response = requests.post(
            f"{self.accounts_url}/oauth/v2/token",
            data={
                "grant_type": "refresh_token",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "refresh_token": self.refresh_token,
            },
            timeout=60,
        )

        if not response.ok:
            raise ValueError(f"Zoho token refresh failed: {response.status_code} {response.text}")

        payload = response.json()
        access_token = payload.get("access_token")
        if not access_token:
            raise ValueError(f"Zoho token refresh failed: {payload}")

        expires_in = int(payload.get("expires_in", 3600))
        safety_margin = 300
        effective_seconds = max(expires_in - safety_margin, 60)

        self.__class__._cached_access_token = str(access_token)
        self.__class__._access_token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=effective_seconds)

        return str(access_token)

    def _headers(self) -> dict[str, str]:
        access_token = self._get_access_token()
        return {
            "Authorization": f"Zoho-oauthtoken {access_token}",
            "Content-Type": "application/json",
        }

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        query = {
            "organization_id": self.organization_id,
        }
        if params:
            query.update(params)

        url = f"{self.base_url}/{path.lstrip('/')}"

        response = requests.get(
            url,
            headers=self._headers(),
            params=query,
            timeout=60,
        )

        if not response.ok:
            raise ValueError(
                f"Zoho GET failed: status={response.status_code}, url={response.url}, body={response.text}"
            )

        return response.json()

    def get_all_items(self) -> list[dict[str, Any]]:
        page = 1
        per_page = 200
        results: list[dict[str, Any]] = []

        while True:
            payload = self._get(
                "/items",
                params={"page": page, "per_page": per_page},
            )
            items = payload.get("items", [])
            results.extend(items)

            page_context = payload.get("page_context", {}) or {}
            has_more_page = bool(page_context.get("has_more_page"))
            if not has_more_page:
                break

            page += 1

        return results

    def get_all_composite_items(self) -> list[dict[str, Any]]:
        page = 1
        per_page = 200
        results: list[dict[str, Any]] = []

        while True:
            payload = self._get(
                "/compositeitems",
                params={"page": page, "per_page": per_page},
            )
            items = payload.get("composite_items", [])
            results.extend(items)

            page_context = payload.get("page_context", {}) or {}
            has_more_page = bool(page_context.get("has_more_page"))
            if not has_more_page:
                break

            page += 1

        return results

    def get_composite_item_details(self, composite_item_id: str) -> dict[str, Any]:
        return self._get(f"/compositeitems/{composite_item_id}")