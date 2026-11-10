"""Install the pinned Lua/Busted test tools inside this worktree (requires a C compiler)."""

from pathlib import Path
import os
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
SETUP = ROOT / "runtime" / "lua-setup"
PREFIX = ROOT / "runtime" / "lua"
HEREROCKS_REV = "ec31d070ae0076415c0175a2006b29496494d37a"


def main():
    SETUP.mkdir(parents=True, exist_ok=True)
    script = SETUP / "hererocks.py"
    urllib.request.urlretrieve(
        f"https://raw.githubusercontent.com/luarocks/hererocks/{HEREROCKS_REV}/hererocks.py",
        script,
    )
    subprocess.run(
        [sys.executable, str(script), str(PREFIX), "-l", "5.3.6", "-r", "3.13.0"],
        check=True,
        cwd=ROOT,
    )
    rocks = PREFIX / "bin" / ("luarocks.bat" if os.name == "nt" else "luarocks")
    subprocess.run([str(rocks), "install", "busted", "2.3.0-1"], check=True, cwd=ROOT)


if __name__ == "__main__":
    main()
