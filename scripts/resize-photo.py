"""Resize one downloaded photo to 640 px wide JPEG. Prints WxH.

Usage: python -I scripts/resize-photo.py <input> <output.jpg>
"""
import sys

from PIL import Image, ImageOps

src, dst = sys.argv[1], sys.argv[2]
with Image.open(src) as im:
    im = ImageOps.exif_transpose(im).convert("RGB")
    if im.width > 640:
        im = im.resize((640, round(im.height * 640 / im.width)), Image.LANCZOS)
    im.save(dst, "JPEG", quality=78, optimize=True, progressive=True)
    print(f"{im.width}x{im.height}")
