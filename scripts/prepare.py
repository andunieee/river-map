"""Build the map's GeoJSON files from Natural Earth downloads.

Usage: python3 -I scripts/prepare.py data/raw public/data

Outputs:
  rivers.geojson  one feature per river segment, with
                  name, local, rid (river id), mz (min zoom), w (width), lake
  land50.geojson  coarse land polygons for the world view
  land.geojson    detailed land polygons (10m, rounded to ~1 km)
  lakes.geojson   lake polygons with mz
  labels.geojson  one point per river: low-zoom labels, search index and
                  river info (bbox, alternative names, Wikidata id)

Run scripts/wikidata.py afterwards to link rivers to Wikipedia.
"""

import json
import math
import sys
from collections import Counter
from pathlib import Path

RIVER_FILES = [
    "ne_10m_rivers_lake_centerlines",
    "ne_10m_rivers_europe",
    "ne_10m_rivers_north_america",
]

# Width multiplier by Natural Earth scalerank (0 = biggest, 12 = smallest).
WIDTH = {0: 3.0, 1: 3.0, 2: 2.6, 3: 2.2, 4: 1.9, 5: 1.6, 6: 1.3,
         7: 1.1, 8: 0.9, 9: 0.8, 10: 0.7, 11: 0.6, 12: 0.5}


def round_coords(coords, nd):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], nd), round(coords[1], nd)]
    out = [round_coords(c, nd) for c in coords]
    # Drop consecutive duplicate points created by rounding.
    if out and isinstance(out[0][0], (int, float)):
        dedup = [out[0]]
        for p in out[1:]:
            if p != dedup[-1]:
                dedup.append(p)
        out = dedup
    return out


def lines_of(geom):
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    return geom["coordinates"]


def min_zoom(props):
    # Natural Earth's min_zoom starts at 2 for the largest rivers; shift it
    # so the giants are visible on the whole-world view.
    return max(0, int(round(float(props.get("min_zoom") or 7) - 2)))


class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        self.parent[self.find(a)] = self.find(b)


def build_rivers(raw):
    segs = []
    for fname in RIVER_FILES:
        data = json.loads((raw / f"{fname}.geojson").read_text())
        for f in data["features"]:
            g, p = f["geometry"], f["properties"]
            if not g:
                continue
            local = p.get("name") or ""
            name = p.get("name_en") or local
            alt = p.get("name_alt") or ""
            sr = int(float(p.get("scalerank") or 12))
            lines = [round_coords(l, 3) for l in lines_of(g)]
            lines = [l for l in lines if len(l) >= 2]
            if not lines:
                continue
            segs.append({
                "name": name,
                "local": local if local and local != name else "",
                "sr": sr,
                "mz": min_zoom(p),
                "lake": "Lake" in (p.get("featurecla") or ""),
                "lines": lines,
                "alt": alt if alt not in (name, local) else "",
                "wd": p.get("wikidataid") or "",
            })

    # Group connected segments sharing a name into one river (rid), so the
    # whole river highlights together while distinct same-name rivers
    # (there are many "Red" or "San Juan" rivers) stay separate.
    uf = UnionFind(len(segs))
    cell = 0.1  # degrees; tributary pieces often join mid-line, not end to end
    grid = {}
    for i, s in enumerate(segs):
        if not s["name"]:
            continue
        for line in s["lines"]:
            for x, y in line:
                grid.setdefault((s["name"], int(x // cell), int(y // cell)), set()).add(i)
    for i, s in enumerate(segs):
        if not s["name"]:
            continue
        for line in s["lines"]:
            for x, y in (line[0], line[-1]):
                cx, cy = int(x // cell), int(y // cell)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for j in grid.get((s["name"], cx + dx, cy + dy), ()):
                            uf.union(i, j)

    # Per-river info for the labels file, kept out of rivers.geojson so the
    # big file stays small.
    meta = {}
    features = []
    for i, s in enumerate(segs):
        if s["name"]:
            m = meta.setdefault(uf.find(i), {"alt": set(), "wd": Counter(),
                                             "bbox": [180, 90, -180, -90]})
            if s["alt"]:
                m["alt"].add(s["alt"])
            if s["wd"]:
                m["wd"][s["wd"]] += 1
            b = m["bbox"]
            for line in s["lines"]:
                for x, y in line:
                    b[0], b[1] = min(b[0], x), min(b[1], y)
                    b[2], b[3] = max(b[2], x), max(b[3], y)
        geom = ({"type": "LineString", "coordinates": s["lines"][0]}
                if len(s["lines"]) == 1 else
                {"type": "MultiLineString", "coordinates": s["lines"]})
        props = {"mz": s["mz"], "w": WIDTH.get(s["sr"], 0.5), "sr": s["sr"],
                 "rid": uf.find(i) if s["name"] else -1}
        if s["name"]:
            props["name"] = s["name"]
        if s["local"]:
            props["local"] = s["local"]
        if s["lake"]:
            props["lake"] = 1
        features.append({"type": "Feature", "properties": props, "geometry": geom})
    # Big rivers last so they draw on top.
    features.sort(key=lambda f: -f["properties"]["sr"])
    return features, meta


def line_length(line):
    total = 0.0
    for (x1, y1), (x2, y2) in zip(line, line[1:]):
        dx = (x2 - x1) * math.cos(math.radians((y1 + y2) / 2))
        total += math.hypot(dx, y2 - y1)
    return total


def point_along(line, frac):
    target = line_length(line) * frac
    for a, b in zip(line, line[1:]):
        seg = line_length([a, b])
        if seg >= target and seg > 0:
            t = target / seg
            return [round(a[0] + (b[0] - a[0]) * t, 3), round(a[1] + (b[1] - a[1]) * t, 3)]
        target -= seg
    return line[-1]


def build_labels(rivers, meta):
    """One label point per river, partway along its longest stretch.

    Text along wiggly lines fails to place at low zoom, so the map uses these
    points there and switches to along-the-line labels when zoomed in.
    """
    groups = {}
    for f in rivers:
        p = f["properties"]
        if p["rid"] == -1 or p.get("lake"):
            continue
        g = f["geometry"]
        lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        best = groups.setdefault(p["rid"], {"len": -1, "total": 0.0, "props": dict(p)})
        bp = best["props"]
        bp["mz"] = min(bp["mz"], p["mz"])
        bp["w"] = max(bp["w"], p["w"])
        bp["sr"] = min(bp["sr"], p["sr"])
        for line in lines:
            length = line_length(line)
            best["total"] += length
            if length > best["len"]:
                best["len"], best["line"] = length, line
    out = []
    for g in groups.values():
        # Label priority: rank first, then longer rivers beat short delta
        # channels and side branches of the same rank.
        props = g["props"]
        props["prio"] = round(props["sr"] * 100 - min(g["total"], 99), 1)
        m = meta[props["rid"]]
        props["bbox"] = m["bbox"]
        if m["alt"]:
            props["alt"] = sorted(m["alt"])
        if m["wd"]:
            props["wd"] = m["wd"].most_common(1)[0][0]
        # 0.4 rather than 0.5 nudges labels off the confluences that often
        # sit mid-line.
        out.append({"type": "Feature", "properties": g["props"],
                    "geometry": {"type": "Point", "coordinates": point_along(g["line"], 0.4)}})
    out.sort(key=lambda f: f["properties"]["prio"])
    return out


def build_polys(raw, fname, nd, keep_mz=False):
    data = json.loads((raw / f"{fname}.geojson").read_text())
    out = []
    for f in data["features"]:
        g = f["geometry"]
        if not g:
            continue
        props = {}
        if keep_mz:
            props["mz"] = max(0, int(round(float(f["properties"].get("min_zoom") or 7) - 2)))
        out.append({"type": "Feature", "properties": props,
                    "geometry": {"type": g["type"],
                                 "coordinates": round_coords(g["coordinates"], nd)}})
    return out


def write(path, features):
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                               separators=(",", ":"), ensure_ascii=False))
    print(f"{path}: {len(features)} features, {path.stat().st_size / 1e6:.1f} MB")


def main():
    raw, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    rivers, meta = build_rivers(raw)
    write(out / "rivers.geojson", rivers)
    write(out / "labels.geojson", build_labels(rivers, meta))
    write(out / "land50.geojson", build_polys(raw, "ne_50m_land", 2))
    write(out / "land.geojson", build_polys(raw, "ne_10m_land", 2))
    write(out / "lakes.geojson", build_polys(raw, "ne_10m_lakes", 2, keep_mz=True))


if __name__ == "__main__":
    main()
