#!/usr/bin/env python3
"""Kirigami desktop helper.

Small, self-contained command line tool that the Electron app runs with the
card maker's own Python interpreter to ask questions about the engine (the
Python project) and to do a few image/PDF chores that need Pillow/pypdfium2.

Invocation (always non-interactive):

    python scm_helper.py <command> --root <workspace> --out <result.json> [...]

Contract
--------
* Exactly one JSON document is written to ``--out`` (atomically). Nothing is
  ever written to stdout on purpose: everything the engine or this helper
  prints goes to stderr (the log stream).
* Exit code 0 on success. On failure the result file contains
  ``{"error": "<Type>: <message>", "type", "message", "traceback"}`` and the
  exit code is 1.
* Standard input is never read (``input()`` raises instead of blocking).
* The engine is imported from ``--root`` (``sys.path.insert(0, root)``).

Commands
--------
introspect       click parameters of create_pdf/offset_pdf/plugins + layout geometry
env-check        which runtime packages are importable (never imports the engine)
smoke-test       renders a tiny PDF in-process with utilities.generate_pdf
prepare-upscale  normalizes images (EXIF rotation, RGB) to PNG before upscaling
validate-images  sanity checks upscaled images (size, blank, brightness)
list-images      lists the images the engine would read from a folder
merge-pdfs       joins PDFs losslessly (pypdfium2 import_pages)
pdf-info         page count, page size and image resolution of a PDF
make-test-cards  draws numbered high-contrast test cards (+ one test back) for a first print/cut
"""

from __future__ import annotations

import argparse
import builtins
import contextlib
import importlib
import io
import json
import math
import os
import platform
import re
import sys
import tempfile
import time
import traceback
import warnings
from enum import Enum

# Never write __pycache__ into the engine folder and never open a GUI backend.
sys.dont_write_bytecode = True
os.environ.setdefault('MPLBACKEND', 'Agg')

HELPER_VERSION = 1

# Distribution name (normalized) -> importable top-level module.
DIST_TO_IMPORT = {
    'attrs': 'attr',
    'beautifulsoup4': 'bs4',
    'charset-normalizer': 'charset_normalizer',
    'ezdxf': 'ezdxf',
    'matplotlib': 'matplotlib',
    'mtg-parser': 'mtg_parser',
    'msgpack-python': 'msgpack',
    'opencv-contrib-python': 'cv2',
    'opencv-python': 'cv2',
    'opencv-python-headless': 'cv2',
    'pillow': 'PIL',
    'protobuf': 'google.protobuf',
    'pyautogui': 'pyautogui',
    'pycryptodome': 'Crypto',
    'pymupdf': 'fitz',
    'pyopenssl': 'OpenSSL',
    'pypdfium2': 'pypdfium2',
    'pyserial': 'serial',
    'python-dateutil': 'dateutil',
    'python-magic': 'magic',
    'python-slugify': 'slugify',
    'pywin32': 'win32api',
    'pywinauto': 'pywinauto',
    'pyyaml': 'yaml',
    'pyzmq': 'zmq',
    'requests-toolbelt': 'requests_toolbelt',
    'scikit-image': 'skimage',
    'scikit-learn': 'sklearn',
    'split-image': 'split_image',
    'typing-extensions': 'typing_extensions',
}

# filetype mime subtype -> sniffed type reported to the app.
MIME_TO_SNIFFED = {
    'jpeg': 'jpeg',
    'png': 'png',
    'apng': 'png',
    'gif': 'gif',
    'webp': 'webp',
    'bmp': 'bmp',
    'tiff': 'tiff',
    'avif': 'avif',
    'jpx': 'jpx',
    'heic': 'heic',
    'qoi': 'qoi',
    'dds': 'dds',
    'x-icon': 'ico',
    'vnd.adobe.photoshop': 'psd',
}

# Pillow format name -> sniffed type (fallback when filetype is unavailable).
PIL_FORMAT_TO_SNIFFED = {
    'JPEG': 'jpeg',
    'MPO': 'jpeg',
    'PNG': 'png',
    'GIF': 'gif',
    'WEBP': 'webp',
    'BMP': 'bmp',
    'DIB': 'bmp',
    'TIFF': 'tiff',
    'AVIF': 'avif',
    'JPEG2000': 'jpx',
    'QOI': 'qoi',
    'DDS': 'dds',
    'ICO': 'ico',
    'PSD': 'psd',
}

STATS_THUMB_SIZE = 256


class HelperError(Exception):
    """An expected failure whose message is meant to be shown to the user."""


# --------------------------------------------------------------------------------------
# stdio / JSON plumbing
# --------------------------------------------------------------------------------------

def log(message: str) -> None:
    """Write one diagnostic line to stderr (the app's log stream)."""
    try:
        print(message, file=sys.stderr, flush=True)
    except Exception:  # pragma: no cover - logging must never fail the command
        pass


def _no_input(prompt: object = '') -> str:
    raise RuntimeError(f'scm_helper never reads standard input (a prompt was requested: {prompt!r})')


def configure_stdio() -> None:
    """UTF-8 stderr, stdout redirected to stderr, stdin disabled."""
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    except Exception:
        pass
    # Anything the engine prints (progress, notices) is diagnostics, not our result.
    sys.stdout = sys.stderr
    try:
        sys.stdin = open(os.devnull, 'r', encoding='utf-8')
    except OSError:
        sys.stdin = io.StringIO('')
    builtins.input = _no_input


def json_safe(value):
    """Convert a value into something json.dumps accepts and JavaScript can parse."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Enum):
        return json_safe(value.value)
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [json_safe(v) for v in value]
    if isinstance(value, os.PathLike):
        return os.fspath(value)
    return str(value)


def write_json(path: str, obj) -> None:
    """Atomically write obj as UTF-8 JSON to path (temp file + os.replace)."""
    data = json.dumps(json_safe(obj), ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    target = os.path.abspath(path)
    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.scm-result-', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(10):
            try:
                os.replace(tmp, target)
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def read_json(path: str):
    with open(path, 'r', encoding='utf-8-sig') as handle:
        return json.load(handle)


def describe_exception(exc: BaseException) -> str:
    message = str(exc).strip()
    name = type(exc).__name__
    return f'{name}: {message}' if message else name


def round_or_none(value, digits=4):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, digits) if math.isfinite(number) else None


# --------------------------------------------------------------------------------------
# Engine import
# --------------------------------------------------------------------------------------

def engine_root_from(args) -> str:
    root = os.path.abspath(args.root or os.getcwd())
    if not os.path.isfile(os.path.join(root, 'utilities.py')):
        raise HelperError(f'Card maker files not found at {root}')
    return root


def import_engine(root: str):
    """Import the engine's utilities module from root, keeping stdout clean."""
    if sys.path[:1] != [root]:
        sys.path.insert(0, root)
    with contextlib.redirect_stdout(sys.stderr):
        return importlib.import_module('utilities')


# --------------------------------------------------------------------------------------
# introspect
# --------------------------------------------------------------------------------------

def _click_unset():
    try:
        from click._utils import UNSET  # click >= 8.3
        return UNSET
    except Exception:
        return None


def _plain_value(value, unset):
    if unset is not None and value is unset:
        return None
    if callable(value) and not isinstance(value, (str, bytes)):
        return None
    if isinstance(value, Enum):
        return json_safe(value.value)
    if isinstance(value, (list, tuple)):
        return [_plain_value(v, unset) for v in value]
    return json_safe(value)


def param_spec(param) -> dict:
    """Describe one click parameter as a JSON-safe ParamSpec."""
    import click

    unset = _click_unset()
    kind = 'argument' if isinstance(param, click.Argument) else 'option'
    param_type = param.type
    spec = {
        'name': param.name,
        'kind': kind,
        'flags': list(getattr(param, 'opts', []) or []),
        'secondaryFlags': list(getattr(param, 'secondary_opts', []) or []),
        'type': 'other',
        'choices': None,
        'min': None,
        'max': None,
        'multiple': bool(getattr(param, 'multiple', False)) or (kind == 'argument' and getattr(param, 'nargs', 1) == -1),
        'isFlag': bool(getattr(param, 'is_flag', False)),
        'required': bool(getattr(param, 'required', False)),
        'default': None,
        'help': getattr(param, 'help', None),
        'nargs': getattr(param, 'nargs', 1),
        'hidden': bool(getattr(param, 'hidden', False)),
        'exposeValue': bool(getattr(param, 'expose_value', True)),
        'caseSensitive': None,
    }

    if isinstance(param_type, click.Choice):
        spec['type'] = 'choice'
        spec['choices'] = [str(_plain_value(c, unset)) for c in param_type.choices]
        spec['caseSensitive'] = bool(getattr(param_type, 'case_sensitive', True))
    elif isinstance(param_type, click.IntRange):
        spec['type'] = 'int_range'
        spec['min'] = param_type.min
        spec['max'] = param_type.max
    elif isinstance(param_type, click.FloatRange):
        spec['type'] = 'float_range'
        spec['min'] = round_or_none(param_type.min, 10)
        spec['max'] = round_or_none(param_type.max, 10)
    elif isinstance(param_type, click.types.BoolParamType):
        spec['type'] = 'bool'
    elif isinstance(param_type, click.types.IntParamType):
        spec['type'] = 'int'
    elif isinstance(param_type, click.types.FloatParamType):
        spec['type'] = 'float'
    elif isinstance(param_type, (click.Path, click.File)):
        spec['type'] = 'path'
    elif isinstance(param_type, click.types.StringParamType):
        spec['type'] = 'string'

    try:
        spec['default'] = _plain_value(param.default, unset)
    except Exception:
        spec['default'] = None
    return spec


def find_click_command(module, preferred: str):
    import click

    candidate = getattr(module, preferred, None)
    if isinstance(candidate, click.Command):
        return candidate
    commands = [v for v in vars(module).values() if isinstance(v, click.Command)]
    own = [c for c in commands if getattr(getattr(c, 'callback', None), '__module__', None) == module.__name__]
    if own or commands:
        return (own or commands)[0]
    raise HelperError(f'No command line interface found in {module.__name__}')


def command_version(command):
    """Version reported by ``--version`` (click.version_option), or None."""
    try:
        from click.testing import CliRunner

        result = CliRunner().invoke(command, ['--version'], prog_name='create_pdf')
        match = re.search(r'version\s+([0-9][0-9A-Za-z.+\-]*)', result.output or '')
        return match.group(1) if match else None
    except Exception as exc:
        log(f'Could not read the engine version from --version: {describe_exception(exc)}')
        return None


def pyproject_version(root: str):
    path = os.path.join(root, 'pyproject.toml')
    if not os.path.isfile(path):
        return None
    try:
        import tomllib

        with open(path, 'rb') as handle:
            return (tomllib.load(handle).get('project') or {}).get('version')
    except Exception:
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as handle:
                match = re.search(r'^\s*version\s*=\s*"([^"]+)"', handle.read(), re.MULTILINE)
            return match.group(1) if match else None
        except OSError:
            return None


def build_template_index(engine_root: str):
    """Map template stem -> absolute .studio3 path (first match, shallowest first)."""
    base = os.path.join(engine_root, 'cutting_templates')
    exact, folded = {}, {}
    if not os.path.isdir(base):
        return exact, folded
    entries = []
    for current, dirs, files in os.walk(base):
        dirs.sort()
        for filename in files:
            if not filename.lower().endswith('.studio3'):
                continue
            full = os.path.abspath(os.path.join(current, filename))
            relative = os.path.relpath(full, base)
            entries.append((relative.count(os.sep), relative.lower(), full, filename[:-len('.studio3')]))
    for _depth, _rel, full, stem in sorted(entries):
        exact.setdefault(stem, full)
        folded.setdefault(stem.lower(), full)
    return exact, folded


class LayoutDescriber:
    """Computes layout geometry exactly like utilities.generate_pdf does."""

    def __init__(self, utilities, engine_root: str):
        import page_manager
        import size_convert
        from enums import Variant

        self.utilities = utilities
        self.page_manager = page_manager
        self.size_convert = size_convert
        self.Variant = Variant
        self.config = utilities.load_layout_config()
        self.ppi = self.config.ppi
        self.default_reg = self.config.defaults.registration.default
        self.borderless_reg = self.config.defaults.registration.borderless
        self.templates_exact, self.templates_folded = build_template_index(engine_root)
        self._page_px_cache = {}

    # -- helpers -------------------------------------------------------------------
    def mm(self, value):
        try:
            return round_or_none(self.size_convert.size_to_mm(value), 4)
        except Exception:
            return None

    def px(self, value):
        try:
            return int(self.size_convert.size_to_pixel(value, self.ppi))
        except Exception:
            return None

    def template_file(self, template: str):
        if not template:
            return None
        return self.templates_exact.get(template) or self.templates_folded.get(template.lower())

    def page_px_300(self, paper_width: str, paper_height: str):
        """Size of the page bitmap create_pdf renders at the layout PPI (landscape, as in the PDF).

        create_pdf draws the page with matplotlib (figsize = paper / 25.4 in at layout PPI),
        so ask matplotlib for the canvas size instead of re-deriving its rounding.
        """
        key = (paper_width, paper_height)
        if key in self._page_px_cache:
            return self._page_px_cache[key]
        value = (None, None)
        try:
            import matplotlib.pyplot as plt

            width_mm = self.size_convert.size_to_mm(paper_width)
            height_mm = self.size_convert.size_to_mm(paper_height)
            figure = plt.figure(figsize=(width_mm / 25.4, height_mm / 25.4), dpi=self.ppi)
            try:
                renderer = figure.canvas.get_renderer()
                value = (int(renderer.width), int(renderer.height))
            finally:
                plt.close(figure)
        except Exception as exc:
            log(f'Could not compute the page bitmap size for {paper_width} x {paper_height}: {describe_exception(exc)}')
        self._page_px_cache[key] = value
        return value

    def card_aliases(self):
        return {alias: name for name, card in self.config.card_sizes.items() for alias in (card.aliases or [])}

    def paper_aliases(self):
        return {alias: name for name, paper in self.config.paper_sizes.items() for alias in (paper.aliases or [])}

    def card_sizes(self):
        order = [n for n in self.utilities.get_all_card_size_names(self.config) if n in self.config.card_sizes]
        order += [n for n in self.config.card_sizes if n not in order]
        result = []
        for name in order:
            card = self.config.card_sizes[name]
            radius = card.radius or self.config.defaults.card_radius
            result.append({
                'name': name,
                'width': card.width,
                'height': card.height,
                'widthMm': self.mm(card.width),
                'heightMm': self.mm(card.height),
                'radius': radius,
                'radiusMm': self.mm(radius),
                'aliases': list(card.aliases or []),
            })
        return result

    def paper_sizes(self):
        order = [n for n in self.utilities.get_all_paper_size_names(self.config) if n in self.config.paper_sizes]
        order += [n for n in self.config.paper_sizes if n not in order]
        result = []
        for name in order:
            paper = self.config.paper_sizes[name]
            page_w, page_h = self.page_px_300(paper.width, paper.height)
            result.append({
                'name': name,
                'width': paper.width,
                'height': paper.height,
                'widthMm': self.mm(paper.width),
                'heightMm': self.mm(paper.height),
                'pageWidthPx300': page_w,
                'pageHeightPx300': page_h,
                'aliases': list(paper.aliases or []),
            })
        return result

    # -- layout records ------------------------------------------------------------
    @staticmethod
    def blank_record(key, paper, card, variant, specialty):
        """A Layout with every key present (values filled in by _record)."""
        return {
            'key': key, 'paper': paper, 'card': card, 'variant': variant, 'specialty': specialty,
            'orientation': None, 'registrationOrientation': None,
            'rows': 0, 'cols': 0, 'cardsPerPage': 0, 'xPos': [], 'yPos': [],
            'cardWidthPx': None, 'cardHeightPx': None, 'paperWidthPx': None, 'paperHeightPx': None,
            'pageWidthPx300': None, 'pageHeightPx300': None,
            'inset': None, 'thickness': None, 'length': None, 'exclusionLength': None,
            'insetPx': None, 'thicknessPx': None, 'lengthPx': None,
            'cardWidth': None, 'cardHeight': None, 'cardWidthMm': None, 'cardHeightMm': None,
            'radius': None, 'radiusMm': None, 'radiusPx': None,
            'paperWidth': None, 'paperHeight': None, 'paperWidthMm': None, 'paperHeightMm': None,
            'version': None, 'template': None, 'templateFile': None,
            'declaredRows': None, 'declaredCols': None, 'maxLengthMm': None, 'error': None,
        }

    def _record(self, record, *, version, template, card_def, paper_def, orientation,
                registration_orientation, effective_inset, effective_thickness, effective_length,
                declared_rows, declared_cols):
        """Fill a blank record exactly the way utilities.generate_pdf computes its layout."""
        total_exclusion_mm = self.size_convert.size_to_mm(self.default_reg.length) + self.page_manager.REG_PADDING_MM
        exclusion_length = f'{total_exclusion_mm}mm'
        radius = card_def.radius or self.config.defaults.card_radius
        page_w, page_h = self.page_px_300(paper_def.width, paper_def.height)
        record.update({
            'orientation': json_safe(orientation),
            'registrationOrientation': json_safe(registration_orientation),
            'pageWidthPx300': page_w,
            'pageHeightPx300': page_h,
            'inset': effective_inset,
            'thickness': effective_thickness,
            'length': effective_length,
            'exclusionLength': exclusion_length,
            'insetPx': self.px(effective_inset),
            'thicknessPx': self.px(effective_thickness),
            'lengthPx': self.px(effective_length),
            'cardWidth': card_def.width,
            'cardHeight': card_def.height,
            'cardWidthMm': self.mm(card_def.width),
            'cardHeightMm': self.mm(card_def.height),
            'radius': radius,
            'radiusMm': self.mm(radius),
            'radiusPx': self.px(radius),
            'paperWidth': paper_def.width,
            'paperHeight': paper_def.height,
            'paperWidthMm': self.mm(paper_def.width),
            'paperHeightMm': self.mm(paper_def.height),
            'version': version,
            'template': template,
            'templateFile': self.template_file(template),
            'declaredRows': declared_rows,
            'declaredCols': declared_cols,
        })
        try:
            computed = self.page_manager.generate_layout(
                orientation=orientation,
                card_width=card_def.width,
                card_height=card_def.height,
                paper_width=paper_def.width,
                paper_height=paper_def.height,
                inset=effective_inset,
                length=exclusion_length,
                ppi=self.ppi,
            )
        except Exception as exc:
            record['error'] = describe_exception(exc)
            return record

        x_pos = [int(v) for v in computed.x_pos]
        y_pos = [int(v) for v in computed.y_pos]
        record.update({
            'rows': len(y_pos),
            'cols': len(x_pos),
            'cardsPerPage': len(x_pos) * len(y_pos),
            'xPos': x_pos,
            'yPos': y_pos,
            'cardWidthPx': int(computed.card_width_px),
            'cardHeightPx': int(computed.card_height_px),
            'paperWidthPx': int(computed.paper_width_px),
            'paperHeightPx': int(computed.paper_height_px),
            'maxLengthMm': round_or_none(computed.max_length_mm, 4),
        })
        if record['cardsPerPage'] == 0:
            record['error'] = f'Card size "{record["card"]}" does not fit on paper size "{record["paper"]}".'
        return record

    def combo(self, paper: str, card: str, variant_name: str, layout_def) -> dict:
        """One entry of layouts.json (normal branch of generate_pdf)."""
        Variant = self.Variant
        record = self.blank_record(f'{paper}|{card}|{variant_name}', paper, card, variant_name, None)
        try:
            variant = Variant(variant_name)
        except ValueError:
            record['error'] = f'Unknown layout variant "{variant_name}"'
            return record
        card_def = self.config.card_sizes.get(card)
        paper_def = self.config.paper_sizes.get(paper)
        if card_def is None or paper_def is None:
            missing = f'card size "{card}"' if card_def is None else f'paper size "{paper}"'
            record['error'] = f'Unknown {missing}'
            return record

        orientation = layout_def.orientation
        registration_orientation = layout_def.registration_orientation or orientation
        layout_reg = layout_def.registration or self.utilities.RegistrationSettings()
        if variant == Variant.BORDERLESS:
            effective_inset = layout_reg.inset or self.borderless_reg.inset
        else:
            effective_inset = layout_reg.inset or self.default_reg.inset
        return self._record(
            record,
            version=layout_def.version,
            template=self.utilities.template_name(paper, card, variant, layout_def.version),
            card_def=card_def,
            paper_def=paper_def,
            orientation=orientation,
            registration_orientation=registration_orientation,
            effective_inset=effective_inset,
            effective_thickness=layout_reg.thickness or self.default_reg.thickness,
            effective_length=layout_reg.length or self.default_reg.length,
            declared_rows=layout_def.num_rows,
            declared_cols=layout_def.num_cols,
        )

    def specialty(self, name: str, spec) -> dict:
        """One specialty layout (specialty branch of generate_pdf)."""
        utilities = self.utilities
        record = self.blank_record(f'specialty:{name}', spec.paper_size.name, spec.card_size.name, None, name)
        record['name'] = name
        template = f'{name}-v{spec.version}'
        try:
            if spec.card_size.name:
                if spec.card_size.name not in self.config.card_sizes:
                    raise HelperError(f'Card size "{spec.card_size.name}" not found in card_sizes.')
                card_base = self.config.card_sizes[spec.card_size.name]
                card_def = utilities.CardSizeDef(width=card_base.width, height=card_base.height,
                                                 radius=spec.card_size.radius or card_base.radius)
            else:
                card_def = utilities.CardSizeDef(width=spec.card_size.width, height=spec.card_size.height,
                                                 radius=spec.card_size.radius)
            if spec.paper_size.name:
                if spec.paper_size.name not in self.config.paper_sizes:
                    raise HelperError(f'Paper size "{spec.paper_size.name}" not found in paper_sizes.')
                paper_def = self.config.paper_sizes[spec.paper_size.name]
            else:
                paper_def = utilities.PaperSizeDef(width=spec.paper_size.width, height=spec.paper_size.height)
        except Exception as exc:
            record.update({'error': describe_exception(exc), 'template': template, 'version': spec.version})
            return record

        orientation = spec.orientation
        layout_reg = spec.registration or utilities.RegistrationSettings()
        return self._record(
            record,
            version=spec.version,
            template=template,
            card_def=card_def,
            paper_def=paper_def,
            orientation=orientation,
            registration_orientation=spec.registration_orientation or orientation,
            effective_inset=layout_reg.inset or self.default_reg.inset,
            effective_thickness=layout_reg.thickness or self.default_reg.thickness,
            effective_length=layout_reg.length or self.default_reg.length,
            declared_rows=spec.num_rows,
            declared_cols=spec.num_cols,
        )

    def describe(self) -> dict:
        combos = []
        for paper, cards in self.config.layouts.items():
            for card, variants in cards.items():
                for variant_name, layout_def in variants.items():
                    combos.append(self.combo(paper, card, variant_name, layout_def))
        specialty = [self.specialty(name, spec) for name, spec in (self.config.specialty_layouts or {}).items()]
        return {
            'ppi': self.ppi,
            'cardRadius': self.config.defaults.card_radius,
            'registrationDefaults': {
                'default': self.default_reg.model_dump(),
                'borderless': self.borderless_reg.model_dump(),
            },
            'regPaddingMm': self.page_manager.REG_PADDING_MM,
            'cardSizes': self.card_sizes(),
            'paperSizes': self.paper_sizes(),
            'aliases': {'card': self.card_aliases(), 'paper': self.paper_aliases()},
            'combos': combos,
            'specialty': specialty,
        }


def cmd_introspect(args) -> dict:
    root = engine_root_from(args)
    engine_root = os.path.abspath(args.engine_root or root)
    utilities = import_engine(root)

    result = {
        'helperVersion': HELPER_VERSION,
        'root': root,
        'engineRoot': engine_root,
        'engineVersion': None,
        'python': {'version': platform.python_version(), 'executable': sys.executable},
        'commands': {},
        'plugins': [],
        'layouts': None,
    }

    for script, attribute in (('create_pdf', 'cli'), ('offset_pdf', 'offset_pdf')):
        entry = {'params': [], 'error': None}
        try:
            with contextlib.redirect_stdout(sys.stderr):
                module = importlib.import_module(script)
            command = find_click_command(module, attribute)
            entry['params'] = [param_spec(p) for p in command.params]
            if script == 'create_pdf':
                result['engineVersion'] = command_version(command)
        except Exception as exc:
            entry['error'] = describe_exception(exc)
            log(f'Could not inspect {script}.py: {entry["error"]}')
        result['commands'][script] = entry
    if result['engineVersion'] is None:
        result['engineVersion'] = pyproject_version(root)

    plugins_dir = os.path.join(root, 'plugins')
    names = sorted(os.listdir(plugins_dir)) if os.path.isdir(plugins_dir) else []
    for name in names:
        if not os.path.isfile(os.path.join(plugins_dir, name, 'fetch.py')):
            continue
        entry = {'id': name, 'file': f'plugins/{name}/fetch.py', 'params': [], 'error': None}
        try:
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
                raise HelperError(f'"{name}" is not a valid plugin folder name')
            with contextlib.redirect_stdout(sys.stderr):
                module = importlib.import_module(f'plugins.{name}.fetch')
            command = find_click_command(module, 'cli')
            entry['params'] = [param_spec(p) for p in command.params]
        except BaseException as exc:  # a broken plugin must not hide the others
            if isinstance(exc, KeyboardInterrupt):
                raise
            entry['error'] = describe_exception(exc)
            log(f'Could not inspect plugin {name}: {entry["error"]}')
        result['plugins'].append(entry)

    result['layouts'] = LayoutDescriber(utilities, engine_root).describe()
    return result


# --------------------------------------------------------------------------------------
# env-check (must not import the engine)
# --------------------------------------------------------------------------------------

_REQ_NAME = re.compile(r'^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$')


def normalize_dist(name: str) -> str:
    return re.sub(r'[-_.]+', '-', name).lower()


def _marker_applies(marker: str) -> bool:
    marker = marker.strip()
    if not marker:
        return True
    try:
        from packaging.markers import Marker  # shipped with matplotlib's dependencies

        return bool(Marker(marker).evaluate())
    except Exception:
        return True


def parse_requirements(text: str) -> list:
    """Return [{dist, normalized, required}] for requirement lines that apply here."""
    requirements = []
    seen = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        line = re.split(r'\s+#', line, maxsplit=1)[0].strip()
        if not line or line.startswith('-'):
            continue  # options such as -r, -e, --index-url
        requirement, _, marker = line.partition(';')
        if not _marker_applies(marker):
            continue
        match = _REQ_NAME.match(requirement.strip())
        if not match:
            continue
        dist, _extras, specifier = match.groups()
        specifier = (specifier or '').strip()
        pinned = re.fullmatch(r'===?\s*([^\s,;]+)', specifier) if '@' not in specifier else None
        normalized = normalize_dist(dist)
        if normalized in seen:
            continue
        seen.add(normalized)
        requirements.append({'dist': dist, 'normalized': normalized,
                             'required': pinned.group(1) if pinned else None})
    return requirements


def _import_name_for(dist: str, normalized: str, metadata, cache: dict) -> str:
    """Best guess of the module to import for a distribution.

    Explicit map first, then a top-level module whose name matches the distribution,
    then the distribution's own top_level.txt order, then the normalized name.
    """
    if normalized in DIST_TO_IMPORT:
        return DIST_TO_IMPORT[normalized]
    expected = normalized.replace('-', '_')
    candidates = []
    try:
        top_level = metadata.distribution(dist).read_text('top_level.txt') or ''
        candidates = [n.strip() for n in top_level.splitlines() if n.strip() and not n.strip().startswith('_')]
    except Exception:
        candidates = []
    if not candidates:
        try:
            if 'reverse' not in cache:
                reverse = {}
                for module, dists in metadata.packages_distributions().items():
                    for d in dists:
                        reverse.setdefault(normalize_dist(d), []).append(module)
                cache['reverse'] = reverse
            candidates = [m for m in cache['reverse'].get(normalized, []) if not m.startswith('_')]
        except Exception:
            candidates = []
    for name in candidates:
        if name.lower() == expected:
            return name
    return candidates[0] if candidates else expected


def cmd_env_check(args) -> dict:
    import importlib.metadata as metadata

    requirements_text = ''
    if args.requirements:
        try:
            with open(args.requirements, 'r', encoding='utf-8-sig') as handle:
                requirements_text = handle.read()
        except OSError as exc:
            raise HelperError(f'Cannot read the requirements file {args.requirements}: {exc}') from exc
    requirements = parse_requirements(requirements_text)
    if not any(r['normalized'] == 'matplotlib' for r in requirements):
        requirements.append({'dist': 'matplotlib', 'normalized': 'matplotlib', 'required': None})

    modules, missing, mismatched, details = {}, [], [], []
    cache = {}
    for requirement in requirements:
        dist, normalized = requirement['dist'], requirement['normalized']
        import_name = _import_name_for(dist, normalized, metadata, cache)
        try:
            installed = metadata.version(dist)
        except Exception:
            installed = None
        error = None
        try:
            with contextlib.redirect_stdout(sys.stderr), warnings.catch_warnings():
                warnings.simplefilter('ignore')
                importlib.import_module(import_name)
        except BaseException as exc:
            if isinstance(exc, KeyboardInterrupt):
                raise
            error = describe_exception(exc)
        modules[import_name] = installed
        if error is not None:
            if import_name not in missing:
                missing.append(import_name)
        elif requirement['required'] and installed and installed != requirement['required']:
            mismatched.append({'dist': dist, 'importName': import_name,
                               'required': requirement['required'], 'installed': installed})
        details.append({'dist': dist, 'importName': import_name, 'required': requirement['required'],
                        'installed': installed, 'error': error})

    python_ok = sys.version_info >= (3, 10)
    return {
        'ok': python_ok and not missing,
        'python': platform.python_version(),
        'pythonOk': python_ok,
        'executable': sys.executable,
        'prefix': sys.prefix,
        'isVenv': sys.prefix != getattr(sys, 'base_prefix', sys.prefix),
        'modules': modules,
        'missing': missing,
        'mismatched': mismatched,
        'details': details,
    }


# --------------------------------------------------------------------------------------
# smoke-test
# --------------------------------------------------------------------------------------

def cmd_smoke_test(args) -> dict:
    started = time.perf_counter()
    root = engine_root_from(args)
    if not args.tmp:
        raise HelperError('smoke-test needs --tmp <folder>')
    tmp = os.path.abspath(args.tmp)
    front = os.path.join(tmp, 'front')
    back = os.path.join(tmp, 'back')
    double_sided = os.path.join(tmp, 'double_sided')
    for folder in (front, back, double_sided):
        os.makedirs(folder, exist_ok=True)
    output = os.path.join(tmp, 'smoke.pdf')
    with contextlib.suppress(FileNotFoundError):
        os.remove(output)

    utilities = import_engine(root)
    from PIL import Image

    Image.new('RGB', (63, 88), (40, 90, 160)).save(os.path.join(front, 'smoke.png'), format='PNG')

    with contextlib.redirect_stdout(sys.stderr):
        importlib.import_module('create_pdf')
        importlib.import_module('offset_pdf')
        utilities.generate_pdf(
            front_dir_path=front,
            back_dir_path=back,
            ds_dir_path=double_sided,
            output_path=output,
            output_images=False,
            card_size='standard',
            paper_size='letter',
            registration='3',
            only_fronts=True,
            fit='stretch',
            fit_backs=None,
            crop_string=None,
            crop_backs_string=None,
            extend_edges=None,
            extend_edges_backs=None,
            extend_corners=None,
            extend_corners_backs=None,
            extend_bleed=None,
            extend_bleed_backs=None,
            ppi=72,
            quality=100,
            skip_indices=[],
            load_offset=False,
            label=None,
            show_outline=False,
        )

    if not os.path.isfile(output) or os.path.getsize(output) == 0:
        raise HelperError('The test PDF was not created.')
    pages = None
    try:
        import pypdfium2 as pdfium

        document = pdfium.PdfDocument(output)
        try:
            pages = len(document)
        finally:
            document.close()
    except Exception as exc:
        raise HelperError(f'The test PDF could not be read back: {describe_exception(exc)}') from exc
    if pages != 1:
        raise HelperError(f'The test PDF has {pages} pages instead of 1.')
    return {
        'ok': True,
        'seconds': round(time.perf_counter() - started, 3),
        'pages': pages,
        'bytes': os.path.getsize(output),
        'pdf': output,
    }


# --------------------------------------------------------------------------------------
# Image helpers (prepare-upscale / validate-images)
# --------------------------------------------------------------------------------------

def _pil():
    from PIL import Image, ImageOps, ImageStat

    warnings.simplefilter('ignore', Image.DecompressionBombWarning)
    return Image, ImageOps, ImageStat


def sniff_type(path: str, pil_format=None):
    try:
        import filetype

        mime = filetype.guess_mime(path)
        if mime and mime.startswith('image/'):
            subtype = mime.split('/', 1)[1]
            return MIME_TO_SNIFFED.get(subtype, subtype)
    except Exception:
        pass
    if pil_format:
        return PIL_FORMAT_TO_SNIFFED.get(pil_format.upper(), pil_format.lower())
    return None


def gray_stats(image):
    """Mean and standard deviation of a <=256 px grayscale thumbnail."""
    Image, _ImageOps, ImageStat = _pil()
    thumb = image.copy()
    thumb.thumbnail((STATS_THUMB_SIZE, STATS_THUMB_SIZE), Image.Resampling.BILINEAR)
    if thumb.mode != 'L':
        thumb = thumb.convert('L')
    stat = ImageStat.Stat(thumb)
    return round(stat.mean[0], 3), round(stat.stddev[0], 3)


def load_list(path: str) -> list:
    if not path:
        raise HelperError('This command needs --list <file.json>')
    data = read_json(path)
    items = data.get('items') if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise HelperError('The list file must contain {"items": [...]}')
    return items


def cmd_prepare_upscale(args) -> dict:
    Image, ImageOps, _ImageStat = _pil()
    results = []
    for item in load_list(args.list):
        src = item.get('src') if isinstance(item, dict) else None
        dest = item.get('dest') if isinstance(item, dict) else None
        entry = {'src': src, 'dest': dest, 'ok': False, 'width': None, 'height': None,
                 'sniffed': None, 'mean': None, 'std': None, 'error': None}
        results.append(entry)
        if not src or not dest:
            entry['error'] = 'Missing src or dest'
            continue
        tmp = None
        try:
            entry['sniffed'] = sniff_type(src)
            with Image.open(src) as opened:
                if entry['sniffed'] is None:
                    entry['sniffed'] = sniff_type(src, opened.format)
                image = ImageOps.exif_transpose(opened)
                if image.mode != 'RGB':
                    image = image.convert('RGB')
                else:
                    image.load()
            entry['width'], entry['height'] = image.size
            entry['mean'], entry['std'] = gray_stats(image)
            os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
            tmp = f'{dest}.{os.getpid()}.tmp'
            image.save(tmp, format='PNG', compress_level=1)
            os.replace(tmp, dest)
            tmp = None
            entry['ok'] = True
        except Exception as exc:
            entry['error'] = describe_exception(exc)
            log(f'Could not prepare {src}: {entry["error"]}')
        finally:
            if tmp:
                with contextlib.suppress(OSError):
                    os.remove(tmp)
    return {'results': results}


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def cmd_validate_images(args) -> dict:
    Image, _ImageOps, _ImageStat = _pil()
    results = []
    for item in load_list(args.list):
        path = item.get('path') if isinstance(item, dict) else None
        entry = {'path': path, 'ok': False, 'width': None, 'height': None, 'mean': None, 'std': None, 'reason': None}
        results.append(entry)
        if not path:
            entry['reason'] = 'missing path'
            continue
        if not os.path.isfile(path):
            entry['reason'] = 'file not found'
            continue
        try:
            with Image.open(path) as opened:
                entry['width'], entry['height'] = opened.size
                if opened.format == 'JPEG':
                    opened.draft('RGB', (STATS_THUMB_SIZE, STATS_THUMB_SIZE))
                opened.load()
                entry['mean'], entry['std'] = gray_stats(opened)
        except Exception as exc:
            entry['reason'] = f'unreadable: {describe_exception(exc)}'
            continue

        expect_w = _number(item.get('expectWidth'))
        expect_h = _number(item.get('expectHeight'))
        ref_mean = _number(item.get('refMean'))
        ref_std = _number(item.get('refStd'))
        reasons = []
        if expect_w is not None and abs(entry['width'] - expect_w) > 2:
            reasons.append(f'width {entry["width"]} instead of {int(expect_w)}')
        if expect_h is not None and abs(entry['height'] - expect_h) > 2:
            reasons.append(f'height {entry["height"]} instead of {int(expect_h)}')
        if ref_std is not None and entry['std'] < 0.5 and ref_std >= 2:
            reasons.append('blank image')
        if ref_mean is not None and abs(entry['mean'] - ref_mean) > 40:
            reasons.append(f'brightness {entry["mean"]:.1f} instead of about {ref_mean:.1f}')
        entry['ok'] = not reasons
        entry['reason'] = '; '.join(reasons) if reasons else None
    return {'results': results}


# --------------------------------------------------------------------------------------
# list-images / merge-pdfs / pdf-info
# --------------------------------------------------------------------------------------

def cmd_list_images(args) -> dict:
    root = engine_root_from(args)
    if not args.dir:
        raise HelperError('list-images needs --dir <folder>')
    folder = args.dir if os.path.isabs(args.dir) else os.path.join(os.getcwd(), args.dir)
    if not os.path.isdir(folder):
        raise HelperError(f'Folder not found: {args.dir}')
    utilities = import_engine(root)
    files = [p.replace(os.sep, '/') for p in utilities.get_image_file_paths(folder)]
    files.sort()
    return {'dir': os.path.abspath(folder), 'count': len(files), 'files': files}


def cmd_merge_pdfs(args) -> dict:
    output = args.output or (args.out[1] if len(args.out) > 1 else None)
    if not output:
        raise HelperError('merge-pdfs needs --output <merged.pdf>')
    inputs = list(args.inputs or [])
    if not inputs:
        raise HelperError('merge-pdfs needs --inputs <a.pdf> [<b.pdf> ...]')
    for path in inputs:
        if not os.path.isfile(path):
            raise HelperError(f'PDF part not found: {path}')
    if not output.lower().endswith('.pdf'):
        raise HelperError(f'The merged file must end with .pdf: {output}')

    import pypdfium2 as pdfium

    started = time.perf_counter()
    merged = pdfium.PdfDocument.new()
    sources = []
    parts = []
    tmp = f'{output}.{os.getpid()}.merge-tmp'
    try:
        for path in inputs:
            source = pdfium.PdfDocument(path)
            sources.append(source)
            count = len(source)
            merged.import_pages(source)
            parts.append({'path': path, 'pages': count})
        pages = len(merged)
        os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
        merged.save(tmp)
        os.replace(tmp, output)
        tmp = None
    finally:
        with contextlib.suppress(Exception):
            merged.close()
        for source in sources:
            with contextlib.suppress(Exception):
                source.close()
        if tmp:
            with contextlib.suppress(OSError):
                os.remove(tmp)
    return {
        'ok': True,
        'pages': pages,
        'parts': parts,
        'output': os.path.abspath(output),
        'bytes': os.path.getsize(output),
        'seconds': round(time.perf_counter() - started, 3),
    }


def cmd_pdf_info(args) -> dict:
    if not args.pdf:
        raise HelperError('pdf-info needs --pdf <file.pdf>')
    if not os.path.isfile(args.pdf):
        raise HelperError(f'PDF not found: {args.pdf}')
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    document = pdfium.PdfDocument(args.pdf)
    try:
        pages = len(document)
        result = {'pages': pages, 'widthIn': None, 'heightIn': None, 'ppi': None, 'ppiExact': None,
                  'rotation': None, 'imageWidthPx': None, 'imageHeightPx': None, 'bytes': os.path.getsize(args.pdf)}
        if pages == 0:
            return result
        page = document[0]
        try:
            width_pt, height_pt = page.get_size()
            rotation = page.get_rotation() or 0
            width_in, height_in = width_pt / 72.0, height_pt / 72.0
            result.update({'widthIn': round(width_in, 4), 'heightIn': round(height_in, 4), 'rotation': rotation})
            for obj in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,)):
                try:
                    px_w, px_h = obj.get_px_size()
                except Exception:
                    continue
                if not px_w or not px_h:
                    continue
                result['imageWidthPx'], result['imageHeightPx'] = int(px_w), int(px_h)
                page_w_in = width_in
                # Pillow writes one upright full-page image; if the image is placed rotated
                # (its aspect matches the page turned 90 degrees) its width spans the page height.
                if height_in > 0 and width_in > 0:
                    image_aspect = px_w / px_h
                    if abs(image_aspect - height_in / width_in) < abs(image_aspect - width_in / height_in):
                        page_w_in = height_in
                if page_w_in > 0:
                    exact = px_w / page_w_in
                    result['ppiExact'] = round(exact, 3)
                    result['ppi'] = int(round(exact))
                break
        finally:
            page.close()
        return result
    finally:
        document.close()


# --------------------------------------------------------------------------------------
# make-test-cards
# --------------------------------------------------------------------------------------

def cmd_make_test_cards(args) -> dict:
    """Draw numbered, high-contrast test cards (and one "TEST BACK") at the given pixel size.

    Every card has a pastel background, a big number, "TEST CARD", an arrow pointing to the top,
    corner ticks on the card edge and a thin inner frame about 3 mm from the edge: after cutting,
    an even margin around that frame shows that the cut lines up with the print. The back has a
    centre cross and circle to compare front/back alignment when printing two-sided.
    Writes "Test card 01.png", ... into --dir and "Test back.png" into --back-dir (300 PPI metadata).
    """
    from PIL import Image, ImageDraw, ImageFont

    if not args.dir:
        raise HelperError('make-test-cards needs --dir <folder>')
    count = int(args.count)
    if not 1 <= count <= 100:
        raise HelperError('The number of test cards must be between 1 and 100')
    width, height = int(args.width_px), int(args.height_px)
    if not (32 <= width <= 6000 and 32 <= height <= 6000):
        raise HelperError('The test card size must be between 32 and 6000 pixels')
    root = os.path.abspath(args.root) if args.root else None
    label = (args.label or '').strip()[:60]
    palette = [(255, 205, 210), (255, 224, 178), (255, 249, 196), (200, 230, 201), (178, 235, 242),
               (187, 222, 251), (209, 196, 233), (248, 187, 208), (215, 204, 200)]
    fonts = {}

    def font_of(size):
        size = max(8, int(size))
        if size not in fonts:
            loaded = None
            for candidate in ([os.path.join(root, 'assets', 'arial.ttf')] if root else []) + ['arial.ttf', 'DejaVuSans.ttf']:
                try:
                    loaded = ImageFont.truetype(candidate, size)
                    break
                except (OSError, ValueError):
                    continue
            if loaded is None:
                try:
                    loaded = ImageFont.load_default(size=size)
                except TypeError:  # Pillow < 10.1
                    loaded = ImageFont.load_default()
            fonts[size] = loaded
        return fonts[size]

    def fitted(draw, text, max_w, max_h):
        size = max(8, int(max_h))
        while size > 8:
            left, top, right, bottom = draw.textbbox((0, 0), text, font=font_of(size))
            if right - left <= max_w and bottom - top <= max_h:
                break
            size = int(size * 0.9)
        return font_of(size)

    def centered(draw, box, text, max_h, fill):
        x0, y0, x1, y1 = box
        font = fitted(draw, text, (x1 - x0) * 0.92, max_h)
        left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
        draw.text((x0 + (x1 - x0 - (right - left)) / 2 - left, y0 + (y1 - y0 - (bottom - top)) / 2 - top), text, font=font, fill=fill)

    def card(number, back=False):
        short = min(width, height)
        inset = max(4, round(short * 0.047))  # about 3 mm on a 63 mm wide card
        line = max(2, round(short / 250))
        background = (38, 50, 56) if back else palette[(number - 1) % len(palette)]
        ink = (255, 255, 255) if back else (0, 0, 0)
        image = Image.new('RGB', (width, height), background)
        draw = ImageDraw.Draw(image)
        draw.rectangle([inset, inset, width - 1 - inset, height - 1 - inset], outline=ink, width=line)
        tick = max(6, round(short * 0.06))
        for x, y, dx, dy in ((0, 0, 1, 1), (width - 1, 0, -1, 1), (0, height - 1, 1, -1), (width - 1, height - 1, -1, -1)):
            draw.line([(x, y), (x + dx * tick, y)], fill=ink, width=line)
            draw.line([(x, y), (x, y + dy * tick)], fill=ink, width=line)
        x0, y0, x1, y1 = inset * 2, inset * 2, width - inset * 2, height - inset * 2
        iw, ih = x1 - x0, y1 - y0
        centered(draw, (x0, y0, x1, y0 + ih * 0.12), 'TEST BACK' if back else 'TEST CARD', ih * 0.08, ink)
        cx = width / 2
        if back:
            cy = height / 2
            arm, radius = short * 0.2, short * 0.1
            draw.line([(cx - arm, cy), (cx + arm, cy)], fill=ink, width=line * 2)
            draw.line([(cx, cy - arm), (cx, cy + arm)], fill=ink, width=line * 2)
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], outline=ink, width=line * 2)
        else:
            arrow_top, arrow_h = y0 + ih * 0.14, ih * 0.06
            draw.polygon([(cx, arrow_top), (cx - arrow_h * 0.8, arrow_top + arrow_h), (cx + arrow_h * 0.8, arrow_top + arrow_h)], fill=ink)
            centered(draw, (x0, y0 + ih * 0.22, x1, y1 - ih * 0.16), str(number), ih * 0.5, ink)
        if label:
            centered(draw, (x0, y1 - ih * 0.1, x1, y1), label, ih * 0.05, ink)
        return image

    def save(image, target):
        tmp = f'{target}.{os.getpid()}.tmp'
        try:
            image.save(tmp, format='PNG', dpi=(300, 300))
            os.replace(tmp, target)
        finally:
            with contextlib.suppress(OSError):
                if os.path.exists(tmp):
                    os.remove(tmp)

    front_dir = os.path.abspath(args.dir)
    os.makedirs(front_dir, exist_ok=True)
    digits = max(2, len(str(count)))
    files = []
    for number in range(1, count + 1):
        target = os.path.join(front_dir, f'Test card {number:0{digits}d}.png')
        save(card(number), target)
        files.append(target)
    back = None
    if args.back_dir:
        back_dir = os.path.abspath(args.back_dir)
        os.makedirs(back_dir, exist_ok=True)
        back = os.path.join(back_dir, 'Test back.png')
        save(card(0, back=True), back)
    log(f'Made {count} test card(s) of {width}x{height} px' + (' and a test back' if back else ''))
    return {'files': files, 'back': back, 'width': width, 'height': height, 'count': count}


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

class UsageError(Exception):
    """Bad command line (reported through --out like every other failure)."""


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # never print usage + exit 2; report through --out instead
        raise UsageError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog='scm_helper', allow_abbrev=False,
                     description='Kirigami desktop helper (writes JSON to --out).')
    commands = parser.add_subparsers(dest='command', parser_class=_Parser)
    commands.required = True

    def add(name, handler, help_text):
        sub = commands.add_parser(name, help=help_text, allow_abbrev=False)
        sub.add_argument('--root', default=None, help='Workspace root (the engine is imported from here).')
        sub.add_argument('--out', action='append', default=[], help='Result JSON file (first occurrence).')
        sub.set_defaults(handler=handler)
        return sub

    sub = add('introspect', cmd_introspect, 'Describe commands, plugins and layouts.')
    sub.add_argument('--engine-root', dest='engine_root', default=None,
                     help='Engine source folder (cutting templates are looked up here).')
    sub = add('env-check', cmd_env_check, 'Check which runtime packages are importable.')
    sub.add_argument('--requirements', default=None)
    sub = add('smoke-test', cmd_smoke_test, 'Render a tiny PDF to prove the engine works.')
    sub.add_argument('--tmp', default=None)
    sub = add('prepare-upscale', cmd_prepare_upscale, 'Normalize images to PNG before upscaling.')
    sub.add_argument('--list', default=None)
    sub = add('validate-images', cmd_validate_images, 'Sanity check upscaled images.')
    sub.add_argument('--list', default=None)
    sub = add('list-images', cmd_list_images, 'List the images the engine reads from a folder.')
    sub.add_argument('--dir', default=None)
    sub = add('merge-pdfs', cmd_merge_pdfs, 'Join PDFs without re-rendering.')
    sub.add_argument('--output', default=None, help='Merged PDF path (a second --out is accepted too).')
    sub.add_argument('--inputs', nargs='+', default=[])
    sub = add('pdf-info', cmd_pdf_info, 'Page count, size and resolution of a PDF.')
    sub.add_argument('--pdf', default=None)
    sub = add('make-test-cards', cmd_make_test_cards, 'Draw numbered test cards (and one test back) as PNG files.')
    sub.add_argument('--dir', default=None, help='Folder for the front images (created when missing).')
    sub.add_argument('--back-dir', dest='back_dir', default=None, help='Folder for the "TEST BACK" image (omit for none).')
    sub.add_argument('--count', type=int, default=9)
    sub.add_argument('--width-px', dest='width_px', type=int, default=744)
    sub.add_argument('--height-px', dest='height_px', type=int, default=1039)
    sub.add_argument('--label', default=None, help='Card size text printed on every card, e.g. "63 x 88 mm".')
    return parser


def _prescan_out(argv: list):
    for index, arg in enumerate(argv):
        if arg == '--out' and index + 1 < len(argv):
            return argv[index + 1]
        if arg.startswith('--out='):
            return arg[len('--out='):]
    return None


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    out_path = _prescan_out(argv)
    configure_stdio()
    try:
        args = build_parser().parse_args(argv)
        if args.out:
            out_path = args.out[0]
        if not out_path:
            raise HelperError('--out <result.json> is required')
        result = args.handler(args)
        write_json(out_path, result)
        return 0
    except BaseException as exc:  # report every failure (incl. SystemExit from engine code)
        details = traceback.format_exc()
        log(details.rstrip())
        if out_path:
            try:
                write_json(out_path, {
                    'error': describe_exception(exc),
                    'type': type(exc).__name__,
                    'message': str(exc),
                    'traceback': details,
                })
            except Exception as write_error:
                log(f'Could not write the result file {out_path}: {describe_exception(write_error)}')
        else:
            log('No --out file was given; the error above could not be reported as JSON.')
        return 1
    finally:
        with contextlib.suppress(Exception):
            sys.stderr.flush()


if __name__ == '__main__':
    sys.exit(main())
