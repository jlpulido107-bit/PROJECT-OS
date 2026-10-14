"""Comprueba destinos de enlaces Markdown relativos, sin validar anclas ni usar red."""
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
# Primero reconoce código inline para no interpretar sus ejemplos como enlaces.
TOKENS = re.compile(
    r"(?P<code>`+)(?:(?!(?P=code)).)*?(?P=code)"
    r'|(?<!!)\[[^\]\n]*\]\(\s*(?:<(?P<angle>[^>\n]+)>|'
    r'(?P<path>[^\s)]+))(?:\s+"[^"\n]*")?\s*\)'
)


def broken_links(document):
    """Devuelve (línea, destino) para archivos inexistentes respecto al documento."""
    broken = []
    fence = None
    for number, line in enumerate(document.read_text(encoding="utf-8").splitlines(), 1):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if fence is not None:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                fence = None
            continue
        if marker:
            fence = marker[1]
            continue
        for match in TOKENS.finditer(line):
            if match.group("code"):
                continue
            destination = match.group("angle") or match.group("path")
            url = urlsplit(destination)
            # También excluye mailto:, URLs //host y anclas del propio documento.
            if url.scheme or url.netloc or not url.path or url.path.startswith("/"):
                continue
            target = document.parent / unquote(url.path)
            if not target.is_file():
                broken.append((number, destination))
    return broken


class TestDocsLinks(unittest.TestCase):
    def test_docs_links(self):
        documents = sorted((ROOT / "docs").rglob("*.md"))
        self.assertTrue(documents, "No se encontraron documentos en docs/")
        broken = [
            f"{doc.relative_to(ROOT).as_posix()}:{line}: {destination}"
            for doc in documents
            for line, destination in broken_links(doc)
        ]
        self.assertEqual(broken, [], "Enlaces relativos rotos:\n" + "\n".join(broken))

    def test_detects_missing_files_with_and_without_anchor(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = Path(directory) / "index.md"
            doc.write_text("[Uno](missing.md)\n[Dos](missing.md#seccion)\n", encoding="utf-8")
            self.assertEqual(broken_links(doc), [(1, "missing.md"), (2, "missing.md#seccion")])

    def test_resolves_relative_paths_and_ignores_anchor_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs").mkdir()
            (root / "archivo con espacio.md").touch()
            doc = root / "docs" / "index.md"
            doc.write_text(
                '[Archivo](../archivo%20con%20espacio.md#sin-validar)\n'
                '[Otro](<../archivo con espacio.md>)\n'
                '[Con título](../archivo%20con%20espacio.md "Descripción")\n',
                encoding="utf-8",
            )
            self.assertEqual(broken_links(doc), [])

    def test_ignores_external_links_and_code_examples(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = Path(directory) / "index.md"
            doc.write_text(
                '[HTTP](http://example.com/missing.md)\n'
                '[HTTPS](https://example.com/missing.md)\n'
                '[Local](#seccion)\n'
                '`[Ejemplo](missing.md)`\n'
                '```md\n[Ejemplo](missing.md)\n```\n'
                '~~~md\n[Ejemplo](missing.md)\n~~~\n',
                encoding="utf-8",
            )
            self.assertEqual(broken_links(doc), [])


if __name__ == "__main__":
    unittest.main()
