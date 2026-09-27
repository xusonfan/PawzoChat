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

"""PawzoChat entry point."""

import sys


def main():
    if "--apply-update" in sys.argv:
        from pawzochat.updater import apply_update
        apply_update(sys.argv)
        return

    from pawzochat.updater import cleanup_staging
    cleanup_staging()

    from pawzochat.app import App
    app = App()
    try:
        app.start()
    except KeyboardInterrupt:
        app.shutdown()


if __name__ == "__main__":
    main()
