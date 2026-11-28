"""Validate translated widgets without connecting to a vehicle."""
import copy,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'kit/tools'))
from localize import localize_spec,load_locale
APPS=['gif_home']
words=load_locale('zh-CN')
font=json.loads((ROOT/'kit/runtime/fonts/cjk.json').read_text(encoding='utf-8'))
glyphs=font['sizes'][0]['glyphs']
for char in set(''.join(words.values())):
 if '\u3000'<=char<='\u9fff':assert str(ord(char)) in glyphs,('missing glyph',char)
for app in APPS:
 original=json.loads((ROOT/'apps'/app/'app.json').read_text(encoding='utf-8'))
 before=copy.deepcopy(original)
 en=localize_spec(original,'en');zh=localize_spec(original,'zh-CN')
 assert original==before,'localization mutated its input'
 assert en['title']==original['title']
 assert en['startWidget']['name']==original['startWidget']['name']
 assert zh['startWidget']['name']==words[original['startWidget']['name']]
 assert zh.get('signals',{})==original.get('signals',{})
 for a,b in zip(original.get('settings',[]),zh.get('settings',[])):
  assert a.get('default')==b.get('default')
  assert [v[0] for v in a.get('options',[])]==[v[0] for v in b.get('options',[])]
 assert any('\u4e00'<=c<='\u9fff' for c in zh['title']),zh['title']
 print('PASS',app,'English preserved; Chinese entry/widget names; settings IDs/defaults; font coverage')
