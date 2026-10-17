#!/usr/bin/env bash
# Hook SessionStart: deja listas las dependencias de Python y de web/ en sesiones en la nube.
# Fuera de la nube no hace nada. Nunca bloquea la sesión: siempre sale con código 0.

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
instalado=()

# web/: npm ci solo si falta node_modules o cambió el hash de package-lock.json
if [ -f "$RAIZ/web/package-lock.json" ]; then
  hash_actual="$(sha256sum "$RAIZ/web/package-lock.json" | cut -d' ' -f1)"
  hash_guardado="$(cat "$RAIZ/web/node_modules/.lock-hash" 2>/dev/null || true)"
  if [ ! -d "$RAIZ/web/node_modules" ] || [ "$hash_actual" != "$hash_guardado" ]; then
    if (cd "$RAIZ/web" && npm ci --no-audit --no-fund); then
      echo "$hash_actual" > "$RAIZ/web/node_modules/.lock-hash"
      instalado+=("web")
    else
      echo "instalar-dependencias: falló npm ci en web/ (la sesión continúa)"
    fi
  fi
fi

# Python: instalar requirements-sync.txt solo si pip informa paquetes por instalar
if [ -f "$RAIZ/requirements-sync.txt" ]; then
  simulacion="$(python3 -m pip install --dry-run -r "$RAIZ/requirements-sync.txt" 2>&1)"
  if [ $? -ne 0 ]; then
    echo "$simulacion"
    echo "instalar-dependencias: falló la comprobación de pip (la sesión continúa)"
  elif echo "$simulacion" | grep -q "Would install"; then
    if python3 -m pip install -r "$RAIZ/requirements-sync.txt"; then
      instalado+=("python")
    else
      echo "instalar-dependencias: falló pip install (la sesión continúa)"
    fi
  fi
fi

if [ ${#instalado[@]} -eq 0 ]; then
  echo "instalar-dependencias: todo al día, nada que instalar"
else
  echo "instalar-dependencias: instalado ${instalado[*]}"
fi
exit 0
