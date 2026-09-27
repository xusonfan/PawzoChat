# PawzoChat notices

PawzoChat is originally authored by **iwyxdxl**.

Copyright (C) 2026 iwyxdxl

Canonical source repository: <https://github.com/iwyxdxl/PawzoChat>

This program is licensed under the GNU Affero General Public License,
version 3 or (at your option) any later version. See `LICENSE` for the
complete license text.

---

## Third-Party Components & Attribution

### Remix Icon (vendored icon sprite)

- **Source:** <https://remixicon.com> / <https://github.com/Remix-Design/RemixIcon>
- **Files:** `pawzochat/web/static/assets/vendor/remixicon/remixicon.symbol.svg`, `NOTICE.txt`
- **License:** Apache License, Version 2.0
- **Copyright:** RemixIcon.com

### @tencent-weixin/openclaw-weixin (ported reference implementation)

- **Source:** <https://github.com/Tencent/openclaw-weixin>
- **Files:** `pawzochat/transport/client.py`, `pawzochat/transport/cdn.py`, `pawzochat/store/quotes.py`
- **License:** MIT
- **Copyright:** Tencent WeChat

### @tencent-connect/openclaw-qqbot (ported reference implementation)

- **Source:** <https://github.com/tencent-connect/openclaw-qqbot>
- **Files:** `pawzochat/channels/qq.py`, `pawzochat/transport/qq/`
- **License:** MIT
- **Copyright:** sliverp; Tencent Connect

### @tencent-connect/qqbot-nodejs 1.0.4 (protocol reference)

- **Source:** <https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs/v/1.0.4>
- **Files:** `pawzochat/transport/qq/upload.py`
- **License:** MIT
- **Reference:** `src/protocol/api/media-chunked.ts` from the published SDK.

### Python Dependencies

PawzoChat depends on the following open-source Python packages (installed
via pip; each carries its own license):

| Package | License |
|---------|---------|
| requests | Apache 2.0 |
| PyYAML | MIT |
| Flask | BSD 3-Clause |
| cheroot | BSD 3-Clause / AGPL 3.0 |
| pycryptodome | BSD / Public Domain |
| qrcode | BSD 3-Clause |
| Pillow | MIT-CMU |
| openai | Apache 2.0 |
| anthropic | MIT |
| google-genai | Apache 2.0 |
| httpx | BSD 3-Clause |
| cryptography | Apache 2.0 / BSD 3-Clause |
| websocket-client | Apache 2.0 |
| mcp | MIT |
| miniaudio | MIT |
| pysilk-mod | BSD 3-Clause
