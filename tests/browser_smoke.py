"""CI-only browser integration checks against the real retained collection."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    manifest = json.loads((ROOT / 'dist/data/manifest.json').read_text())
    latest = json.loads((ROOT / 'dist' / manifest['latest']).read_text())
    apicurio = next(api for api in latest['apis'] if api['id'] == 'apicurio.local:registry')
    versions = sorted(version['version'] for version in apicurio['versions'])
    assert len(versions) >= 2, 'Retained Apicurio versions are required for this comparison check'
    before = latest['capturedAt'] + '|' + versions[0]
    after = latest['capturedAt'] + '|' + versions[-1]
    screenshots = ROOT / 'browser-checks'
    screenshots.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        shutil.copytree(ROOT / 'dist', Path(temporary) / 'example-tool')
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=temporary))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                page = browser.new_page(viewport={'width': 1280, 'height': 1000})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.route('**/assets/tool-metrics.js', lambda route: route.fulfill(status=200, body=''))
                page.goto(f'http://127.0.0.1:{server.server_port}/example-tool/')
                page.wait_for_function("document.querySelector('#export-json').disabled === false")
                assert page.locator('#api-count').inner_text() == str(len(latest['apis']))
                assert page.locator('.operation').count() > 0
                # Defaults compare retained captures once history exists. Select the
                # same-capture version comparison explicitly, independent of history.
                page.locator('#api').select_option('apicurio.local:registry')
                page.locator('#before').select_option(before)
                page.locator('#after').select_option(after)
                expect(page.locator('#comparison-note')).to_contain_text('directory-listed versions')
                page.locator('#status').select_option('added')
                assert page.locator('.operation').count() > 0
                assert page.locator('.operation .badge').first.text_content() == 'added'
                page.locator('#search').fill('no-such-path-fixture')
                assert 'No operations match' in page.locator('#operations').inner_text()
                page.locator('#api').select_option('canada-holidays.ca')
                page.locator('#before').select_option('')
                expect(page.locator('#comparison-title')).to_contain_text('Canada Holidays')
                assert page.locator('#count-added').inner_text() == '—'
                assert page.locator('#before').input_value() == ''
                local_before = {'openapi': '3.0.3', 'info': {'title': 'Local test fixture', 'version': '1'}, 'paths': {'/one': {'get': {'responses': {'200': {'description': 'OK'}}}}}}
                local_after = json.loads(json.dumps(local_before))
                local_after['paths']['/one']['get']['summary'] = '<img src=x onerror="alert(1)">'
                local_after['paths']['/one']['get']['deprecated'] = True
                local_after['paths']['/two'] = {'post': {'responses': {'201': {'description': 'Created'}}}}
                for selector, name, value in [('#local-before', 'before.json', local_before), ('#local-after', 'after.json', local_after)]:
                    page.locator(selector).set_input_files({'name': name, 'mimeType': 'application/json', 'buffer': json.dumps(value).encode()})
                page.locator('#local-form button').click()
                page.wait_for_function("document.querySelector('#use-collection').hidden === false")
                assert page.locator('#count-added').inner_text() == '1'
                assert page.locator('#count-changed').inner_text() == '1'
                assert page.locator('#count-deprecated').inner_text() == '1'
                assert page.locator('img').count() == 0
                assert '<img' in page.locator('#operations').inner_text()
                with page.expect_download() as download:
                    page.locator('#export-json').click()
                assert download.value.suggested_filename == 'api-archaeology-evidence.json'
                page.locator('#use-collection').click()
                page.locator('#api').select_option('apicurio.local:registry')
                page.locator('#before').select_option(before)
                page.locator('#after').select_option(after)
                expect(page.locator('#comparison-note')).to_contain_text('directory-listed versions')
                page.evaluate('window.scrollTo(0, 0)')
                page.screenshot(path=str(screenshots / 'desktop.png'), full_page=True)
                page.set_viewport_size({'width': 390, 'height': 844})
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                page.screenshot(path=str(screenshots / 'mobile.png'), full_page=True)
                assert not errors, errors
                browser.close()
            print('Browser checks passed: real collection, filters, local import, safe text, export and mobile layout')
        finally:
            server.shutdown()


if __name__ == '__main__':
    main()
