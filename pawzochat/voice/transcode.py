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

"""Audio transcoding utilities for browser playback and QQ voice delivery.

QQ voice bubbles require SILK encoding, while TTS providers uniformly
return MP3. This module provides an in-memory transcoding chain:

* ``miniaudio`` — MP3 -> s16le mono PCM (bundles its own C decoder, no ffmpeg needed)
* ``pysilk`` (pysilk-mod) — PCM <-> SILK v3

Both dependencies are lazily imported inside the function body: if the wheel
is missing, the app still starts normally and the web panel's voice bubble
(which plays the MP3 directly) is unaffected; the QQ channel catches
:class:`TranscodeUnavailableError` and falls back to sending a file.
(WeChat always delivers TTS clips as a file card — iLink's delivery pipeline
drops bot-sent voice_item, so no SILK transcode happens on that channel.)
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# SILK rate for outbound QQ voice bubbles; field-proven at 24000 by this app.
SILK_SAMPLE_RATE = 24000

_SILK_MAGIC = b"#!SILK_V3"
_SILK_TENCENT_PREFIX = b"\x02"
_SILK_TERMINATOR = b"\xff\xff"
_SILK_SAMPLE_RATES = {8000, 12000, 16000, 24000}


class TranscodeUnavailableError(RuntimeError):
    """Raised when a transcoding dependency (miniaudio / pysilk-mod) is not installed."""


def _import_miniaudio():
    try:
        import miniaudio  # noqa: PLC0415
    except ImportError as exc:
        raise TranscodeUnavailableError(
            "音频转码依赖 miniaudio 未安装，请执行 pip install miniaudio",
        ) from exc
    return miniaudio


def _import_pysilk():
    try:
        import pysilk  # noqa: PLC0415  (pysilk-mod)
    except ImportError as exc:
        raise TranscodeUnavailableError(
            "SILK 编码依赖 pysilk-mod 未安装，请执行 pip install pysilk-mod",
        ) from exc
    return pysilk


def mp3_to_pcm(
    mp3_bytes: bytes, sample_rate: int = SILK_SAMPLE_RATE,
) -> tuple[bytes, int]:
    """MP3 -> s16le mono PCM. Returns ``(pcm_bytes, duration_ms)``."""
    miniaudio = _import_miniaudio()
    decoded = miniaudio.decode(
        mp3_bytes,
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=sample_rate,
    )
    # decoded.samples is an int16 array whose length = sample count (mono).
    duration_ms = len(decoded.samples) * 1000 // sample_rate
    return decoded.samples.tobytes(), duration_ms


def probe_mp3_duration_ms(mp3_bytes: bytes) -> int:
    """Probe MP3 duration (ms). Any failure (including a missing dependency) returns 0 instead of raising."""
    return probe_audio_duration_ms(mp3_bytes)


def probe_audio_duration_ms(audio_bytes: bytes) -> int:
    """Probe supported audio duration (ms), returning 0 on any failure."""
    try:
        miniaudio = _import_miniaudio()
        decoded = miniaudio.decode(
            audio_bytes,
            output_format=miniaudio.SampleFormat.SIGNED16,
            nchannels=1,
            sample_rate=SILK_SAMPLE_RATE,
        )
        duration_ms = len(decoded.samples) * 1000 // SILK_SAMPLE_RATE
        return duration_ms
    except Exception:
        logger.debug("音频时长探测失败，返回 0", exc_info=True)
        return 0


def silk_to_wav(
    silk_bytes: bytes,
    *,
    sample_rate: int = SILK_SAMPLE_RATE,
) -> bytes:
    """Decode Tencent SILK v3 bytes to a browser-playable WAV file."""
    pysilk = _import_pysilk()
    return bytes(pysilk.decode(silk_bytes, to_wav=True, sample_rate=sample_rate))


def normalize_inbound_audio(
    audio_bytes: bytes,
    *,
    encode_type: int = 0,
    sample_rate: int = SILK_SAMPLE_RATE,
) -> tuple[bytes, str, str, int]:
    """Return browser-playable ``(bytes, extension, mime, duration_ms)``.

    WeChat explicitly identifies SILK with ``encode_type=6``. QQ commonly
    labels a Tencent SILK payload as ``.amr``, so the magic header is also
    detected. WAV, MP3, and Ogg inputs are already browser-ready.
    """
    if not audio_bytes:
        raise ValueError("语音内容为空")

    if audio_bytes.startswith(b"RIFF") and audio_bytes[8:12] == b"WAVE":
        normalized, ext, mime = audio_bytes, ".wav", "audio/wav"
    elif audio_bytes.startswith(b"ID3") or (
        len(audio_bytes) >= 2
        and audio_bytes[0] == 0xFF
        and (audio_bytes[1] & 0xE0) == 0xE0
    ):
        normalized, ext, mime = audio_bytes, ".mp3", "audio/mpeg"
    elif audio_bytes.startswith(b"OggS"):
        normalized, ext, mime = audio_bytes, ".ogg", "audio/ogg"
    elif (
        encode_type == 6
        or audio_bytes.startswith(_SILK_TENCENT_PREFIX + _SILK_MAGIC)
    ):
        decode_rate = (
            sample_rate if sample_rate in _SILK_SAMPLE_RATES else SILK_SAMPLE_RATE
        )
        normalized = silk_to_wav(audio_bytes, sample_rate=decode_rate)
        ext, mime = ".wav", "audio/wav"
    else:
        raise ValueError(f"暂不支持的入站语音编码: encode_type={encode_type}")

    return normalized, ext, mime, probe_audio_duration_ms(normalized)


def pcm_to_silk(
    pcm_bytes: bytes,
    sample_rate: int = SILK_SAMPLE_RATE,
    *,
    tencent: bool = True,
) -> bytes:
    """s16le mono PCM -> SILK v3.

    ``tencent=True`` outputs the WeChat/QQ voice-file variant: insert
    ``\\x02`` before the standard SILK header and strip the trailing
    ``\\xff\\xff`` end marker.
    """
    pysilk = _import_pysilk()
    # pysilk.encode(data, data_rate, *, sample_rate): data_rate is the
    # encoding bitrate (bps); the keyword-only sample_rate is the input PCM's
    # sample rate — both must be passed.
    # pysilk-mod's output is already the Tencent variant (\x02 prefix, no
    # \xff\xff terminator); this does defensive normalization so either
    # direction converts cleanly.
    silk = bytes(pysilk.encode(pcm_bytes, data_rate=sample_rate, sample_rate=sample_rate))
    has_prefix = silk.startswith(_SILK_TENCENT_PREFIX + _SILK_MAGIC)
    if tencent:
        if not has_prefix and silk.startswith(_SILK_MAGIC):
            if silk.endswith(_SILK_TERMINATOR):
                silk = silk[: -len(_SILK_TERMINATOR)]
            silk = _SILK_TENCENT_PREFIX + silk
        return silk
    if has_prefix:
        silk = silk[len(_SILK_TENCENT_PREFIX):]
    if not silk.endswith(_SILK_TERMINATOR):
        silk = silk + _SILK_TERMINATOR
    return silk


def mp3_to_silk(
    mp3_bytes: bytes,
    *,
    sample_rate: int = SILK_SAMPLE_RATE,
    tencent: bool = True,
) -> tuple[bytes, int]:
    """MP3 -> SILK. Returns ``(silk_bytes, duration_ms)``.

    Raises :class:`TranscodeUnavailableError` when a dependency is missing;
    an encoding failure raises the original exception, leaving the fallback
    strategy up to the caller.
    """
    pcm, duration_ms = mp3_to_pcm(mp3_bytes, sample_rate)
    silk = pcm_to_silk(pcm, sample_rate, tencent=tencent)
    return silk, duration_ms
