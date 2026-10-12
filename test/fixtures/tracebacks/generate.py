"""Regenerate the REAL Python error outputs used by test/unit/errors.test.js.

Usage (any cwd):
    <engine>/venv/Scripts/python.exe test/fixtures/tracebacks/generate.py [--engine <engine root>]

The default engine is found like test/support/engine.js does: SCM_TEST_ENGINE_DIR, SCM_ENGINE_DIR,
<repo>/.engine-src (npm run engine:checkout), then <repo>/build/engine (npm run fetch-engine).

Every fixture is produced by actually running Python -- small snippets, or the engine's own
create_pdf.py -- inside a throw-away temporary directory (cwd = that directory, explicit relative
game/ paths), so the engine's real game/ and data/ folders are never touched.

Output (next to this script):
    <name>.txt          the child's stderr (what errors.parsePythonError receives)
    <name>.stdout.txt   the child's stdout, when it matters (e.g. "Image N:" lines)
    index.json          { <name>: { exitCode, description, stdout } }

The temporary directory and the user's home folder are replaced by neutral placeholders so the
files contain no personal paths; nothing else is edited.
"""
import argparse
import http.server
import json
import os
import re
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_DIR = HERE.parents[2]  # tracebacks -> fixtures -> test -> repository root


def default_engine() -> Path:
    """Same order as test/support/engine.js; a variable that is set wins even when it is wrong."""
    for name in ('SCM_TEST_ENGINE_DIR', 'SCM_ENGINE_DIR'):
        value = os.environ.get(name, '').strip()
        if value:
            return Path(value).resolve()
    for candidate in (REPO_DIR / '.engine-src', REPO_DIR / 'build' / 'engine'):
        if (candidate / 'create_pdf.py').is_file():
            return candidate
    return REPO_DIR / '.engine-src'


DEFAULT_ENGINE = default_engine()

TMP_PLACEHOLDER = r'C:\Users\user\AppData\Local\Temp\scm-fixtures'
HOME_PLACEHOLDER = r'C:\Users\user'


def child_env(tmp: Path, extra=None) -> dict:
    """Mirror jobs.pythonEnv(): clean PYTHON*/venv vars, force UTF-8 and the Agg backend."""
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith('PYTHON') and k.upper() not in ('VIRTUAL_ENV', 'CONDA_PREFIX')
           and not k.upper().startswith('UV_') and k.upper() not in ('SCM_EXTRA_LAYOUTS', 'SCM_CUTTING_TEMPLATES_DIR')}
    env.update({
        'PYTHONUNBUFFERED': '1', 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8:backslashreplace',
        'PYTHONHASHSEED': '0', 'PYTHONDONTWRITEBYTECODE': '1', 'MPLBACKEND': 'Agg',
        'MPLCONFIGDIR': str(tmp / 'mpl'),
    })
    if extra:
        env.update(extra)
    return env


def sanitize(text: str, tmp: Path) -> str:
    replacements = []
    for form in {str(tmp), str(tmp.resolve()), str(tmp).replace('\\', '/'), str(tmp.resolve()).replace('\\', '/')}:
        replacements.append((form, TMP_PLACEHOLDER if '\\' in form else TMP_PLACEHOLDER.replace('\\', '/')))
    home = os.path.expanduser('~')
    replacements.append((home, HOME_PLACEHOLDER))
    replacements.append((home.replace('\\', '/'), HOME_PLACEHOLDER.replace('\\', '/')))
    # Longest first so the temp dir (inside home) is replaced before home itself.
    for src, dst in sorted(replacements, key=lambda p: -len(p[0])):
        if src:
            text = re.sub(re.escape(src), lambda _m, d=dst: d, text, flags=re.IGNORECASE)
    return text


def png_bytes(width: int, height: int, pixel_rows: bytes | None = None) -> bytes:
    """Minimal RGB PNG writer (lets us lie about the size for the decompression-bomb case)."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    raw = pixel_rows if pixel_rows is not None else b''.join(b'\x00' + b'\x80\x40\x20' * width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


class StatusHandler(http.server.BaseHTTPRequestHandler):
    """Answers /cards/named* with 404 and /cards/search* with 429 (like Scryfall would)."""

    def do_GET(self):  # noqa: N802 (http.server naming)
        code = 404 if self.path.startswith('/cards/named') else 429 if self.path.startswith('/cards/search') else 200
        body = json.dumps({'object': 'error', 'status': code}).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', default=str(DEFAULT_ENGINE))
    args = parser.parse_args()
    engine = Path(args.engine).resolve()
    create_pdf = engine / 'create_pdf.py'
    if not create_pdf.is_file():
        print(f'create_pdf.py not found in {engine}', file=sys.stderr)
        return 1

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), StatusHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    index = {}
    with tempfile.TemporaryDirectory(prefix='scm-fixtures-') as tmp_name:
        tmp = Path(tmp_name)

        def workspace(name: str) -> Path:
            ws = tmp / name
            for kind in ('front', 'back', 'double_sided'):
                (ws / 'game' / kind).mkdir(parents=True, exist_ok=True)
            (ws / 'out').mkdir(exist_ok=True)
            return ws

        def run(name, argv, cwd, description, keep_stdout=False, extra_env=None, timeout=120):
            proc = subprocess.run(argv, cwd=cwd, env=child_env(tmp, extra_env), capture_output=True,
                                  timeout=timeout, stdin=subprocess.DEVNULL)
            stderr = sanitize(proc.stderr.decode('utf-8', 'backslashreplace'), tmp)
            stdout = sanitize(proc.stdout.decode('utf-8', 'backslashreplace'), tmp)
            (HERE / f'{name}.txt').write_text(stderr, encoding='utf-8', newline='\n')
            if keep_stdout:
                (HERE / f'{name}.stdout.txt').write_text(stdout, encoding='utf-8', newline='\n')
            index[name] = {'exitCode': proc.returncode, 'description': description, 'stdout': keep_stdout}
            last = stderr.strip().splitlines()[-1] if stderr.strip() else '(no stderr)'
            print(f'{name}: exit {proc.returncode}: {last[:140]}')

        def snippet(name, code, description, cwd=None, **kw):
            run(name, [sys.executable, '-c', code], cwd or tmp, description, **kw)

        def engine_pdf(name, ws, extra_args, description, **kw):
            argv = [sys.executable, str(create_pdf),
                    '--front_dir_path=game/front', '--back_dir_path=game/back',
                    '--double_sided_dir_path=game/double_sided', '--ppi=72', *extra_args]
            run(name, argv, ws, description, **kw)

        from PIL import Image  # the venv has Pillow (engine dependency)

        def good_png(path: Path):
            Image.new('RGB', (63, 88), (200, 40, 40)).save(path)

        # ---------------- network (all offline-safe) ----------------
        snippet('network_dns', "import requests\nrequests.get('http://scm-fixture.invalid/cards', timeout=5)",
                'requests ConnectionError: DNS name does not resolve (getaddrinfo failed)')
        snippet('network_timeout', "import requests\nrequests.get('http://10.255.255.1/', timeout=0.5)",
                'requests ConnectTimeout to an unroutable address')
        snippet('network_refused', "import requests\nrequests.get('http://127.0.0.1:9/', timeout=3)",
                'requests ConnectionError: connection refused')
        snippet('http_404',
                f"import requests\nr = requests.get('http://127.0.0.1:{port}/cards/named?exact=Lightning%20Boltz', timeout=5)\nr.raise_for_status()",
                'requests HTTPError 404 Client Error: Not Found (local server)')
        snippet('http_429',
                f"import requests\nr = requests.get('http://127.0.0.1:{port}/cards/search?q=bolt', timeout=5)\nr.raise_for_status()",
                'requests HTTPError 429 Client Error: Too Many Requests (local server)')
        snippet('ssl_error', f"import requests\nrequests.get('https://127.0.0.1:{port}/', timeout=5)",
                'requests SSLError: HTTPS spoken to a plain HTTP server')

        # ---------------- Pillow ----------------
        (tmp / 'not_an_image.png').write_text('this is a text file pretending to be a PNG\n', encoding='utf-8')
        snippet('pil_unidentified', "from PIL import Image\nImage.open('not_an_image.png')",
                'PIL.UnidentifiedImageError on a text file named .png')
        Image.new('RGB', (64, 64), (10, 120, 200)).save(tmp / 'full.jpg', quality=90)
        data = (tmp / 'full.jpg').read_bytes()
        (tmp / 'truncated.jpg').write_bytes(data[: len(data) // 2])
        snippet('pil_truncated', "from PIL import Image\nim = Image.open('truncated.jpg')\nim.load()",
                'OSError: image file is truncated')

        # ---------------- memory ----------------
        snippet('memory_error', "def render_page(n):\n    raise MemoryError()\n\nrender_page(1)",
                'bare MemoryError (what Pillow raises when a page bitmap cannot be allocated)')
        snippet('numpy_memory_error', "import numpy as np\nnp.zeros((10**13,), dtype=np.uint8)",
                'numpy _ArrayMemoryError: Unable to allocate ...')

        # ---------------- packages ----------------
        snippet('module_not_found', 'import scm_missing_module_xyz', 'ModuleNotFoundError')
        snippet('import_error', 'from PIL import NotAThing', 'ImportError: cannot import name')

        # ---------------- files ----------------
        (tmp / 'deck_utf16.txt').write_text('4 Lightning Bolt\n20 Mountain\n', encoding='utf-16')
        snippet('unicode_decode', "with open('deck_utf16.txt', 'r') as f:\n    f.read()",
                'UnicodeDecodeError reading a UTF-16 deck list the way plugins do (open(path, "r"))')
        ro = tmp / 'readonly.txt'
        ro.write_text('locked', encoding='utf-8')
        os.chmod(ro, stat.S_IREAD)
        snippet('permission_open', "open('readonly.txt', 'w')", 'PermissionError [Errno 13] opening a read-only file')
        snippet('file_not_found', "open('missing-deck.txt')", 'FileNotFoundError (generic, unmapped error)')

        # ---------------- engine: create_pdf.py ----------------
        run('click_usage', [sys.executable, str(create_pdf), '--card_size', 'nope'], tmp,
            'click usage error, exit 2 (invalid --card_size choice)')

        ws = workspace('bad_image')
        (ws / 'game' / 'front' / 'broken.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'garbage that is not a PNG' * 4)
        engine_pdf('pdf_bad_image', ws, ['--only_fronts', '--output_path=out/deck.pdf'],
                   'create_pdf: OSError Failed to load front image "..." (PNG signature + garbage)', keep_stdout=True)

        ws = workspace('bomb')
        good_png(ws / 'game' / 'front' / 'a_ok.png')
        (ws / 'game' / 'front' / 'b_bomb.png').write_bytes(png_bytes(20000, 20000, pixel_rows=b'\x00'))
        engine_pdf('pdf_decompression_bomb', ws, ['--only_fronts', '--output_path=out/deck.pdf'],
                   'create_pdf: PIL.Image.DecompressionBombError (IHDR claims 20000x20000)', keep_stdout=True)

        ws = workspace('permission')
        good_png(ws / 'game' / 'front' / 'card.png')
        locked = ws / 'out' / 'deck.pdf'
        locked.write_bytes(b'%PDF-1.4\n')
        os.chmod(locked, stat.S_IREAD)
        engine_pdf('pdf_permission_denied', ws, ['--only_fronts', '--output_path=out/deck.pdf'],
                   'create_pdf: PermissionError [Errno 13] when saving over a read-only/locked PDF', keep_stdout=True)
        os.chmod(locked, stat.S_IWRITE | stat.S_IREAD)

        ws = workspace('ds_without_front')
        good_png(ws / 'game' / 'front' / 'alpha.png')
        good_png(ws / 'game' / 'double_sided' / 'beta.png')
        engine_pdf('pdf_ds_without_front', ws, ['--output_path=out/deck.pdf'],
                   'create_pdf: Exception "... do not have matching fronts"', keep_stdout=True)

        ws = workspace('does_not_fit')
        good_png(ws / 'game' / 'front' / 'card.png')
        giant = ws / 'giant_layouts.json'
        giant.write_text(json.dumps({
            'card_sizes': {'scm_fixture_giant': {'width': '400mm', 'height': '400mm'}},
            'layouts': {'letter': {'scm_fixture_giant': {'default': {
                'orientation': 'landscape', 'version': 1, 'num_rows': 1, 'num_cols': 1}}}},
        }), encoding='utf-8')
        engine_pdf('pdf_does_not_fit', ws,
                   ['--only_fronts', '--card_size=scm_fixture_giant', '--paper_size=letter', '--output_path=out/deck.pdf'],
                   'create_pdf: Exception Card size "..." does not fit on paper size "..." (extra layout 400x400 mm)',
                   keep_stdout=True, extra_env={'SCM_EXTRA_LAYOUTS': str(giant)})

        ws = workspace('bad_offset')
        good_png(ws / 'game' / 'front' / 'card.png')
        (ws / 'data').mkdir()
        (ws / 'data' / 'offset_data.json').write_text(
            json.dumps({'x_offset': 1.5, 'y_offset': 0, 'angle_offset': 0}), encoding='utf-8')
        engine_pdf('pdf_offset_validation', ws, ['--only_fronts', '--load_offset', '--output_path=out/deck.pdf'],
                   'create_pdf --load_offset with a non-integer x_offset: pydantic ValidationError', keep_stdout=True)

        os.chmod(ro, stat.S_IWRITE | stat.S_IREAD)

    server.shutdown()
    (HERE / 'index.json').write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(f'wrote {len(index)} fixtures to {HERE}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
