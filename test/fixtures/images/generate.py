"""Regenerate the tiny image fixtures used by test/unit/image-meta.test.js and scan.test.js.

Usage (any cwd):
    <engine>/venv/Scripts/python.exe electron-app/test/fixtures/images/generate.py

Writes every fixture next to this script plus expected.json, which records for each file (and for
a set of crafted header byte strings) what the ENGINE's own libraries say:
  - mime / type / valid: filetype.guess_mime() (the engine's image filter, utilities.valid_mimetypes)
  - pillow: Image.open().size (raw) and ImageOps.exif_transpose().size (what create_pdf lays out)
so the JavaScript sniffer and size reader can be tested for exact parity. Every file is < 10 KB.
"""
import io
import json
import struct
import sys
import zlib
from pathlib import Path

import filetype
from PIL import Image, ImageOps, PngImagePlugin, features

HERE = Path(__file__).resolve().parent

MIME_TO_TYPE = {
    'image/png': 'png', 'image/apng': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/tiff': 'tiff', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/jpx': 'jpx', 'image/heic': 'heic',
}
# utilities.valid_mimetypes in the engine
ENGINE_VALID = {'image/jpeg', 'image/jpx', 'image/png', 'image/apng', 'image/gif', 'image/webp', 'image/tiff',
                'image/bmp', 'image/avif', 'image/qoi', 'image/dds'}


def gradient(mode: str, size: tuple[int, int]) -> Image.Image:
    w, h = size
    im = Image.new('RGB', size)
    im.putdata([((x * 255) // max(1, w - 1), (y * 255) // max(1, h - 1), 128) for y in range(h) for x in range(w)])
    if mode == 'RGB':
        return im
    if mode == 'RGBA':
        im = im.convert('RGBA')
        im.putalpha(Image.linear_gradient('L').resize(size))
        return im
    return im.convert(mode)


def exif_bytes(orientation: int) -> bytes:
    exif = Image.Exif()
    exif[0x0112] = orientation
    return exif.tobytes()


def raw_profile_value(orientation: int) -> str:
    data = b'Exif\x00\x00' + exif_bytes(orientation)
    hexdata = data.hex()
    lines = [hexdata[i:i + 72] for i in range(0, len(hexdata), 72)]
    return '\nexif\n' + f'{len(data):8d}\n' + '\n'.join(lines) + '\n'


def xmp_packet(orientation: int) -> str:
    return ('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" '
            f'tiff:Orientation="{orientation}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')


def bmp_core(width: int, height: int) -> bytes:
    """OS/2 1.x BMP (12-byte BITMAPCOREHEADER), 24 bpp, bottom-up."""
    row = (width * 3 + 3) & ~3
    pixels = b''.join(bytes(v for x in range(width) for v in ((x * 40) % 256, (y * 60) % 256, 200)).ljust(row, b'\0')
                      for y in range(height))
    offset = 14 + 12
    return (b'BM' + struct.pack('<IHHI', offset + len(pixels), 0, 0, offset)
            + struct.pack('<IHHHH', 12, width, height, 1, 24) + pixels)


def bmp_topdown(width: int, height: int) -> bytes:
    """Windows BMP (40-byte BITMAPINFOHEADER) with a NEGATIVE height (top-down rows)."""
    row = (width * 3 + 3) & ~3
    pixels = b''.join(bytes(v for x in range(width) for v in (10, (y * 70) % 256, (x * 50) % 256)).ljust(row, b'\0')
                      for y in range(height))
    offset = 14 + 40
    header = struct.pack('<IiiHHIIiiII', 40, width, -height, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    return b'BM' + struct.pack('<IHHI', offset + len(pixels), 0, 0, offset) + header + pixels


def tiff_big_endian(width: int, height: int) -> bytes:
    """Minimal uncompressed 8-bit grayscale TIFF, Motorola byte order; width SHORT, height LONG."""
    pixels = bytes((x * 30 + y * 20) % 256 for y in range(height) for x in range(width))
    entries = [
        (256, 3, 1, width),          # ImageWidth (SHORT)
        (257, 4, 1, height),         # ImageLength (LONG)
        (258, 3, 1, 8),              # BitsPerSample
        (259, 3, 1, 1),              # Compression = none
        (262, 3, 1, 1),              # Photometric = BlackIsZero
        (273, 4, 1, 0),              # StripOffsets (patched below)
        (277, 3, 1, 1),              # SamplesPerPixel
        (278, 4, 1, height),         # RowsPerStrip
        (279, 4, 1, len(pixels)),    # StripByteCounts
    ]
    ifd_offset = 8
    data_offset = ifd_offset + 2 + 12 * len(entries) + 4
    out = bytearray(b'MM\x00\x2a' + struct.pack('>I', ifd_offset) + struct.pack('>H', len(entries)))
    for tag, typ, count, value in entries:
        if tag == 273:
            value = data_offset
        if typ == 3:
            out += struct.pack('>HHIHH', tag, typ, count, value, 0)
        else:
            out += struct.pack('>HHII', tag, typ, count, value)
    out += struct.pack('>I', 0) + pixels
    return bytes(out)


def heic_header() -> bytes:
    ftyp = b'ftyp' + b'heic' + struct.pack('>I', 0) + b'mif1heic'
    box = struct.pack('>I', 8 + len(ftyp) - 4) + ftyp
    return box + b'\x00\x00\x00\x08free' + b'\x00' * 64


def ftyp(major: bytes, compat: list[bytes], pad: int = 32) -> bytes:
    body = b'ftyp' + major + struct.pack('>I', 0) + b''.join(compat)
    return struct.pack('>I', 4 + len(body)) + body + b'\x00' * pad


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


def main() -> int:
    files: dict[str, bytes | None] = {}

    def save(name: str, im: Image.Image, **params) -> None:
        buf = io.BytesIO()
        im.save(buf, **params)
        files[name] = buf.getvalue()

    save('png_rgb.png', gradient('RGB', (63, 88)), format='PNG', optimize=True)
    save('png_rgba.png', gradient('RGBA', (40, 30)), format='PNG')
    save('png_palette.png', gradient('RGB', (17, 9)).convert('P'), format='PNG')
    frames = [gradient('RGB', (20, 10)), gradient('RGB', (20, 10)).transpose(Image.Transpose.FLIP_LEFT_RIGHT)]
    save('apng_anim.png', frames[0], format='PNG', save_all=True, append_images=frames[1:], duration=100)
    save('png_exif_orient6.png', gradient('RGB', (30, 20)), format='PNG', exif=exif_bytes(6))
    info = PngImagePlugin.PngInfo()
    info.add_text('Raw profile type exif', raw_profile_value(8))
    save('png_rawprofile_text.png', gradient('RGB', (24, 16)), format='PNG', pnginfo=info)
    info = PngImagePlugin.PngInfo()
    info.add_text('Raw profile type exif', raw_profile_value(5), zip=True)
    save('png_rawprofile_ztxt.png', gradient('RGB', (26, 14)), format='PNG', pnginfo=info)
    info = PngImagePlugin.PngInfo()
    info.add_itxt('XML:com.adobe.xmp', xmp_packet(6))
    save('png_xmp_orient6.png', gradient('RGB', (22, 12)), format='PNG', pnginfo=info)
    files['png_truncated.png'] = files['png_rgb.png'][:20]

    save('jpeg_baseline.jpg', gradient('RGB', (63, 88)), format='JPEG', quality=80)
    save('jpeg_progressive.jpg', gradient('RGB', (50, 40)), format='JPEG', quality=80, progressive=True)
    save('jpeg_exif_orient6.jpg', gradient('RGB', (60, 40)), format='JPEG', quality=80, exif=exif_bytes(6))
    save('jpeg_exif_orient3.jpg', gradient('RGB', (60, 40)), format='JPEG', quality=80, exif=exif_bytes(3))
    try:
        save('jpeg_xmp_orient8.jpg', gradient('RGB', (30, 20)), format='JPEG', quality=80, xmp=xmp_packet(8).encode())
    except TypeError:
        print('note: this Pillow cannot write JPEG XMP; skipping jpeg_xmp_orient8.jpg')
    save('jpeg_bigcomment.jpg', gradient('RGB', (32, 24)), format='JPEG', quality=60, comment=b'x' * 9000)
    j = files['jpeg_exif_orient6.jpg']
    first_segment_end = 4 + struct.unpack('>H', j[4:6])[0]
    files['jpeg_junk_between_segments.jpg'] = j[:first_segment_end] + b'\x00\x11\x22' + j[first_segment_end:]
    save('jpeg_cmyk.jpg', gradient('RGB', (20, 30)).convert('CMYK'), format='JPEG', quality=80)
    save('jpeg_gray.jpg', gradient('L', (25, 15)), format='JPEG', quality=80)

    save('gif_static.gif', gradient('RGB', (30, 20)).convert('P'), format='GIF')
    gframes = [gradient('RGB', (16, 12)).convert('P'), gradient('RGB', (16, 12)).rotate(180).convert('P')]
    save('gif_anim.gif', gframes[0], format='GIF', save_all=True, append_images=gframes[1:], duration=100, loop=0)

    if features.check('webp'):
        save('webp_lossy.webp', gradient('RGB', (40, 30)), format='WEBP', quality=60)
        save('webp_lossless.webp', gradient('RGB', (41, 29)), format='WEBP', lossless=True)
        save('webp_alpha.webp', gradient('RGBA', (33, 22)), format='WEBP', quality=60)
        wframes = [gradient('RGB', (20, 16)), gradient('RGB', (20, 16)).rotate(180)]
        save('webp_anim.webp', wframes[0], format='WEBP', save_all=True, append_images=wframes[1:], duration=100)
        save('webp_exif_orient6.webp', gradient('RGB', (30, 20)), format='WEBP', quality=60, exif=exif_bytes(6))
        save('webp_xmp_orient8.webp', gradient('RGB', (28, 18)), format='WEBP', quality=60, xmp=xmp_packet(8).encode())

    save('bmp_24.bmp', gradient('RGB', (13, 7)), format='BMP')
    files['bmp_topdown.bmp'] = bmp_topdown(5, 3)
    files['bmp_core.bmp'] = bmp_core(6, 4)

    save('tiff_le.tif', gradient('RGB', (20, 10)), format='TIFF')
    save('tiff_orient6.tif', gradient('RGB', (20, 10)), format='TIFF', tiffinfo={274: 6})
    files['tiff_be.tif'] = tiff_big_endian(7, 5)

    if features.check('avif'):
        save('avif_plain.avif', gradient('RGB', (24, 16)), format='AVIF', quality=50)
        save('avif_orient6.avif', gradient('RGB', (24, 16)), format='AVIF', quality=50, exif=exif_bytes(6))
    if features.check('jpg_2000'):
        save('jp2_basic.jp2', gradient('RGB', (16, 12)), format='JPEG2000', no_jp2=False)
        save('j2k_codestream.j2k', gradient('RGB', (16, 12)), format='JPEG2000', no_jp2=True)

    files['text_as_png.png'] = b'This is a plain text file that only pretends to be a PNG image.\n'
    files['heic_header.heic'] = heic_header()
    files['empty.png'] = b''
    files['bm_text.txt'] = b'BMW cars are fast\n'

    entries = []
    for name, data in files.items():
        assert data is not None
        if len(data) >= 10 * 1024:
            raise SystemExit(f'{name} is {len(data)} bytes; fixtures must stay under 10 KB')
        path = HERE / name
        path.write_bytes(data)
        mime = filetype.guess_mime(str(path))
        pillow = {'ok': False}
        try:
            with Image.open(path) as im:
                raw = im.size
                oriented = ImageOps.exif_transpose(im).size
                pillow = {'ok': True, 'format': im.format, 'rawWidth': raw[0], 'rawHeight': raw[1],
                          'width': oriented[0], 'height': oriented[1]}
        except Exception as e:  # noqa: BLE001 -- record why Pillow refuses it
            pillow = {'ok': False, 'error': f'{type(e).__name__}: {e}'[:200]}
        entries.append({'file': name, 'bytes': len(data), 'mime': mime, 'type': MIME_TO_TYPE.get(mime),
                        'valid': mime in ENGINE_VALID, 'pillow': pillow})

    crafted = {
        'empty': b'',
        'jpeg_magic_only': b'\xff\xd8\xff',
        'jpeg_two_bytes': b'\xff\xd8',
        'png_magic_only': b'\x89PNG',
        'png_three_bytes': b'\x89PN',
        'gif_magic_only': b'GIF',
        'bmp_magic_only': b'BM',
        'bmp_text': b'BMW cars are fast',
        'webp_min': b'RIFF\x00\x00\x00\x00WEBPVP',
        'webp_too_short': b'RIFF\x00\x00\x00\x00WEBPV',
        'riff_wave': b'RIFF\x00\x00\x00\x00WAVEfmt ',
        'tiff_le_min': b'II*\x00\x08\x00\x00\x00\x00\x00',
        'tiff_too_short': b'II*\x00\x08\x00\x00\x00',
        'tiff_be_min': b'MM\x00*\x00\x00\x00\x08\x00\x00',
        'cr2_header': b'II*\x00\x10\x00\x00\x00CR\x02\x00' + b'\x00' * 20,
        'jxr_header': b'II\xbc\x01' + b'\x00' * 20,
        'psd_header': b'8BPS' + b'\x00' * 20,
        'ico_header': b'\x00\x00\x01\x00' + b'\x00' * 20,
        'dwg_header': b'AC1015' + b'\x00' * 20,
        'xcf_header': b'gimp xcf v011' + b'\x00' * 20,
        'jp2_signature': b'\x00\x00\x00\x0cjP  \r\n\x87\n' + b'\x00\x00\x00\x14ftypjp2 ' + b'\x00' * 40,
        'jp2_too_short': b'\x00\x00\x00\x0cjP  \r\n\x87\n' + b'\x00\x00\x00\x14ftypjp2 ',
        'jpx_brand': b'\x00\x00\x00\x0cjP  \r\n\x87\n' + b'\x00\x00\x00\x14ftypjpx ' + b'\x00' * 40,
        'j2k_codestream': b'\xff\x4f\xff\x51' + b'\x00' * 40,
        'avif_major': ftyp(b'avif', [b'mif1', b'miaf']),
        'avif_mif1_compat': ftyp(b'mif1', [b'avif', b'miaf']),
        'avif_msf1_compat': ftyp(b'msf1', [b'avif']),
        'avis_major': ftyp(b'avis', [b'avis', b'msf1', b'iso8', b'mif1', b'miaf']),
        'heic_major': ftyp(b'heic', [b'mif1', b'heic']),
        'heic_mif1_compat_first': ftyp(b'mif1', [b'heic', b'avif']),
        'heix_major': ftyp(b'heix', [b'mif1', b'heix']),
        'mif1_heix_avif': ftyp(b'mif1', [b'heix', b'avif']),
        'ftyp_size_exceeds_buffer': struct.pack('>I', 4096) + b'ftypavif' + b'\x00' * 20,
        'mp4_isom': ftyp(b'isom', [b'isom', b'mp41']),
        'dicom_with_avif_ftyp': ftyp(b'avif', [b'mif1'], pad=0).ljust(128, b'\x00') + b'DICM' + b'\x00' * 8,
        'pdf': b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n',
        'zip': b'PK\x03\x04' + b'\x00' * 26,
        'text': b'Lightning Bolt\n',
    }
    buffers = []
    for name, data in crafted.items():
        mime = filetype.guess_mime(data) if data else None
        buffers.append({'name': name, 'hex': data.hex(), 'mime': mime, 'type': MIME_TO_TYPE.get(mime),
                        'valid': mime in ENGINE_VALID})

    import PIL
    expected = {'generator': 'generate.py', 'filetype': filetype.__version__, 'pillow': PIL.__version__,
                'files': entries, 'buffers': buffers}
    (HERE / 'expected.json').write_text(json.dumps(expected, indent=1) + '\n', encoding='utf-8', newline='\n')
    for e in entries:
        p = e['pillow']
        dims = f"{p.get('rawWidth')}x{p.get('rawHeight')} -> {p.get('width')}x{p.get('height')}" if p['ok'] else p.get('error', '')[:60]
        print(f"{e['file']:28} {e['bytes']:6}B mime={str(e['mime']):12} valid={e['valid']!s:5} {dims}")
    print(f'wrote {len(entries)} files and {len(buffers)} crafted headers')
    return 0


if __name__ == '__main__':
    sys.exit(main())
