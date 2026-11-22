# Writes social/preview/grid-<id>.jpg: the large photo at 800 px with a 10% grid
# and labels, for choosing the sneak-peek crop [x, y, width] in data/social.json.
#   python scripts/social-grid.py pantheon alhambra ...
import os, sys
from PIL import Image, ImageDraw

os.makedirs('social/preview', exist_ok=True)
for i in sys.argv[1:]:
    im = Image.open(f'social/src/{i}.jpg').convert('RGB')
    print(i, im.size)
    im.thumbnail((800, 800))
    d = ImageDraw.Draw(im)
    w, h = im.size
    for k in range(1, 10):
        d.line([(w * k / 10, 0), (w * k / 10, h)], fill=(255, 0, 0))
        d.line([(0, h * k / 10), (w, h * k / 10)], fill=(255, 0, 0))
        d.text((w * k / 10 + 2, 2), str(k * 10), fill=(255, 255, 0))
        d.text((2, h * k / 10 + 2), str(k * 10), fill=(255, 255, 0))
    im.save(f'social/preview/grid-{i}.jpg')
