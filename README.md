# Rivers of the World

An interactive world map of rivers. Bigger rivers show first and smaller ones
appear as you zoom in. Hover over (or tap) a river to highlight it and see its name.

Built with [MapLibre GL JS](https://maplibre.org/) and
[Natural Earth](https://www.naturalearthdata.com/) data. It needs no backend.

## Run

```sh
python3 -m http.server 8000 --directory public
# open http://localhost:8000
```

## Rebuild the data

```sh
mkdir -p data/raw && cd data/raw
for f in ne_10m_rivers_lake_centerlines ne_10m_rivers_europe ne_10m_rivers_north_america \
         ne_50m_land ne_10m_land ne_10m_lakes; do
  curl -sSfLO "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/$f.geojson"
done
cd ../..
python3 -I scripts/prepare.py data/raw public/data
```

`prepare.py` gives each river segment:

- `mz`: the zoom level where it appears (from Natural Earth's `min_zoom`)
- `w`: its line width (from `scalerank`)
- `rid`: a river id shared by connected segments with the same name, so the whole river highlights together

It also writes one label point per river for low zoom levels. Text along wiggly
lines can't be placed when zoomed out, so from zoom 6 on the labels follow the river instead.
