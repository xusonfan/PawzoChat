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

"""Self-update mechanism backed by Aliyun OSS and GitHub Releases."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import platform
import shutil
import stat
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.parse import urlparse

import requests
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from pawzochat.paths import APP_HOME, DATA_DIR

logger = logging.getLogger(__name__)

GITHUB_OWNER = "iwyxdxl"
GITHUB_REPO = "PawzoChat"
_API_URL = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"
_OSS_LATEST_URL = "https://pawzochat-release.oss-cn-shanghai.aliyuncs.com/channels/stable/latest.json"

MIRRORS: list[str] = [
    "https://gh-proxy.com",
    "https://cors.isteed.cc",
    "https://gh.con.sh",
]

STAGING_DIR = DATA_DIR / "update_staging"
STAGING_ZIP = DATA_DIR / "update_staging.zip"

_REQUEST_TIMEOUT = 15

_CHECKSUMS_MANIFEST_NAME = "checksums.json"
_CHECKSUMS_SIGNATURE_NAME = "checksums.sig"
_CHECKSUMS_SCHEMA_VERSION = 1

# Base64-encoded raw 32-byte Ed25519 public key used to verify signed update
# manifests. Set this before the first public release. For local testing it can
# be overridden at runtime with PAWZOCHAT_UPDATE_PUBLIC_KEY_B64.
_UPDATE_PUBLIC_KEY_B64 = "qlRGfuUmlC8SYwos14YcKIHt4qAlCVJqm3Lh022alhc="


# ---------------------------------------------------------------------------
# Platform helper
# ---------------------------------------------------------------------------

class _PlatformHelper:

    @staticmethod
    def platform_tag() -> str:
        machine = platform.machine().lower()
        tag_arch = {
            "x86_64": "amd64", "amd64": "amd64",
            "aarch64": "arm64", "arm64": "arm64",
        }.get(machine, machine)

        if sys.platform == "win32":
            return f"win-{tag_arch}"
        if sys.platform == "darwin":
            return f"mac-{tag_arch}"
        return f"linux-{tag_arch}"

    @staticmethod
    def executable_name() -> str:
        return "PawzoChat.exe" if sys.platform == "win32" else "PawzoChat"

    @staticmethod
    def clean_subprocess_env() -> dict[str, str]:
        """Return an environment suitable for launching another PyInstaller app.

        PyInstaller's bootloader sets ``_PYI_*`` markers and rewrites
        ``DYLD_LIBRARY_PATH`` / ``LD_LIBRARY_PATH`` to point at the *current*
        bundle's ``_internal`` directory. If we let those leak into a sibling
        bundle, ``dyld`` resolves dylibs from the wrong bundle before the new
        bootloader runs and the child crashes silently before reaching main.
        """
        env = os.environ.copy()

        for key in list(env):
            if key.startswith("_PYI_"):
                env.pop(key, None)

        for key in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"):
            original = env.pop(f"{key}_ORIG", None)
            env.pop(key, None)
            if original:
                env[key] = original

        return env

    @staticmethod
    def wait_for_pid(pid: int, timeout: int = 120) -> bool:
        if sys.platform == "win32":
            return _PlatformHelper._wait_win32(pid, timeout)
        return _PlatformHelper._wait_unix(pid, timeout)

    @staticmethod
    def launch_detached(
        executable: Path,
        args: list[str],
        *,
        new_console: bool = False,
        clean_env: bool = False,
        cwd: Path | None = None,
        stdin: Any = subprocess.DEVNULL,
        stdout: Any = subprocess.DEVNULL,
        stderr: Any = subprocess.DEVNULL,
    ) -> subprocess.Popen:
        # NOTE: stdin defaults to DEVNULL on purpose. If we let the child
        # inherit our fd 0 it can be invalid (e.g. when the parent was
        # launched from Finder/launchd or stdin was already closed), and
        # PyInstaller's Python bootstrap then crashes inside
        # ``init_sys_streams`` with ``OSError: [Errno 9] Bad file descriptor``.
        cmd = [str(executable)] + args
        env = _PlatformHelper.clean_subprocess_env() if clean_env else None
        cwd_str = str(cwd) if cwd is not None else None
        if sys.platform == "win32":
            CREATE_NEW_PROCESS_GROUP = 0x00000200
            DETACHED_PROCESS = 0x00000008
            CREATE_NEW_CONSOLE = 0x00000010
            flags = CREATE_NEW_PROCESS_GROUP
            flags |= CREATE_NEW_CONSOLE if new_console else DETACHED_PROCESS
            return subprocess.Popen(
                cmd,
                creationflags=flags,
                cwd=cwd_str,
                env=env,
                stdin=stdin,
                stdout=stdout,
                stderr=stderr,
                close_fds=True,
            )

        return subprocess.Popen(
            cmd,
            cwd=cwd_str,
            env=env,
            start_new_session=True,
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            close_fds=True,
        )

    @staticmethod
    def launch_like_user_open(executable: Path, *, log_path: Path | None = None) -> subprocess.Popen | None:
        if sys.platform == "win32":
            try:
                os.startfile(  # type: ignore[attr-defined]
                    str(executable),
                    cwd=str(executable.parent),
                    show_cmd=1,
                )
                return None
            except Exception:
                logger.warning("Shell 打开新版本失败，回退到新控制台启动", exc_info=True)
        elif sys.platform == "darwin":
            # Mirror what Finder does for a plain CLI binary: hand the
            # executable to Terminal.app so the user sees a console window
            # with logs, instead of a silently-detached background process.
            # ``open`` returns immediately after telling Terminal to start,
            # so its Popen object is not the new app process — return None
            # to avoid misleading PID/exit-code logging upstream.
            try:
                subprocess.Popen(
                    ["/usr/bin/open", "-a", "Terminal", str(executable)],
                    start_new_session=True,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    close_fds=True,
                ).wait(timeout=10)
                return None
            except Exception:
                logger.warning("open -a Terminal 启动新版本失败，回退到无窗口启动", exc_info=True)

        log_file = None
        stdout = subprocess.DEVNULL
        stderr = subprocess.DEVNULL
        if log_path is not None:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_file = open(log_path, "ab", buffering=0)
            stdout = log_file
            stderr = log_file

        try:
            return _PlatformHelper.launch_detached(
                executable,
                [],
                new_console=True,
                clean_env=True,
                cwd=executable.parent,
                stdout=stdout,
                stderr=stderr,
            )
        finally:
            if log_file is not None:
                log_file.close()

    @staticmethod
    def copy_tree(src: Path, dst: Path) -> None:
        _PlatformHelper._copy_tree_retry(src, dst)

    @staticmethod
    def _copy_tree_retry(src: Path, dst: Path, retries: int = 5, delay: float = 2.0) -> None:
        """copytree over dst, retrying files held by transient locks.

        shutil.copytree does not abort on a locked file: it records the
        per-file OSError, copies everything else, and only then raises an
        aggregated shutil.Error — so catching PermissionError here would
        never retry, and the target would be left half-updated (e.g. new
        version file but old payload). Catch shutil.Error instead and
        retry just the failed entries, which rides out short-lived locks
        (AV scan-on-close, lingering child processes).
        """
        failed: list[tuple[str, str]] = []
        last_error: Exception | None = None
        for attempt in range(retries):
            try:
                if failed:
                    # Retry only the entries that failed on the last pass.
                    # An entry may be a directory (a failed makedirs/copystat
                    # is recorded with the dir path) — copy2 on a dir raises
                    # IsADirectoryError and turns a transient failure permanent.
                    for srcname, dstname in failed:
                        if os.path.isdir(srcname):
                            shutil.copytree(srcname, dstname, dirs_exist_ok=True)
                        else:
                            shutil.copy2(srcname, dstname)
                else:
                    shutil.copytree(str(src), str(dst), dirs_exist_ok=True)
                return
            except shutil.Error as err:
                # args[0] is a flat list of (srcname, dstname, reason) triples.
                failed = [(s, d) for s, d, _ in err.args[0]]
                last_error = err
            except OSError as exc:
                last_error = exc
            if attempt < retries - 1:
                logger.warning(
                    "文件复制受阻 (尝试 %d/%d)，%g 秒后重试…",
                    attempt + 1, retries, delay,
                )
                time.sleep(delay)
        assert last_error is not None
        raise last_error

    # -- private helpers --

    @staticmethod
    def _wait_win32(pid: int, timeout: int) -> bool:
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            SYNCHRONIZE = 0x00100000
            WAIT_OBJECT_0 = 0x00000000
            WAIT_TIMEOUT = 0x00000102
            handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
            if handle:
                result = kernel32.WaitForSingleObject(handle, timeout * 1000)
                kernel32.CloseHandle(handle)
                if result == WAIT_OBJECT_0:
                    return True
                if result == WAIT_TIMEOUT:
                    logger.warning("等待进程 %d 退出超时", pid)
                    return False
        except Exception:
            pass
        return _PlatformHelper._wait_poll(pid, timeout)

    @staticmethod
    def _wait_unix(pid: int, timeout: int) -> bool:
        return _PlatformHelper._wait_poll(pid, timeout)

    @staticmethod
    def _wait_poll(pid: int, timeout: int) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except OSError:
                return True
            time.sleep(0.5)
        logger.warning("等待进程 %d 退出超时", pid)
        return False


# ---------------------------------------------------------------------------
# Version comparison
# ---------------------------------------------------------------------------

def _parse_version(ver: str) -> tuple[int, ...]:
    """'0.2.1' -> (0, 2, 1), strips leading 'v'."""
    ver = ver.strip().lstrip("vV")
    parts: list[int] = []
    for segment in ver.split("."):
        digits = ""
        for ch in segment:
            if ch.isdigit():
                digits += ch
            else:
                break
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _is_newer(remote: str, local: str) -> bool:
    return _parse_version(remote) > _parse_version(local)


# ---------------------------------------------------------------------------
# Mirror-aware HTTP helper
# ---------------------------------------------------------------------------

def _github_mirror_candidates(original_url: str) -> list[str]:
    host = urlparse(original_url).netloc.lower()
    if host not in {"api.github.com", "github.com"}:
        return [original_url]
    return [f"{m}/{original_url}" for m in MIRRORS] + [original_url]


def _try_get(original_url: str, *, stream: bool = False, timeout: int = _REQUEST_TIMEOUT) -> requests.Response:
    urls = _github_mirror_candidates(original_url)
    last_exc: Exception | None = None
    for url in urls:
        try:
            resp = requests.get(url, timeout=timeout, stream=stream)
            resp.raise_for_status()
            return resp
        except Exception as exc:
            last_exc = exc
            logger.debug("Update HTTP source failed: %s — %s", url, exc)
    raise ConnectionError(f"All update HTTP sources failed for {original_url}") from last_exc


def _release_source_urls() -> list[tuple[str, str]]:
    oss_url = os.environ.get("PAWZOCHAT_OSS_LATEST_URL", _OSS_LATEST_URL).strip()
    sources: list[tuple[str, str]] = []
    if oss_url:
        sources.append(("aliyun_oss", oss_url))
    sources.append(("github", _API_URL))
    return sources


def _load_latest_release_data() -> tuple[dict[str, Any], str]:
    last_exc: Exception | None = None
    for source, url in _release_source_urls():
        try:
            resp = _try_get(url)
            data = resp.json()
            if not isinstance(data, dict):
                raise ValueError("release metadata must be a JSON object")
            if not data.get("tag_name"):
                raise ValueError("release metadata missing tag_name")
            logger.debug("更新元数据来源: %s (%s)", source, url)
            return data, source
        except Exception as exc:
            last_exc = exc
            logger.debug("更新元数据来源失败: %s (%s)", source, url, exc_info=True)
    raise ConnectionError("all update metadata sources failed") from last_exc



def _configured_update_public_key_b64() -> str:
    return (
        os.environ.get("PAWZOCHAT_UPDATE_PUBLIC_KEY_B64", "")
        or _UPDATE_PUBLIC_KEY_B64
    ).strip()


def _verification_configuration_error() -> str:
    try:
        _load_update_public_key()
    except ValueError as exc:
        if "not configured" in str(exc):
            return "verification_not_configured"
        return "verification_key_invalid"
    return ""


def _load_update_public_key() -> Ed25519PublicKey:
    key_b64 = _configured_update_public_key_b64()
    if not key_b64:
        raise ValueError("update verification public key is not configured")
    try:
        raw = base64.b64decode(key_b64, validate=True)
    except Exception as exc:
        raise ValueError("invalid update verification public key encoding") from exc
    if len(raw) != 32:
        raise ValueError("update verification public key must decode to 32 bytes")
    return Ed25519PublicKey.from_public_bytes(raw)


def _verify_manifest_signature(manifest_bytes: bytes, signature: bytes) -> None:
    public_key = _load_update_public_key()
    try:
        public_key.verify(signature, manifest_bytes)
    except InvalidSignature as exc:
        raise ValueError("update manifest signature verification failed") from exc


def _parse_signed_manifest(
    manifest_bytes: bytes,
    *,
    release_version: str,
) -> dict[str, Any]:
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except Exception as exc:
        raise ValueError("invalid update manifest JSON") from exc

    if not isinstance(manifest, dict):
        raise ValueError("update manifest must be a JSON object")

    schema = manifest.get("schema", _CHECKSUMS_SCHEMA_VERSION)
    if schema != _CHECKSUMS_SCHEMA_VERSION:
        raise ValueError(f"unsupported update manifest schema: {schema}")

    manifest_version = str(manifest.get("version", "")).strip().lstrip("vV")
    if not manifest_version:
        raise ValueError("update manifest missing version")
    if manifest_version != release_version.lstrip("vV"):
        raise ValueError(
            f"update manifest version mismatch: {manifest_version} != {release_version.lstrip('vV')}"
        )

    assets = manifest.get("assets")
    if not isinstance(assets, dict):
        raise ValueError("update manifest assets must be an object")

    return manifest


def _load_signed_manifest(
    manifest_url: str,
    signature_url: str,
    *,
    release_version: str,
) -> dict[str, Any]:
    manifest_resp = _try_get(manifest_url, timeout=30)
    signature_resp = _try_get(signature_url, timeout=30)

    manifest_bytes = manifest_resp.content
    signature = signature_resp.content
    if not signature:
        raise ValueError("empty update manifest signature")

    _verify_manifest_signature(manifest_bytes, signature)
    return _parse_signed_manifest(
        manifest_bytes,
        release_version=release_version,
    )


def _find_release_asset(
    release_data: dict[str, Any],
    asset_name: str,
) -> dict[str, Any] | None:
    for asset in release_data.get("assets", []):
        if asset.get("name") == asset_name:
            return asset
    return None


def _is_platform_zip_asset(name: str, platform_tag: str, release_version: str) -> bool:
    normalized = name.lower()
    version = release_version.strip().lstrip("vV").lower()
    if not normalized.endswith(".zip") or platform_tag.lower() not in normalized:
        return False
    return f"-v{version}-" in normalized or normalized.startswith(f"v{version}-")


def _asset_sha256_from_manifest(
    manifest: dict[str, Any],
    asset_name: str,
    *,
    expected_size: int | None = None,
) -> str:
    assets = manifest.get("assets", {})
    entry = assets.get(asset_name)
    if not isinstance(entry, dict):
        raise ValueError(f"update manifest missing asset entry: {asset_name}")

    sha256_hex = str(entry.get("sha256", "")).strip().lower()
    if len(sha256_hex) != 64 or any(ch not in "0123456789abcdef" for ch in sha256_hex):
        raise ValueError(f"invalid sha256 for asset: {asset_name}")

    manifest_size = entry.get("size")
    if manifest_size is not None:
        try:
            manifest_size = int(manifest_size)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid size for asset: {asset_name}") from exc
        if manifest_size < 0:
            raise ValueError(f"invalid size for asset: {asset_name}")
        if expected_size and manifest_size != expected_size:
            raise ValueError(
                f"asset size mismatch for {asset_name}: manifest={manifest_size} release={expected_size}"
            )

    return sha256_hex


def _safe_extract_zip(zf: zipfile.ZipFile, target_dir: Path) -> None:
    target_dir = target_dir.resolve()

    for member in zf.infolist():
        name = member.filename.replace("\\", "/")
        if not name:
            continue

        rel_path = PurePosixPath(name)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            raise ValueError(f"unsafe zip member path: {member.filename}")

        dest_path = (target_dir / Path(*rel_path.parts)).resolve()
        try:
            dest_path.relative_to(target_dir)
        except ValueError as exc:
            raise ValueError(f"unsafe zip member path: {member.filename}") from exc

        mode = member.external_attr >> 16
        if stat.S_ISLNK(mode):
            _extract_symlink_member(zf, member, dest_path, target_dir)
            continue

        if member.is_dir():
            dest_path.mkdir(parents=True, exist_ok=True)
            continue

        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(member, "r") as src, open(dest_path, "wb") as dst:
            shutil.copyfileobj(src, dst)
        # Guard on the extracted permission bits — not the raw mode —
        # because zip members with only file-type bits set produce
        # ``S_IMODE(mode) == 0``, and ``chmod(0)`` strips write access
        # on Windows (breaking subsequent updater runs on the same file).
        perm = stat.S_IMODE(mode)
        if perm:
            dest_path.chmod(perm)


def _extract_symlink_member(
    zf: zipfile.ZipFile,
    member: zipfile.ZipInfo,
    dest_path: Path,
    target_dir: Path,
) -> None:
    """Materialize a symlink zip member, rejecting any target that escapes target_dir.

    macOS PyInstaller bundles routinely contain intra-bundle dylib symlinks
    (e.g. ``libbrotlicommon.1.dylib`` -> ``libbrotlicommon.1.2.0.dylib``) that
    are required at runtime for ``dlopen`` to find the right SONAME. We allow
    them, but only when the link target stays inside the extraction root.
    """
    raw_target = zf.read(member)
    try:
        link_target = raw_target.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(
            f"invalid symlink target encoding in update zip: {member.filename}"
        ) from exc

    if not link_target:
        raise ValueError(f"empty symlink target in update zip: {member.filename}")

    target_posix = PurePosixPath(link_target)
    if target_posix.is_absolute() or ".." in target_posix.parts or link_target.startswith("\\"):
        raise ValueError(
            f"refusing to extract unsafe symlink from update zip: "
            f"{member.filename} -> {link_target}"
        )

    resolved = (dest_path.parent / Path(*target_posix.parts)).resolve()
    try:
        resolved.relative_to(target_dir)
    except ValueError as exc:
        raise ValueError(
            f"refusing to extract symlink that escapes update target: "
            f"{member.filename} -> {link_target}"
        ) from exc

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if dest_path.is_symlink() or dest_path.exists():
        if dest_path.is_dir() and not dest_path.is_symlink():
            raise ValueError(
                f"refusing to overwrite directory with symlink: {dest_path}"
            )
        dest_path.unlink()

    os.symlink(link_target, dest_path)


def _cleanup_partial_downloads() -> None:
    if STAGING_DIR.exists():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
    if STAGING_ZIP.exists():
        STAGING_ZIP.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# UpdateChecker
# ---------------------------------------------------------------------------

class UpdateChecker:
    """Checks GitHub Releases for a newer version and downloads it."""

    def __init__(self) -> None:
        self._result: dict[str, Any] | None = None
        self._lock = threading.RLock()
        self._downloading = False
        self._download_progress: float = 0.0
        self._download_stage = "idle"
        self._download_error = ""

    @property
    def result(self) -> dict[str, Any] | None:
        return self._result

    @property
    def download_status(self) -> dict[str, Any]:
        with self._lock:
            stage = self._download_stage
            progress = self._download_progress
            error = self._download_error

        ready = _resolve_ready_staging_root() is not None
        if ready and stage not in {"downloading", "extracting", "applying"}:
            stage = "ready"
            progress = 1.0
            error = ""

        return {
            "stage": stage,
            "progress": round(progress * 100, 1),
            "ready": ready,
            "error": error,
        }

    def _set_download_state(
        self,
        stage: str,
        *,
        progress: float | None = None,
        error: str = "",
    ) -> None:
        with self._lock:
            self._download_stage = stage
            if progress is not None:
                self._download_progress = max(0.0, min(progress, 1.0))
            self._download_error = error

    def check(self) -> dict[str, Any]:
        from pawzochat import __version__

        try:
            data, source = _load_latest_release_data()
        except Exception:
            logger.debug("更新检查失败", exc_info=True)
            self._result = {"has_update": False, "error": "network_error"}
            return self._result

        tag = data.get("tag_name", "")
        if not tag or not _is_newer(tag, __version__):
            self._result = {
                "has_update": False,
                "current_version": __version__,
                "update_source": source,
            }
            return self._result

        ptag = _PlatformHelper.platform_tag()
        latest_version = str(tag).strip().lstrip("vV")
        asset_url = ""
        asset_name = ""
        asset_size = 0
        for asset in data.get("assets", []):
            name: str = asset.get("name", "")
            if _is_platform_zip_asset(name, ptag, latest_version):
                asset_name = name
                asset_url = asset.get("browser_download_url", "")
                asset_size = asset.get("size", 0)
                break

        manifest_asset = _find_release_asset(data, _CHECKSUMS_MANIFEST_NAME)
        signature_asset = _find_release_asset(data, _CHECKSUMS_SIGNATURE_NAME)
        verification_reason = _verification_configuration_error()
        if not verification_reason and (not manifest_asset or not signature_asset):
            verification_reason = "verification_assets_missing"

        self._result = {
            "has_update": True,
            "current_version": __version__,
            "latest_version": latest_version,
            "changelog": data.get("body", ""),
            "download_available": bool(
                asset_url and asset_name and manifest_asset and signature_asset and not verification_reason
            ),
            "download_url": asset_url,
            "download_asset_name": asset_name,
            "download_size": asset_size,
            "platform": ptag,
            "manifest_url": manifest_asset.get("browser_download_url", "") if manifest_asset else "",
            "signature_url": signature_asset.get("browser_download_url", "") if signature_asset else "",
            "download_blocked_reason": verification_reason,
            "update_source": source,
        }
        if verification_reason:
            logger.warning(
                "发现新版本 %s，但更新下载已被阻止: %s",
                tag,
                verification_reason,
            )
        logger.info("发现新版本 %s (当前 %s, 来源 %s)", tag, __version__, source)
        return self._result

    def try_begin_download(self) -> bool:
        """Atomically reserve the download slot; False if one is already running."""
        with self._lock:
            if self._downloading:
                return False
            self._downloading = True
            self._download_progress = 0.0
            self._download_stage = "downloading"
            self._download_error = ""
            return True

    def release_download(self) -> None:
        """Release a try_begin_download reservation when the download never started.

        Pairs with try_begin_download for the window between reserving the slot
        and entering download() (whose finally clause releases it) — e.g. the
        worker thread fails to spawn. Without this the slot would stay reserved
        and every later download attempt would be rejected.
        """
        with self._lock:
            self._downloading = False
            self._download_stage = "idle"

    def download(
        self,
        progress_cb: Callable[[float], None] | None = None,
        status_cb: Callable[[str], None] | None = None,
        *,
        reserved: bool = False,
    ) -> Path:
        if not reserved and not self.try_begin_download():
            raise RuntimeError("已有下载任务进行中")

        try:
            return self._do_download(progress_cb, status_cb)
        finally:
            with self._lock:
                self._downloading = False

    def _do_download(
        self,
        progress_cb: Callable[[float], None] | None,
        status_cb: Callable[[str], None] | None,
    ) -> Path:
        if not self._result or not self._result.get("download_available"):
            raise ValueError("没有可用的下载链接")

        url: str = self._result["download_url"]
        asset_name = str(self._result.get("download_asset_name", "")).strip()
        total_size: int = self._result.get("download_size", 0)
        manifest_url = str(self._result.get("manifest_url", "")).strip()
        signature_url = str(self._result.get("signature_url", "")).strip()
        latest_version = str(self._result.get("latest_version", "")).strip()

        if not asset_name or not manifest_url or not signature_url:
            raise ValueError("更新校验元数据不完整，已拒绝下载")

        manifest = _load_signed_manifest(
            manifest_url,
            signature_url,
            release_version=latest_version,
        )
        expected_sha256 = _asset_sha256_from_manifest(
            manifest,
            asset_name,
            expected_size=total_size or None,
        )

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _cleanup_partial_downloads()

        try:
            resp = _try_get(url, stream=True, timeout=60)
            if not total_size:
                total_size = int(resp.headers.get("Content-Length", 0))

            downloaded = 0
            chunk_size = 256 * 1024
            digest = hashlib.sha256()
            with open(STAGING_ZIP, "wb") as f:
                for chunk in resp.iter_content(chunk_size=chunk_size):
                    if not chunk:
                        continue
                    f.write(chunk)
                    digest.update(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        self._download_progress = min(downloaded / total_size, 1.0)
                        if progress_cb:
                            progress_cb(self._download_progress)

            actual_sha256 = digest.hexdigest().lower()
            if actual_sha256 != expected_sha256:
                raise ValueError("更新包校验失败：SHA-256 不匹配")

            self._set_download_state("downloading", progress=1.0)
            if progress_cb:
                progress_cb(1.0)

            logger.info("下载完成且校验通过，正在安全解压…")
            self._set_download_state("extracting", progress=1.0)
            if status_cb:
                status_cb("extracting")
            STAGING_DIR.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(STAGING_ZIP, "r") as zf:
                _safe_extract_zip(zf, STAGING_DIR)

            STAGING_ZIP.unlink(missing_ok=True)
            logger.info("解压完成")

            inner = _find_inner_root(STAGING_DIR)
            self._set_download_state("ready", progress=1.0)
            logger.info("更新包已准备完成: %s", inner)
            return inner
        except Exception as exc:
            self._set_download_state("error", error=str(exc))
            _cleanup_partial_downloads()
            raise

    def apply(self, shutdown_cb: Callable[[], None]) -> None:
        staging = _resolve_ready_staging_root()
        if staging is None:
            expected = STAGING_DIR / _PlatformHelper.executable_name()
            raise FileNotFoundError(f"Staging 目录中未找到可执行文件: {expected}")

        exe = staging / _PlatformHelper.executable_name()

        pid = os.getpid()
        target = str(APP_HOME)
        logger.info("启动更新进程: %s --apply-update --pid %d --target %s", exe, pid, target)
        self._set_download_state("applying", progress=1.0)

        spawn_log_path = DATA_DIR / "logs" / "apply_spawn.log"
        spawn_log_path.parent.mkdir(parents=True, exist_ok=True)
        spawn_log = open(spawn_log_path, "ab", buffering=0)
        try:
            _PlatformHelper.launch_detached(
                exe,
                ["--apply-update", "--pid", str(pid), "--target", target],
                clean_env=True,
                cwd=exe.parent,
                stdout=spawn_log,
                stderr=spawn_log,
            )
        except Exception:
            self._set_download_state("ready", progress=1.0)
            raise
        finally:
            spawn_log.close()
        shutdown_cb()


# ---------------------------------------------------------------------------
# apply_update — called from main.py when --apply-update is present
# ---------------------------------------------------------------------------

def apply_update(argv: list[str]) -> None:
    """Entry point for the new-version bundle running in updater mode."""
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--apply-update", action="store_true")
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--target", type=str, required=True)
    args = parser.parse_args(argv[1:])

    target = Path(args.target).resolve()
    staging = Path(sys.executable).resolve().parent

    log_path = target / "data" / "logs" / "update.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=str(log_path),
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logger.info("=== 更新进程启动 ===")
    logger.info("PID to wait: %d, staging: %s, target: %s", args.pid, staging, target)

    try:
        logger.info("等待旧进程退出…")
        if not _PlatformHelper.wait_for_pid(args.pid):
            raise TimeoutError(f"等待旧进程 {args.pid} 退出超时")
        logger.info("旧进程已退出")

        if sys.platform == "win32":
            # Wait for Windows to release file locks (AV scanning, DLL unloading, etc.)
            time.sleep(2)

        logger.info("安装新版本到 %s …", target)
        _install_from_staging(staging, target)
        logger.info("文件安装完成")

        new_exe = target / _PlatformHelper.executable_name()
        logger.info("启动新版本: %s", new_exe)
        relaunch_log = target / "data" / "logs" / "relaunch.log"
        proc = _PlatformHelper.launch_like_user_open(new_exe, log_path=relaunch_log)
        if proc is not None:
            logger.info("新版本进程已启动: PID %d", proc.pid)
            time.sleep(2)
            rc = proc.poll()
            if rc is not None:
                logger.warning("新版本进程提前退出，退出码 %s；详见 %s", rc, relaunch_log)
        logger.info("=== 更新完成 ===")
    except Exception:
        logger.exception("更新失败")
        new_exe = target / _PlatformHelper.executable_name()
        if new_exe.is_file():
            logger.info("尝试启动旧版本…")
            relaunch_log = target / "data" / "logs" / "relaunch.log"
            _PlatformHelper.launch_like_user_open(new_exe, log_path=relaunch_log)
    finally:
        # Force-exit the updater process so non-daemon threads can't block exit
        sys.exit(0)


# ---------------------------------------------------------------------------
# _install_from_staging — atomic swap install used by apply_update
# ---------------------------------------------------------------------------

_STAGE_NEW_SUFFIX = ".pawzonew"
_STAGE_OLD_SUFFIX = ".pawzoold"

# The release zip ships a top-level `data/` folder (default emoji/theme/
# mcp_servers, synced by the build script). It must be merged into the live
# data directory, never renamed away: that directory holds the updater's own
# staging tree and open update.log handle (so the rename can never succeed
# on Windows) and the user's entire state (so a wholesale swap would delete
# it on any platform).
_MERGED_TOP_LEVEL = "data"


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path, ignore_errors=True)


def _remove_swap_leftovers(target: Path) -> None:
    """Drop `<name>.pawzonew` / `<name>.pawzoold` entries from an interrupted install."""
    try:
        entries = list(target.iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.name.endswith((_STAGE_NEW_SUFFIX, _STAGE_OLD_SUFFIX)):
            logger.info("清理更新残留: %s", entry)
            _remove_path(entry)


def _rename_with_retry(src: Path, dst: Path, retries: int = 5, delay: float = 2.0) -> None:
    """os.rename with retry — transient locks (AV scans) block renames on Windows too."""
    for attempt in range(retries):
        try:
            os.rename(src, dst)
            return
        except OSError:
            if attempt < retries - 1:
                logger.warning(
                    "文件重命名受阻 (尝试 %d/%d)，%g 秒后重试…",
                    attempt + 1, retries, delay,
                )
                time.sleep(delay)
            else:
                raise


def _verify_staged_payload(staging: Path, target: Path) -> None:
    """Every staging file must exist under its `<name>.pawzonew` twin with equal size.

    The staging tree came from a signature- and SHA-256-verified zip, so it is
    the ground truth; this walk catches files quietly quarantined by AV between
    copy and swap. Size equality is enough here — copy2 either wrote the file
    or raised. Top-level dot entries and the merged `data/` folder are skipped
    because _install_from_staging stages neither as `.pawzonew` twins — junk
    like `.DS_Store` would otherwise abort every install here.
    """
    for dirpath, _dirnames, filenames in os.walk(staging):
        for filename in filenames:
            src_file = Path(dirpath) / filename
            rel = src_file.relative_to(staging)
            if rel.parts[0].startswith(".") or rel.parts[0] == _MERGED_TOP_LEVEL:
                continue
            staged = target / (rel.parts[0] + _STAGE_NEW_SUFFIX) / Path(*rel.parts[1:])
            if not staged.is_file():
                raise FileNotFoundError(f"staged copy missing: {staged}")
            if staged.stat().st_size != src_file.stat().st_size:
                raise ValueError(f"staged copy size mismatch: {staged}")


def _install_from_staging(staging: Path, target: Path) -> None:
    """Land the staged bundle next to `target`, then swap it in with rollback.

    The shipped `data/` folder is merged into the live data directory first —
    see _MERGED_TOP_LEVEL. Everything else is app payload: copied to fresh
    `<name>.pawzonew` entries that never touch locked files, so the copy
    either completes fully or raises — no half-overwritten payload. The swap
    is two rename phases; a failure anywhere rolls back, leaving either the
    complete old version or the complete new one. A hard kill mid-swap (no
    exception raised) is rolled back by _recover_interrupted_swap on the
    next startup.
    """
    names = sorted(
        entry.name for entry in staging.iterdir() if not entry.name.startswith(".")
    )
    if not names:
        raise ValueError(f"staging 目录为空: {staging}")

    swap_names = [name for name in names if name != _MERGED_TOP_LEVEL]

    _recover_interrupted_swap(target)
    _remove_swap_leftovers(target)

    merge_src = staging / _MERGED_TOP_LEVEL
    if merge_src.is_dir():
        # The merge is the only step that writes over existing (possibly
        # locked) files, so run it before any rename: if it fails the old
        # version is still fully intact and the update can be retried.
        logger.info("合并资源目录 %s …", target / _MERGED_TOP_LEVEL)
        _PlatformHelper.copy_tree(merge_src, target / _MERGED_TOP_LEVEL)
        logger.info("资源目录合并完成")

    rotated: list[str] = []  # entries rotated out to .pawzoold
    swapped: list[str] = []  # entries swapped in from .pawzonew
    try:
        for name in swap_names:
            src = staging / name
            if src.is_dir():
                _PlatformHelper.copy_tree(src, target / (name + _STAGE_NEW_SUFFIX))
            else:
                shutil.copy2(str(src), str(target / (name + _STAGE_NEW_SUFFIX)))

        _verify_staged_payload(staging, target)

        for name in swap_names:
            cur = target / name
            if cur.exists() or cur.is_symlink():
                _rename_with_retry(cur, target / (name + _STAGE_OLD_SUFFIX))
                rotated.append(name)
        for name in swap_names:
            _rename_with_retry(target / (name + _STAGE_NEW_SUFFIX), target / name)
            swapped.append(name)
    except Exception:
        logger.exception("安装新版本失败，正在回滚到旧版本")
        for name in swapped:
            _remove_path(target / name)
        for name in rotated:
            old = target / (name + _STAGE_OLD_SUFFIX)
            try:
                os.rename(old, target / name)
            except OSError:
                logger.exception("回滚失败: %s", old)
        for name in swap_names:
            _remove_path(target / (name + _STAGE_NEW_SUFFIX))
        raise

    # Drop the previous version. Anything left behind is cleaned on next startup.
    _remove_swap_leftovers(target)

# ---------------------------------------------------------------------------
# cleanup_staging — called on normal startup
# ---------------------------------------------------------------------------

def _recover_interrupted_swap(target: Path) -> None:
    """Roll back a swap install interrupted by a hard kill or power loss.

    _install_from_staging rolls back on Python exceptions, but a crash between
    its two rename phases leaves `<name>.pawzoold` entries whose primary
    `<name>` is missing. Those leftovers are the old version's only copy —
    deleting them would brick the install, so rename them back first. When
    every primary exists the swap had completed and the leftovers are residue.
    Called both on startup and before a fresh install (via cleanup_staging and
    _install_from_staging respectively).
    """
    try:
        entries = list(target.iterdir())
    except OSError:
        return
    rotated = [e for e in entries if e.name.endswith(_STAGE_OLD_SUFFIX)]
    if not rotated:
        return
    present = {e.name for e in entries}
    if all(e.name[: -len(_STAGE_OLD_SUFFIX)] in present for e in rotated):
        return
    logger.warning("检测到中断的更新安装，正在回滚到旧版本")
    for old in rotated:
        primary = target / old.name[: -len(_STAGE_OLD_SUFFIX)]
        _remove_path(primary)
        try:
            os.rename(old, primary)
        except OSError:
            logger.exception("回滚失败: %s", old)


def cleanup_staging() -> None:
    """Remove leftover staging directory and swap residue from a previous update."""
    try:
        _recover_interrupted_swap(APP_HOME)
        _remove_swap_leftovers(APP_HOME)
        if STAGING_DIR.exists():
            shutil.rmtree(STAGING_DIR, ignore_errors=True)
            logger.debug("已清理 update_staging 目录")
        if STAGING_ZIP.exists():
            STAGING_ZIP.unlink(missing_ok=True)
            logger.debug("已清理 update_staging.zip")
    except Exception:
        logger.debug("清理 staging 时出错", exc_info=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_ready_staging_root() -> Path | None:
    """Return the extracted bundle root when staging already contains a runnable app."""
    if not STAGING_DIR.exists():
        return None
    try:
        staging = _find_inner_root(STAGING_DIR)
    except Exception:
        logger.debug("检查 update_staging 目录失败", exc_info=True)
        return None

    exe = staging / _PlatformHelper.executable_name()
    if exe.is_file():
        return staging
    return None

def _find_inner_root(staging_dir: Path) -> Path:
    """If the zip has a single top-level folder, return it; otherwise staging_dir."""
    entries = [e for e in staging_dir.iterdir() if not e.name.startswith(".")]
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return staging_dir
