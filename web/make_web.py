# Fabrique le site (dossier site/, publié par Netlify) à partir du fichier du jeu jeu/passerelle.html.
# Usage : python3 web/make_web.py            → met à jour site/
#         python3 web/make_web.py autre/     → construit ailleurs (tests)
import hashlib, os, shutil, sys
WEB = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(WEB)
SRC = os.environ.get('SRC') or os.path.join(ROOT, 'jeu', 'passerelle.html')
SITE = os.path.join(ROOT, 'site')
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else SITE
SB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js'
s = open(SRC, encoding='utf-8').read()
VERSION = hashlib.sha1(s.encode('utf-8')).hexdigest()[:10]  # nouveau cache hors ligne à chaque version du jeu
head = f'''<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Passerelle, jeu de stratégie à deux : traverse le plateau avant ton adversaire.">
<meta name="theme-color" content="#ec6440">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Passerelle">
'''
import re
i = s.index('<title>Passerelle</title>')
extra = ''.join(re.findall(r'<script>.*?</script>', s[:i]))  # version de test : ses réglages de départ
s = head + extra + s[i:].replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '', 1)
three = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'
if three not in s: three = '<script src="../vendor/three.min.js"></script>'
assert s.count(three) == 1
local = os.path.relpath(os.path.join(ROOT, 'vendor', 'three.min.js'), OUT).replace(os.sep, '/')
s = s.replace(three, f'''<script src="config.js"></script>
<script src="{SB}"></script>
<script src="supabase-adapter.js"></script>
{three if 'cdnjs' in three else f'<script src="{local}"></script>'}''', 1)
assert s.rstrip().endswith('</script>')
s = s.rstrip() + '''
<script>
// Appli installable : garde le jeu en cache pour qu'il s'ouvre même sans connexion.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
</script>
</body>
</html>
'''
s = s.replace('</style>', '</style>\n</head>\n<body>', 1) if '<body' not in s else s
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(s)
for f in ['supabase-adapter.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']:
    shutil.copy(os.path.join(WEB, f), OUT)
# Les musiques vivent dans site/musique ; on les recopie seulement pour un dossier construit ailleurs.
if OUT != SITE:
    os.makedirs(os.path.join(OUT, 'musique'), exist_ok=True)
    for f in sorted(os.listdir(os.path.join(SITE, 'musique'))):
        shutil.copy(os.path.join(SITE, 'musique', f), os.path.join(OUT, 'musique', f))
# config.js : jamais écrasé s'il existe déjà (il contient les clés du projet Supabase).
if not os.path.exists(os.path.join(OUT, 'config.js')): shutil.copy(os.path.join(SITE if os.path.exists(os.path.join(SITE, 'config.js')) else WEB, 'config.js'), OUT)
sw = open(os.path.join(WEB, 'sw.js'), encoding='utf-8').read().replace('__VERSION__', VERSION).replace('__SUPABASE_JS__', SB)
open(os.path.join(OUT, 'sw.js'), 'w', encoding='utf-8').write(sw)
print('ok', OUT)
