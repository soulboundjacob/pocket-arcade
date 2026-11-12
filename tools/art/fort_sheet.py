from PIL import Image
T='/Users/jacob/Documents/work/pocket-arcade/assets/toon/'
keys=['cannon_base','cannon_barrel','crown','shot_ball','shot_drill','moon','flag_blue','flag_pink']
bg=(122,160,205,255)
ims=[Image.open(T+k+'.png').convert('RGBA') for k in keys]
W=sum(i.width for i in ims)+10*(len(ims)+1)
sheet=Image.new('RGBA',(W,max(i.height for i in ims)+20),bg)
x=10
for i in ims:
    sheet.alpha_composite(i,(x,10)); x+=i.width+10
# 1x preview strip (what a phone sees at 1x logical)
sm=Image.new('RGBA',(W,50),bg); x=10
for i in ims:
    j=i.resize((i.width//3,i.height//3),Image.LANCZOS); sm.alpha_composite(j,(x,5)); x+=i.width+10
out=Image.new('RGBA',(W,sheet.height+50),bg); out.paste(sheet,(0,0)); out.paste(sm,(0,sheet.height))
out.convert('RGB').save('/Users/jacob/Documents/work/pocket-arcade/tools/art/review/fort_sheet.png')
