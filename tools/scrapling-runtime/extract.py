"""Bounded, network-free Scrapling bridge. Input is data, never Python code."""
import sys
import json
import re
from importlib.metadata import version
from urllib.parse import urljoin, urlsplit

LIMIT = 1048576

def public_link(base, value):
    if not isinstance(value, str) or len(value) > 1800:
        return None
    value = urljoin(base, value)
    parsed = urlsplit(value)
    return value if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password else None

def bounded(value, depth=0):
    if depth > 6:
        return None
    if isinstance(value, str):
        return value[:1000]
    if isinstance(value, dict):
        return {str(k)[:100]: bounded(v, depth + 1) for k, v in list(value.items())[:30] if k not in ("__proto__", "constructor", "prototype")}
    if isinstance(value, list):
        return [bounded(v, depth + 1) for v in value[:20]]
    return value if value is None or isinstance(value, (int, float, bool)) else None

def main():
    if sys.argv[1:] == ["--version"]:
        print(json.dumps({"package": "scrapling", "version": version("scrapling")}))
        return
    if sys.argv[1:]:
        raise ValueError()
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError()
    data = json.loads(raw)
    if set(data) != {"url", "html"} or not isinstance(data["html"], str):
        raise ValueError()
    from scrapling import Selector
    page = Selector(data["html"], url=data["url"], adaptive=False, huge_tree=False)
    texts = page.xpath("//body//text()[not(ancestor::script) and not(ancestor::style) and not(ancestor::noscript)]").getall()
    text = re.sub(r"\s+", " ", " ".join(str(v) for v in texts)).strip()
    links, images, contacts, dates, structured = [], [], [], [], []
    for node in page.css("a")[:120]:
        href = str(node.attrib.get("href", ""))
        if href.startswith(("tel:", "mailto:")):
            contacts.append(href[:300])
        target = public_link(data["url"], href)
        if target:
            links.append({"url": target, "text": re.sub(r"\s+", " ", " ".join(str(v) for v in node.xpath(".//text()").getall()))[:200]})
    for node in page.css("img")[:60]:
        attrs = dict(node.attrib)
        target = public_link(data["url"], attrs.get("src") or attrs.get("data-src", ""))
        if target:
            images.append({"url": target, "alt": attrs.get("alt", "")[:300], "width": attrs.get("width", "")[:10], "height": attrs.get("height", "")[:10]})
    for node in page.css("time[datetime]")[:30]:
        dates.append({"value": str(node.attrib.get("datetime", ""))[:100], "text": " ".join(str(v) for v in node.xpath(".//text()").getall())[:300]})
    for node in page.css('script[type="application/ld+json"]')[:10]:
        content = "".join(str(v) for v in node.xpath(".//text()").getall())
        if len(content) <= 30000:
            try:
                structured.append(bounded(json.loads(content)))
            except (ValueError, RecursionError):
                pass
    result = {"title": str(page.css("title::text").get("") or "")[:300], "text": text[:30000], "links": links, "images": images[:30], "contacts": contacts[:30], "dates": dates, "structured": structured, "truncated": len(text) > 30000}
    output = json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(output.encode()) > LIMIT:
        raise ValueError()
    print(output)

try:
    main()
except Exception:
    # No source text, arbitrary parser exception or credential-bearing path leaks.
    sys.stderr.write("SCRAPLING_EXTRACTION_FAILED\n")
    sys.exit(1)
