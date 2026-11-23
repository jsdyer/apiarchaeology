#!/usr/bin/env python3
"""Capture selected public OpenAPI definitions. Never calls described API operations."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit, quote

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = 'https://api.apis.guru/v2/list.json'
WATCH = [
    ('apicurio.local:registry', 'Apicurio Registry', 'Schema registry'),
    ('canada-holidays.ca', 'Canada Holidays', 'Canadian reference'),
    ('apis.guru', 'APIs.guru', 'API directory'),
    ('nasa.gov:apod', 'NASA APOD', 'Space & imagery'),
    ('nasa.gov:asteroids neows', 'NASA Asteroids', 'Space & observations'),
    ('wikimedia.org', 'Wikimedia', 'Open knowledge'),
]
MAX_BYTES = 10 * 1024 * 1024


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def validate_spec(spec):
    if not isinstance(spec, dict) or not (str(spec.get('openapi', '')).startswith('3.') or spec.get('swagger') == '2.0'):
        raise ValueError('Expected OpenAPI 3.x or Swagger 2.0 JSON')
    if not isinstance(spec.get('paths'), dict) or not spec['paths']:
        raise ValueError('Specification has no paths')
    if not isinstance(spec.get('info'), dict):
        raise ValueError('Specification has no info metadata')
    return spec


def get_json(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'api.apis.guru' or parsed.username:
        raise ValueError('Only APIs.guru public specification URLs may be collected')
    request_url = parsed._replace(path=quote(parsed.path, safe="/%:@")).geturl()
    request = urllib.request.Request(request_url, headers={
        'User-Agent': 'CoolCode-API-Archaeology/1.0 (+https://coolcode.ca/apiarchaeology/)',
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        if urlsplit(response.url).hostname != 'api.apis.guru':
            raise ValueError('Unexpected collection redirect')
        content = response.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ValueError('Specification exceeds collection size limit')
    return json.loads(content)


def collect(root=ROOT, fetch=get_json, clock=None, pause=time.sleep):
    """Validate every response before replacing the published manifest."""
    directory = fetch(DIRECTORY)
    if not isinstance(directory, dict):
        raise ValueError('Invalid API directory')
    timestamp = (clock or datetime.now(timezone.utc)).isoformat(timespec='seconds').replace('+00:00', 'Z')
    records, bodies = [], {}
    for identifier, title, category in WATCH:
        entry = directory.get(identifier)
        if not isinstance(entry, dict) or not isinstance(entry.get('versions'), dict) or not entry['versions']:
            raise ValueError(f'Watchlist entry missing: {identifier}')
        versions = []
        # All versions listed for this watched API; do not infer their release order.
        for version, source in sorted(entry['versions'].items()):
            url = source.get('swaggerUrl', '')
            spec = validate_spec(fetch(url))
            payload = encode(spec)
            digest = hashlib.sha256(payload).hexdigest()
            bodies[digest] = payload
            versions.append({
                'version': version, 'file': f'data/specs/{digest}.json', 'sha256': digest,
                'source': url, 'directoryUpdated': source.get('updated'),
                'directoryAdded': source.get('added'), 'format': spec.get('openapi', spec.get('swagger')),
                'originals': spec.get('info', {}).get('x-origin', []),
                'license': spec.get('info', {}).get('license', {}),
            })
            pause(0.3)
        records.append({'id': identifier, 'title': title, 'category': category,
                        'preferred': entry.get('preferred'), 'versions': versions})
    capture = {'schemaVersion': 1, 'capturedAt': timestamp, 'directory': DIRECTORY, 'apis': records}
    capture_id = timestamp.replace(':', '').replace('-', '')
    data = root / 'web' / 'data'
    manifest_path = data / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'schemaVersion': 1, 'captures': []}
    if any(c['capturedAt'] == timestamp for c in manifest['captures']):
        raise ValueError('A capture already exists with this timestamp')
    record = {'capturedAt': timestamp, 'file': f'data/captures/{capture_id}.json', 'apiCount': len(records),
              'versionCount': sum(len(a['versions']) for a in records)}
    manifest['captures'] = sorted([record] + manifest['captures'], key=lambda r: r['capturedAt'], reverse=True)
    manifest['latest'] = record['file']
    # All requests and validation have succeeded. Individual files are immutable.
    (data / 'specs').mkdir(parents=True, exist_ok=True)
    (data / 'captures').mkdir(exist_ok=True)
    for digest, payload in bodies.items():
        target = data / 'specs' / f'{digest}.json'
        if target.exists() and target.read_bytes() != payload:
            raise ValueError('Existing content-addressed specification is inconsistent')
        if not target.exists():
            target.write_bytes(payload)
    (data / 'captures' / f'{capture_id}.json').write_bytes(encode(capture))
    with tempfile.NamedTemporaryFile(dir=data, delete=False) as temporary:
        temporary.write(encode(manifest))
        pending = Path(temporary.name)
    pending.replace(manifest_path)
    print(f'Captured {len(records)} APIs / {record["versionCount"]} definitions at {timestamp}')
    return capture


def validate_archive(root=ROOT):
    data = root / 'web' / 'data'
    manifest = json.loads((data / 'manifest.json').read_text())
    if not manifest.get('captures') or manifest.get('latest') != manifest['captures'][0]['file']:
        raise ValueError('Missing or inconsistent capture index')
    seen = set()
    for entry in manifest['captures']:
        path = entry.get('file', '')
        if not re.fullmatch(r'data/captures/[0-9TZ]+\.json', path):
            raise ValueError('Invalid capture path')
        capture = json.loads((root / 'web' / path).read_text())
        if capture.get('capturedAt') != entry['capturedAt'] or not capture.get('apis'):
            raise ValueError('Capture metadata mismatch')
        for api in capture['apis']:
            for version in api['versions']:
                digest = version['sha256']
                if not re.fullmatch(r'[a-f0-9]{64}', digest) or version['file'] != f'data/specs/{digest}.json':
                    raise ValueError('Invalid content address')
                if digest not in seen:
                    payload = (data / 'specs' / f'{digest}.json').read_bytes()
                    if hashlib.sha256(payload).hexdigest() != digest:
                        raise ValueError('Specification hash mismatch')
                    validate_spec(json.loads(payload))
                    seen.add(digest)
    return len(seen)


if __name__ == '__main__':
    collect()
