from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from refresh import collect, validate_archive, validate_spec, ROOT

SPEC = {'openapi': '3.0.3', 'info': {'title': 'Test fixture', 'version': '1'}, 'paths': {'/items': {'get': {'responses': {'200': {'description': 'OK'}}}}}}
DIRECTORY = {'test.example': {'preferred': '1', 'versions': {'1': {'swaggerUrl': 'https://api.apis.guru/v2/test.json', 'updated': '2020-01-01T00:00:00Z'}}}}


class RefreshTests(unittest.TestCase):
    def test_failed_refresh_does_not_replace_existing_capture(self):
        with tempfile.TemporaryDirectory() as d, patch('refresh.WATCH', [('test.example', 'Test', 'Fixture')]):
            root = Path(d)
            def fetch(url): return DIRECTORY if url.endswith('list.json') else SPEC
            collect(root, fetch=fetch, clock=datetime(2026, 1, 1, tzinfo=timezone.utc), pause=lambda _: None)
            before = (root / 'web/data/manifest.json').read_bytes()
            def broken(url): return DIRECTORY if url.endswith('list.json') else {'error': 'provider down'}
            with self.assertRaises(ValueError):
                collect(root, fetch=broken, clock=datetime(2026, 1, 2, tzinfo=timezone.utc), pause=lambda _: None)
            self.assertEqual((root / 'web/data/manifest.json').read_bytes(), before)
            self.assertEqual(validate_archive(root), 1)

    def test_unchanged_specs_are_deduplicated_but_capture_dates_retained(self):
        with tempfile.TemporaryDirectory() as d, patch('refresh.WATCH', [('test.example', 'Test', 'Fixture')]):
            root = Path(d)
            for day in [1, 2]:
                collect(root, fetch=lambda url: DIRECTORY if url.endswith('list.json') else SPEC, clock=datetime(2026, 1, day, tzinfo=timezone.utc), pause=lambda _: None)
            self.assertEqual(len(list((root / 'web/data/specs').glob('*.json'))), 1)
            self.assertEqual(len(list((root / 'web/data/captures').glob('*.json'))), 2)
            self.assertEqual(validate_archive(root), 1)
            next((root / 'web/data/specs').glob('*.json')).write_text('{}')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'): validate_archive(root)

    def test_malformed_or_empty_specs_are_rejected(self):
        for bad in [{}, {'openapi': '3.0.3', 'info': {}, 'paths': {}}]:
            with self.assertRaises(ValueError): validate_spec(bad)

    def test_checked_in_archive_is_complete_and_hashes_match(self):
        self.assertGreaterEqual(validate_archive(ROOT), 7)


if __name__ == '__main__': unittest.main()
