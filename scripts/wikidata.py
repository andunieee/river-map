"""Link rivers in labels.geojson to Wikidata and English Wikipedia.

Usage: python3 -I scripts/wikidata.py public/data/labels.geojson data/wikidata-cache.json

Adds `wd` (Wikidata id) and `wiki` (English Wikipedia title) to each label
feature it can match. Rivers from the Europe and North America supplements
already carry a Wikidata id; the rest are found by name on Wikidata, then by
Wikipedia search for the leftovers (Natural Earth often uses transliterated
local names, like "Ertis" for the Irtysh). Either way a candidate only counts
if its coordinates fall near the river.

API responses are cached in the cache file, so reruns are fast and don't
hit the Wikidata service again.
"""

import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ENDPOINT = "https://query.wikidata.org/sparql"
WIKI_API = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "river-map/0.1 (https://github.com/andunieee/river-map)"
BATCH = 250  # VALUES entries per query

NAME_QUERY = """
SELECT ?n ?item ?coord ?title ?links WHERE {
  VALUES ?n { %s }
  ?item rdfs:label|skos:altLabel ?n .
  FILTER EXISTS { { ?item wdt:P31 wd:Q4022 } UNION { ?item wdt:P403 [] } }
  ?item wdt:P625 ?coord .
  OPTIONAL { ?item wikibase:sitelinks ?links }
  OPTIONAL {
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> ;
             schema:name ?title .
  }
}
"""

# Natural Earth names that neither lookup resolves correctly: bare
# transliterations ("Huang" finds a small Huang River, not the Yellow River)
# and Romanian/Russian names for delta channels and headwaters. Only applied
# to main-map rivers (scalerank <= 9).
OVERRIDES = {
    "Huang": "Yellow River",
    "Al Furat": "Euphrates",
    "Caquetá": "Japurá River",
    "Dnepre": "Dnieper",
    "Verkhniy Yenisey": "Yenisei",
    "Malyy Yenisey": "Little Yenisei",
    "Shishhid Gol": "Little Yenisei",
    "Bratul Chillia": "Chilia branch",
    "Bratul Sfintu Gheorghe": "Sfântu Gheorghe branch",
}

# Which of these items are watercourses (search can return provinces, towns...)
WATERCOURSE_QUERY = """
SELECT ?item WHERE {
  VALUES ?item { %s }
  FILTER EXISTS {
    { ?item wdt:P31 wd:Q4022 } UNION { ?item wdt:P403 [] }
    UNION { ?item wdt:P31/wdt:P279* wd:Q355304 }
  }
}
"""

ID_QUERY = """
SELECT ?item ?title WHERE {
  VALUES ?item { %s }
  ?article schema:about ?item ;
           schema:isPartOf <https://en.wikipedia.org/> ;
           schema:name ?title .
}
"""


def fetch_json(url, cache, accept="application/json"):
    key = hashlib.sha1(url.encode()).hexdigest()
    if key not in cache:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    cache[key] = json.load(resp)
                break
            except Exception as e:  # rate limits and timeouts: back off and retry
                if attempt == 3:
                    raise
                print(f"  retrying after error: {e}", file=sys.stderr)
                time.sleep(10 * (attempt + 1))
        time.sleep(0.5)  # be polite to the public endpoints
    return cache[key]


def sparql(query, cache):
    url = ENDPOINT + "?" + urllib.parse.urlencode({"query": query})
    return fetch_json(url, cache, "application/sparql-results+json")["results"]["bindings"]


def wiki_search(p, cache):
    """Search English Wikipedia for a river; return [(title, qid)] of hits
    located near it, best first."""
    params = {
        "action": "query", "format": "json", "formatversion": 2,
        "generator": "search", "gsrsearch": f"{p['name']} river", "gsrlimit": 5,
        "prop": "coordinates|pageprops", "ppprop": "wikibase_item",
        "coprimary": "all", "colimit": "max",
    }
    data = fetch_json(WIKI_API + "?" + urllib.parse.urlencode(params), cache)
    pages = sorted(data.get("query", {}).get("pages", []), key=lambda pg: pg["index"])
    hits = []
    for pg in pages:
        coords = [(c["lon"], c["lat"]) for c in pg.get("coordinates", [])]
        item = pg.get("pageprops", {}).get("wikibase_item")
        if item and any(near(p["bbox"], pt) for pt in coords):
            hits.append((pg["title"], item))
    return hits


def literal(s):
    return json.dumps(s, ensure_ascii=False) + "@en"


def qid(uri):
    return uri.rsplit("/", 1)[-1]


def parse_point(wkt):
    # "Point(lon lat)"
    lon, lat = wkt[wkt.index("(") + 1:wkt.index(")")].split()
    return float(lon), float(lat)


def with_river(names):
    out = set()
    for n in names:
        out.add(n)
        if "river" not in n.lower():
            out.add(n + " River")
    return out


def candidate_names(p):
    """Name tiers, best first: English and alternative names, then local."""
    tiers = [with_river({p["name"], *p.get("alt", [])})]
    if p.get("local"):
        tiers.append(with_river({p["local"]}) - tiers[0])
    return tiers


def near(bbox, point):
    """Whether a Wikidata coordinate is close to the river.

    The coordinate is often the source or mouth, which can lie well beyond
    the stretch Natural Earth draws, so the margin grows with river size.
    """
    w, s, e, n = bbox
    margin = 0.75 + 0.4 * max(e - w, n - s)
    x, y = point
    return w - margin <= x <= e + margin and s - margin <= y <= n + margin


def main():
    labels_path, cache_path = Path(sys.argv[1]), Path(sys.argv[2])
    labels = json.loads(labels_path.read_text())
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    feats = [f["properties"] for f in labels["features"]]

    for p in feats:
        if p["sr"] <= 9 and p["name"] in OVERRIDES:
            p["wiki"] = OVERRIDES[p["name"]]
            p.pop("wd", None)

    # 1. Find unlinked rivers by name.
    todo = [p for p in feats if not p.get("wd") and not p.get("wiki")]
    names = sorted({n for p in todo for tier in candidate_names(p) for n in tier})
    print(f"looking up {len(todo)} rivers by name ({len(names)} name variants)")
    by_name = {}
    for i in range(0, len(names), BATCH):
        chunk = names[i:i + BATCH]
        rows = sparql(NAME_QUERY % " ".join(literal(n) for n in chunk), cache)
        for r in rows:
            c = by_name.setdefault(r["n"]["value"], {}).setdefault(qid(r["item"]["value"]), {
                "coords": [], "links": int(r.get("links", {}).get("value", 0)),
                "title": r.get("title", {}).get("value"),
            })
            c["coords"].append(parse_point(r["coord"]["value"]))
        print(f"  {min(i + BATCH, len(names))}/{len(names)}")
        cache_path.write_text(json.dumps(cache))

    matched = 0
    for p in todo:
        best = None
        for tier in candidate_names(p):
            for n in tier:
                for item, c in by_name.get(n, {}).items():
                    if any(near(p["bbox"], pt) for pt in c["coords"]):
                        if best is None or c["links"] > best[1]["links"]:
                            best = (item, c)
            if best:
                break
        if best:
            p["wd"] = best[0]
            if best[1]["title"]:
                p["wiki"] = best[1]["title"]
            matched += 1
    print(f"matched {matched}/{len(todo)} by name")

    # 2. Wikipedia search for the rest of the main-map rivers (the tiny ones
    # from the regional supplements nearly all have Wikidata ids already).
    rest = [p for p in todo if not p.get("wiki") and p["sr"] <= 9]
    print(f"searching Wikipedia for {len(rest)} more")
    hits = []
    for i, p in enumerate(rest):
        hits.append(wiki_search(p, cache))
        if i % 50 == 49:
            cache_path.write_text(json.dumps(cache))
    items = sorted({item for h in hits for _, item in h})
    rivers = set()
    for i in range(0, len(items), BATCH):
        rows = sparql(WATERCOURSE_QUERY % " ".join(f"wd:{q}" for q in items[i:i + BATCH]), cache)
        rivers.update(qid(r["item"]["value"]) for r in rows)
    found = 0
    for p, h in zip(rest, hits):
        for title, item in h:
            if item in rivers:
                p["wiki"], p["wd"] = title, item
                found += 1
                break
    print(f"found {found}/{len(rest)} by search")

    # 3. Wikipedia titles for rivers that came with a Wikidata id.
    ids = sorted({p["wd"] for p in feats if p.get("wd") and not p.get("wiki")})
    titles = {}
    for i in range(0, len(ids), BATCH):
        rows = sparql(ID_QUERY % " ".join(f"wd:{q}" for q in ids[i:i + BATCH]), cache)
        for r in rows:
            titles[qid(r["item"]["value"])] = r["title"]["value"]
    cache_path.write_text(json.dumps(cache))
    for p in feats:
        if p.get("wd") and not p.get("wiki") and p["wd"] in titles:
            p["wiki"] = titles[p["wd"]]

    linked = sum(1 for p in feats if p.get("wiki"))
    print(f"{linked}/{len(feats)} rivers linked to Wikipedia")
    labels_path.write_text(json.dumps(labels, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
