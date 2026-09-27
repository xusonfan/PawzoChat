# PawzoChat - Human-like, versatile, extensible AI companion engine
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""HTTP client for QQ Bot API v2 — access token, send, rich-media upload.

One instance per QQ account. Thread-safe access-token caching (the gateway
thread and the reply-delivery thread share a client).
"""

from __future__ import annotations

from contextlib import contextmanager
import logging
import threading
import time
import uuid

import requests

from pawzochat.transport.qq.push import ActivePushPolicy

from pawzochat.transport.qq.models import (
    FILE_TYPE_FILE,
    FILE_TYPE_IMAGE,
    MSG_TYPE_TEXT,
)

logger = logging.getLogger(__name__)

TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
PROD_BASE_URL = "https://api.sgroup.qq.com"
SANDBOX_BASE_URL = "https://sandbox.api.sgroup.qq.com"

# Refresh this many seconds before the token actually expires (the platform
# grants a fresh token within the last 60s while keeping the old one valid).
_REFRESH_SKEW_SECONDS = 60


class QQClientError(RuntimeError):
    """Structured API failure; only explicit transient failures are retried."""

    def __init__(self, message, *, biz_code=None, retryable=False, push_defer_reason=None):
        super().__init__(message)
        self.biz_code = biz_code
        self.retryable = retryable
        self.push_defer_reason = push_defer_reason
        self._push_policy = None


class QQClient:
    def __init__(self, app_id: str, app_secret: str, *, sandbox: bool = False):
        self.app_id = app_id
        self.app_secret = app_secret
        self.base_url = SANDBOX_BASE_URL if sandbox else PROD_BASE_URL
        self._state_lock = threading.RLock()
        self._closed = threading.Event()
        self.generation = uuid.uuid4().hex
        self.push_policy = ActivePushPolicy(self._closed)
        self._session = requests.Session()
        self._token_lock = threading.Lock()
        self._access_token = ""
        self._expires_at = 0.0

    # ---- Access token ----

    def get_access_token(self, *, force: bool = False) -> str:
        """Return a valid access token, refreshing if near expiry.

        Raises :class:`QQClientError` if the credentials are rejected.
        """
        self.check_open()
        with self._token_lock:
            self.check_open()
            now = time.time()
            if (
                not force
                and self._access_token
                and now < self._expires_at - _REFRESH_SKEW_SECONDS
            ):
                return self._access_token
            try:
                resp = self._session.post(
                    TOKEN_URL,
                    json={
                        "appId": self.app_id,
                        "clientSecret": self.app_secret,
                    },
                    timeout=10,
                )
                resp.raise_for_status()
                data = resp.json()
            except requests.RequestException as exc:
                retryable = (
                    exc.response is None or exc.response.status_code == 429
                    or exc.response.status_code >= 500
                )
                raise QQClientError("获取 QQ access_token 失败", retryable=retryable) from exc
            except ValueError as exc:
                raise QQClientError("QQ access_token 响应不是 JSON") from exc

            token = data.get("access_token", "") if isinstance(data, dict) else ""
            if not token:
                raise QQClientError(
                    "QQ access_token 响应缺少有效凭据"
                )
            try:
                expires_in = int(data.get("expires_in", 7200))
            except (TypeError, ValueError):
                expires_in = 7200
            self._access_token = token
            self._expires_at = time.time() + expires_in
            return token

    @contextmanager
    def admit(self):
        with self._state_lock:
            self.check_open()
            yield

    def check_open(self):
        if self._closed.is_set():
            raise QQClientError("QQ 账号已停止，消息未投递")

    def _auth_headers(self) -> dict:
        return {"Authorization": f"QQBot {self.get_access_token()}"}

    def _invalidate_token(self) -> None:
        with self._token_lock:
            self._access_token = ""
            self._expires_at = 0.0

    def invalidate_access_token(self) -> None:
        """Discard the cached token after a gateway authentication failure."""
        self._invalidate_token()

    def _auth_get(self, url: str, *, timeout) -> requests.Response:
        """GET with one forced token refresh on a 401/403."""
        headers = self._auth_headers()
        self.check_open()
        resp = self._session.get(
            url, headers=headers, timeout=timeout,
        )
        if resp.status_code in (401, 403):
            self._invalidate_token()
            headers = self._auth_headers()
            self.check_open()
            resp = self._session.get(
                url, headers=headers, timeout=timeout,
            )
        return resp

    def _auth_post(self, url: str, payload: dict, *, timeout) -> requests.Response:
        """POST with the bearer token, force-refreshing once on a 401/403 (the
        token may have been revoked before its natural expiry) before failing."""
        headers = self._auth_headers()
        self.check_open()
        resp = self._post_message_request(url, payload, headers, timeout)
        if resp.status_code in (401, 403):
            # Business failures cannot be fixed by refreshing the access token.
            if not self._is_push_policy_error(resp):
                self._invalidate_token()
                headers = self._auth_headers()
                self.check_open()
                resp = self._post_message_request(url, payload, headers, timeout)
        return resp

    def _post_message_request(self, url, payload, headers, timeout):
        active = (
            url.startswith(f"{self.base_url}/v2/users/") and url.endswith("/messages")
            and not payload.get("msg_id") and not payload.get("event_id")
        )
        if active:
            peer = url.rsplit("/", 2)[1]
            with self.push_policy.turn(peer) as reason:
                if reason:
                    raise QQClientError(reason, push_defer_reason=reason)
                self.check_open()
                try:
                    response = self._session.post(url, json=payload, headers=headers, timeout=timeout)
                    # Record the failure before releasing the send lock so
                    # concurrent active sends see the pause immediately. Token
                    # rejection alone still gets the existing refresh attempt.
                    if response.status_code not in (401, 403) or self._is_push_policy_error(response):
                        self._decode_api_response(response)
                    return response
                except requests.RequestException as exc:
                    error = QQClientError("QQ 请求网络错误", retryable=True)
                    self.push_policy.record_failure(peer, error)
                    raise error from exc
                except QQClientError as exc:
                    self.push_policy.record_failure(peer, exc)
                    raise
        self.check_open()
        return self._session.post(url, json=payload, headers=headers, timeout=timeout)

    @staticmethod
    def _is_push_policy_error(response):
        try:
            return int(response.json().get("code", 0)) in (40034100, 40034105, 40054013, 40054004)
        except (ValueError, TypeError, AttributeError):
            return False

    def close(self) -> None:
        """Release the underlying HTTP connection pool."""
        with self._state_lock:
            self._closed.set()
            self.push_policy.clear()
        try:
            self._session.close()
        except Exception:
            pass

    # ---- Gateway ----

    def get_gateway(self) -> str:
        """Return the WebSocket gateway URL (wss://...)."""
        # The current QQ Bot API uses /gateway. Keep the legacy route as a
        # narrow compatibility fallback for sandbox/older deployments.
        url = f"{self.base_url}/gateway"
        resp = self._auth_get(url, timeout=10)
        if resp.status_code in (404, 405):
            url = f"{self.base_url}/gateway/bot"
            resp = self._auth_get(url, timeout=10)
        resp.raise_for_status()
        gateway = resp.json().get("url", "")
        if not gateway:
            raise QQClientError(f"QQ {url.removeprefix(self.base_url)} 未返回 url")
        return gateway

    # ---- Sending ----

    def send_c2c_message(
        self,
        openid: str,
        *,
        content: str = "",
        msg_type: int = MSG_TYPE_TEXT,
        msg_id: str = "",
        msg_seq: int = 1,
        media: dict | None = None,
    ) -> dict:
        """Send a C2C (private) message. ``msg_id`` ties it to an inbound
        message for a passive reply; ``msg_seq`` is a 16-bit deduplication key.
        """
        payload: dict = {"msg_type": msg_type, "content": content}
        if msg_id:
            payload["msg_id"] = msg_id
            payload["msg_seq"] = msg_seq
        if media is not None:
            payload["media"] = media
        self.check_open()
        if not msg_id:
            reason = self.push_policy.defer_reason(openid)
            if reason:
                raise QQClientError(reason, push_defer_reason=reason)
        try:
            return self.api_post(f"/v2/users/{openid}/messages", payload, timeout=15)
        except QQClientError as exc:
            if not msg_id:
                self.push_policy.record_failure(openid, exc)
            raise

    def api_post(self, path, payload, *, timeout=30):
        self.check_open()
        try:
            response = self._auth_post(f"{self.base_url}{path}", payload, timeout=timeout)
        except requests.RequestException as exc:
            raise QQClientError("QQ 请求网络错误", retryable=True) from exc
        return self._decode_api_response(response)

    @staticmethod
    def _decode_api_response(response):
        try:
            result = response.json() if response.content else {}
        except ValueError as exc:
            raise QQClientError(f"QQ 响应不是 JSON (HTTP {response.status_code})",
                                retryable=response.status_code == 429 or response.status_code >= 500) from exc
        if not isinstance(result, dict):
            raise QQClientError(
                "QQ 响应格式异常",
                retryable=response.status_code == 429 or response.status_code >= 500,
            )
        try:
            code = int(result.get("code", 0) or 0)
        except (TypeError, ValueError):
            code = -1
        if response.status_code >= 400 or code:
            reason = "今日上传额度已用尽" if code == 40093002 else str(result.get("message") or result.get("msg") or "请求失败")[:200]
            retryable = (
                (response.status_code == 429 or response.status_code >= 500)
                and code not in (40093001, 40093002, 40034105, 40054013, 40054004)
            )
            raise QQClientError(
                f"QQ {reason} (HTTP {response.status_code}, code={code})",
                biz_code=code, retryable=retryable,
            )
        return result

    def upload_c2c_media(self, openid, file_data: bytes, *, file_type=FILE_TYPE_IMAGE,
                         file_name="", on_progress=None):
        from pawzochat.transport.qq.upload import RichMediaUploader
        return RichMediaUploader(self, openid, file_type=file_type, file_name=file_name,
                                 on_progress=on_progress).upload(file_data)

    def upload_c2c_media_path(self, openid, file_path, *, file_type=FILE_TYPE_IMAGE,
                              file_name="", on_progress=None):
        from pawzochat.transport.qq.upload import RichMediaUploader
        return RichMediaUploader(self, openid, file_type=file_type, file_name=file_name,
                                 on_progress=on_progress).upload(file_path)


def _sanitize_file_name(file_name: str) -> str:
    """Return a QQ-safe basename while preserving readable Unicode names."""
    name = str(file_name).replace("\\", "/").rsplit("/", 1)[-1]
    invalid = '<>:"/\\|?*'
    name = "".join(
        char if ord(char) >= 32 and char not in invalid else "_"
        for char in name
    ).strip(" .")
    return (name or "file")[:255]
