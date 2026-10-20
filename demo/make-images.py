# Builds the raster assets for both demo sites.
import random, sys
from PIL import Image, ImageDraw, ImageFilter
random.seed(7)
bad, fixed = sys.argv[1], sys.argv[2]

# small dashboard mockup, later stretched across the hero
im = Image.new('RGB', (480, 270), (30, 27, 60))
d = ImageDraw.Draw(im)
d.rectangle([0, 0, 480, 26], fill=(55, 48, 110))
for i in range(3): d.ellipse([10 + i * 14, 9, 18 + i * 14, 17], fill=(200, 180, 255))
d.rectangle([14, 40, 120, 256], fill=(45, 40, 92))
for i in range(6): d.rectangle([24, 54 + i * 30, 104, 64 + i * 30], fill=(120, 100, 220))
for i in range(12):
    h = random.randint(30, 150)
    d.rectangle([140 + i * 26, 240 - h, 158 + i * 26, 240], fill=(160 + i * 6, 90, 240))
d.text((140, 40), 'AI Insights Dashboard', fill=(255, 255, 255))
im.save(f'{bad}/hero.png')

# 4000 x 3000 "team photo" PNG shown in a 300 px card
W, H = 4000, 3000
g = Image.linear_gradient('L').resize((W, H))
im = Image.merge('RGB', (g, g.rotate(90).resize((W, H)), Image.new('L', (W, H), 200)))
d = ImageDraw.Draw(im)
for _ in range(40):
    x, y, r = random.randint(0, W), random.randint(0, H), random.randint(100, 600)
    d.ellipse([x - r, y - r, x + r, y + r], fill=(random.randint(80, 255), random.randint(60, 200), random.randint(150, 255)))
im = im.filter(ImageFilter.GaussianBlur(30))
noise = Image.effect_noise((W, H), 18).convert('RGB')
im = Image.blend(im, noise, 0.08)
im.save(f'{bad}/team.png')

# 4096 x 4096 texture for the 3D cubes
W = 4096
noise = Image.effect_noise((W, W), 40).convert('RGB')
grad = Image.linear_gradient('L').resize((W, W))
tex = Image.merge('RGB', (grad, Image.new('L', (W, W), 90), grad.rotate(90)))
Image.blend(tex, noise, 0.25).save(f'{bad}/texture.png')

# the fixed site: the same photo, cropped and sized for its slot, in modern formats
src = im.crop((600, 300, 3600, 2550))
for w in (480, 960, 1440):
    r = src.resize((w, int(w * 2250 / 3000)), Image.LANCZOS)
    r.save(f'{fixed}/team-{w}.avif', quality=55)
    r.save(f'{fixed}/team-{w}.webp', quality=78)
