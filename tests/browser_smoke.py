"""CI-only browser integration checks against the real retained collection."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
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
                assert page.locator('#api-count').inner_text() == '6'
                assert page.locator('.operation').count() > 0
                assert 'directory-listed versions' in page.locator('#comparison-note').inner_text()
                page.locator('#status').select_option('added')
                assert page.locator('.operation').count() > 0
                assert page.locator('.operation .badge').first.text_content() == 'added'
                page.locator('#search').fill('no-such-path-fixture')
                assert 'No operations match' in page.locator('#operations').inner_text()
                page.locator('#api').select_option('canada-holidays.ca')
                page.wait_for_function("document.querySelector('#comparison-title').textContent.includes('Canada Holidays')")
                assert page.locator('#count-added').inner_text() == '—'
                assert page.locator('#before').input_value() == ''
                before = {'openapi': '3.0.3', 'info': {'title': 'Local test fixture', 'version': '1'}, 'paths': {'/one': {'get': {'responses': {'200': {'description': 'OK'}}}}}}
                after = json.loads(json.dumps(before))
                after['paths']['/one']['get']['summary'] = '<img src=x onerror="alert(1)">'
                after['paths']['/one']['get']['deprecated'] = True
                after['paths']['/two'] = {'post': {'responses': {'201': {'description': 'Created'}}}}
                for selector, name, value in [('#local-before', 'before.json', before), ('#local-after', 'after.json', after)]:
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
                page.wait_for_function("document.querySelector('#comparison-note').textContent.includes('directory-listed versions')")
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
