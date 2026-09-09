"""Read one user-submitted WeChat article. stdout is a bounded JSON result."""
import asyncio
import json
import re
import sys
from urllib.parse import urlparse

from bs4 import BeautifulSoup
from markdownify import markdownify
from playwright.async_api import async_playwright


def valid_url(value):
    url = urlparse(value)
    return (url.scheme == 'https' and url.hostname == 'mp.weixin.qq.com'
            and not url.username and not url.password and url.port in (None, 443))


def extract(html, url):
    if len(html) > 5_000_000:
        raise ValueError('SOURCE_TOO_LARGE')
    soup = BeautifulSoup(html, 'html.parser')
    body = soup.select_one('#js_content')
    title = soup.select_one('#activity-name')
    if body is None or title is None:
        raise ValueError('SOURCE_WEIXIN_BODY_UNAVAILABLE')
    for tag in body.select('script,style,noscript,iframe,svg,.qr_code_pc,.reward_area'):
        tag.decompose()
    for img in body.select('img'):
        src = img.get('data-src') or img.get('src') or ''
        if urlparse(src).scheme not in ('http', 'https'):
            img.decompose()
        else:
            img['src'] = src
    for anchor in body.select('a[href]'):
        if urlparse(anchor['href']).scheme not in ('http', 'https'):
            del anchor['href']
    text = body.get_text('\n', strip=True)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    md = markdownify(str(body), heading_style='ATX').strip()
    if len(text) < 20:
        raise ValueError('SOURCE_PARSE_EMPTY')
    if max(len(text), len(md)) > 200_000:
        raise ValueError('SOURCE_TOO_LARGE')
    publisher = soup.select_one('#js_name')
    return dict(url=url, title=title.get_text(' ', strip=True),
                publisher=publisher.get_text(' ', strip=True) if publisher else '',
                text=text, markdown=md)


async def read(url):
    if not valid_url(url) or not re.match(r'^/s(?:/|$)', urlparse(url).path):
        raise ValueError('SOURCE_URL_REJECTED')
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel='chrome', headless=True)
        try:
            context = await browser.new_context(service_workers='block', accept_downloads=False)
            # Only the article origin and required WeChat static resources are fetched.
            async def route(request):
                parsed = urlparse(request.request.url)
                if (parsed.scheme != 'https' or parsed.hostname not in
                        ('mp.weixin.qq.com', 'res.wx.qq.com') or
                        request.request.resource_type in ('image', 'media', 'font') or
                        (request.request.is_navigation_request() and not valid_url(request.request.url))):
                    await request.abort()
                else:
                    await request.continue_()
            await context.route('**/*', route)
            page = await context.new_page()
            response = await page.goto(url, wait_until='domcontentloaded', timeout=30000)
            if response is None or response.status >= 400:
                raise ValueError('SOURCE_FETCH_FAILED')
            if not valid_url(page.url):
                raise ValueError('SOURCE_REDIRECT_REJECTED')
            try:
                await page.wait_for_selector('#js_content', state='attached', timeout=10000)
            except Exception:
                raise ValueError('SOURCE_WEIXIN_BODY_UNAVAILABLE')
            return extract(await page.content(), url)
        finally:
            await browser.close()


if __name__ == '__main__':
    try:
        print(json.dumps(asyncio.run(asyncio.wait_for(read(sys.argv[1]), timeout=45)), ensure_ascii=False))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) else 'SOURCE_BROWSER_FAILED'
        print(json.dumps({'error': code}))
        sys.exit(1)
