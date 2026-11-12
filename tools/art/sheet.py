import sys
from PIL import Image
# usage: sheet.py out.png cols bg files...
out, cols, bg, *files = sys.argv[1:]
cols = int(cols)
ims = [Image.open(f).convert('RGBA') for f in files]
cw = max(i.width for i in ims); ch = max(i.height for i in ims)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGBA', (cw * cols, ch * rows), bg)
for k, im in enumerate(ims):
    sheet.alpha_composite(im, ((k % cols) * cw, (k // cols) * ch))
sheet.convert('RGB').save(out)
