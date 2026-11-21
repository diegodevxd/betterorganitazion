#!/usr/bin/env python3
"""Genera vendor/fonts/material-symbols-outlined-subset.woff2 con SOLO los
íconos que usa la app (≈7 KB en lugar de ≈4 MB), para que funcione sin internet.

Ejecútalo cada vez que agregues un ícono nuevo en index.html o app.js:
    pip install fonttools brotli
    python3 scripts/build-icons.py
y sube CACHE_VERSION en sw.js.
"""
import os
import re
import subprocess
import sys
import tarfile
import tempfile

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE = 'material-symbols@0.48.3'
OUT = os.path.join(ROOT, 'vendor', 'fonts', 'material-symbols-outlined-subset.woff2')

# Íconos que se asignan desde JS con textContent (no aparecen en el HTML).
EXTRA = 'cloud_off cloud_upload cloud_done sync text_increase text_decrease text_fields wifi_off schedule check error'.split()


def iconos_usados():
    nombres = set(EXTRA)
    for archivo in ('index.html', 'app.js'):
        with open(os.path.join(ROOT, archivo), encoding='utf-8') as f:
            texto = f.read()
        for m in re.finditer(r'material-symbols-outlined[^>]*>\s*([a-z_0-9]+)\s*<', texto):
            nombres.add(m.group(1))
    return sorted(nombres)


def fuente_original(tmp):
    subprocess.run(['npm', 'pack', PACKAGE, '--silent'], cwd=tmp, check=True, stdout=subprocess.DEVNULL)
    tgz = next(f for f in os.listdir(tmp) if f.endswith('.tgz'))
    with tarfile.open(os.path.join(tmp, tgz)) as t:
        miembro = t.getmember('package/material-symbols-outlined.woff2')
        t.extract(miembro, tmp, filter='data')
    return os.path.join(tmp, 'package', 'material-symbols-outlined.woff2')


def main():
    iconos = iconos_usados()
    with tempfile.TemporaryDirectory() as tmp:
        font = TTFont(fuente_original(tmp))
        # Fija los ejes variables en los valores por defecto (peso 400, sin relleno).
        font = instancer.instantiateVariableFont(font, {a.axisTag: a.defaultValue for a in font['fvar'].axes})

        cmap = font.getBestCmap()
        glyph_a_char = {g: chr(c) for c, g in cmap.items()}
        ligaduras = {}
        for lookup in font['GSUB'].table.LookupList.Lookup:
            for st in lookup.SubTable:
                if lookup.LookupType == 7:
                    st = st.ExtSubTable
                for first, ligs in getattr(st, 'ligatures', {}).items():
                    for lig in ligs:
                        nombre = ''.join(glyph_a_char.get(g, '?') for g in [first] + lig.Component)
                        ligaduras.setdefault(nombre, lig.LigGlyph)

        faltan = [i for i in iconos if i not in ligaduras]
        if faltan:
            print('Íconos que no existen en Material Symbols:', ', '.join(faltan), file=sys.stderr)
            sys.exit(1)

        glifos = {ligaduras[i] for i in iconos} | {cmap[ord(c)] for c in set(''.join(iconos)) if ord(c) in cmap}
        opciones = subset.Options()
        opciones.layout_closure = False  # conserva solo las ligaduras de los íconos elegidos
        opciones.layout_features = ['*']
        opciones.flavor = 'woff2'
        sub = subset.Subsetter(opciones)
        sub.populate(glyphs=sorted(glifos))
        sub.subset(font)
        font.flavor = 'woff2'
        font.save(OUT)
    print(f'{len(iconos)} íconos -> {OUT} ({os.path.getsize(OUT)} bytes)')


if __name__ == '__main__':
    main()
