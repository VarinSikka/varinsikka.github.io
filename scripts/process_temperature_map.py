"""
process_temperature_map.py

Converts GEE-exported ERA5 GeoTIFFs into the static data files needed by
the temperature-map web page:

  data/temperature-map/
    overlays/day_NNN.png         RGBA PNG, 1440x721, anomaly color overlay
    daily/day_NNN.bin            int8 quantized anomaly (for popup lookup)
    daily/day_NNN_temps.bin      float16 interleaved [tmax_k, norm_k] pairs
    meta.json                    list of available days + metadata

Prerequisites:
    pip install rasterio numpy Pillow matplotlib geopandas

Input files (expected in ./gee_exports/ by default):
    normals_era5_1991_2020.tif   365-band normals GeoTIFF from gee_export_normals.js
    era5_2025_tmax_jan.tif       Monthly Tmax stacks from gee_export_2025.js
    era5_2025_tmax_feb.tif
    ... (12 files total)

Usage:
    python process_temperature_map.py [--exports-dir ./gee_exports] [--out-dir ../data/temperature-map]

Notes on data format:
    - All ERA5 temperatures are in Kelvin.
    - Anomaly = Tmax_2025 - Normal (same in K and °C).
    - PNG overlays: RGBA, land alpha=204 (80%), ocean alpha=0.
    - Anomaly bins: int8, scale = round(anomaly_K * 12.7), clamped [-127,127],
      ocean sentinel = -128.  Precision: 1/12.7 ≈ 0.079 K (~0.14°F).
    - Temps bins: float16 interleaved [tmax_k, norm_k] per pixel.
      JS decodes with the f16ToF32 utility in temperature-map.js.
"""

import argparse
import json
import os
import struct
import sys
from datetime import date, timedelta

import numpy as np
import rasterio
from PIL import Image
from matplotlib.colors import LinearSegmentedColormap

# ── Optional: geopandas for land mask rasterization ───────────────────────
try:
    import geopandas as gpd
    import rasterio.features
    HAS_GEOPANDAS = True
except ImportError:
    HAS_GEOPANDAS = False
    print("WARNING: geopandas not available. Ocean masking disabled.")
    print("         Install with: pip install geopandas")

# ── Constants ──────────────────────────────────────────────────────────────

GRID_ROWS = 721
GRID_COLS = 1440
ANOMALY_MIN = -10.0  # K / °C
ANOMALY_MAX =  10.0

# RdYlBu-reversed diverging palette (blue=cold, yellow=normal, red=warm)
PALETTE_COLORS = [
    '#313695',  # ≤ -10 K (deep blue)
    '#4575b4',
    '#74add1',
    '#abd9e9',
    '#e0f3f8',
    '#ffffbf',  # 0 K (pale yellow)
    '#fee090',
    '#fdae61',
    '#f46d43',
    '#d73027',
    '#a50026',  # ≥ +10 K (deep red)
]

# 2025 is not a leap year
MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
MONTH_NAMES = ['jan','feb','mar','apr','may','jun',
               'jul','aug','sep','oct','nov','dec']

# ── Colormap setup ─────────────────────────────────────────────────────────

_cmap = LinearSegmentedColormap.from_list('rdylbu_r', PALETTE_COLORS, N=256)

def anomaly_to_rgba(anomaly_k, ocean_mask):
    """
    Convert float32 anomaly array (721x1440) to RGBA uint8 PNG array.

    Parameters
    ----------
    anomaly_k : ndarray, shape (721, 1440), float32
        Temperature anomaly in Kelvin (= Celsius difference).
    ocean_mask : ndarray, shape (721, 1440), bool
        True where pixel is ocean or no-data.

    Returns
    -------
    rgba : ndarray, shape (721, 1440, 4), uint8
    """
    norm = np.clip((anomaly_k - ANOMALY_MIN) / (ANOMALY_MAX - ANOMALY_MIN), 0.0, 1.0)
    rgba = (_cmap(norm) * 255).astype(np.uint8)   # shape (721, 1440, 4)
    rgba[ocean_mask,  3] = 0    # transparent ocean
    rgba[~ocean_mask, 3] = 204  # 80% opacity for land
    return rgba

# ── Land mask ──────────────────────────────────────────────────────────────

def build_land_mask(exports_dir):
    """
    Build a boolean land mask (True = ocean) at ERA5 0.25° resolution.
    Uses Natural Earth 110m land polygons via geopandas + rasterio.features.

    If geopandas is unavailable, returns an all-False mask (all land).
    The Natural Earth shapefile can be downloaded from:
      https://www.naturalearthdata.com/downloads/110m-physical-vectors/
      → ne_110m_land.zip → extract ne_110m_land.shp

    Place the .shp file alongside this script or specify the path below.
    """
    ne_path = os.path.join(exports_dir, 'ne_110m_land.shp')
    if not HAS_GEOPANDAS or not os.path.exists(ne_path):
        print("  Land mask: geopandas/shapefile unavailable → all pixels treated as land.")
        return np.zeros((GRID_ROWS, GRID_COLS), dtype=bool)

    print("  Building land mask from Natural Earth 110m shapefile...")
    gdf = gpd.read_file(ne_path)
    # Create a transform matching the ERA5 grid:
    # top-left corner is (-180, 90), pixel size 0.25°
    # rasterio convention: transform(col_step, 0, left, 0, -row_step, top)
    transform = rasterio.transform.from_bounds(
        west=-180, south=-90, east=180, north=90,
        width=GRID_COLS, height=GRID_ROWS
    )
    land_raster = rasterio.features.rasterize(
        ((geom, 1) for geom in gdf.geometry),
        out_shape=(GRID_ROWS, GRID_COLS),
        transform=transform,
        fill=0,
        dtype='uint8',
    )
    ocean_mask = land_raster == 0  # True = ocean
    print(f"  Land mask built: {ocean_mask.sum()} ocean pixels, "
          f"{(~ocean_mask).sum()} land pixels.")
    return ocean_mask

# ── Float16 encoding ───────────────────────────────────────────────────────

def encode_float16(arr):
    """Convert float32 array to bytes using float16 representation."""
    return arr.astype(np.float16).tobytes()

# ── Main processing loop ───────────────────────────────────────────────────

def process(exports_dir, out_dir):
    os.makedirs(os.path.join(out_dir, 'overlays'), exist_ok=True)
    os.makedirs(os.path.join(out_dir, 'daily'),    exist_ok=True)

    # Load normals GeoTIFF
    normals_path = os.path.join(exports_dir, 'normals_era5_1991_2020.tif')
    if not os.path.exists(normals_path):
        sys.exit(f"ERROR: Normals file not found at {normals_path}")
    print(f"Loading normals from {normals_path}...")
    with rasterio.open(normals_path) as nf:
        normals_all = nf.read()  # shape (365, 721, 1440), float32, Kelvin
    print(f"  Normals shape: {normals_all.shape}")

    # Build land/ocean mask
    ocean_mask = build_land_mask(exports_dir)

    available_days = []
    missing_days   = []

    # Process each month
    global_doy = 1
    for m_idx in range(12):
        month_name  = MONTH_NAMES[m_idx]
        days_in_mon = MONTH_DAYS[m_idx]
        tmax_path   = os.path.join(exports_dir, f'era5_2025_tmax_{month_name}.tif')

        if not os.path.exists(tmax_path):
            print(f"  MISSING: {tmax_path} — marking days {global_doy}–{global_doy+days_in_mon-1} as unavailable.")
            for _ in range(days_in_mon):
                missing_days.append(global_doy)
                global_doy += 1
            continue

        print(f"\nProcessing {month_name.upper()} ({days_in_mon} days)...")
        with rasterio.open(tmax_path) as tf:
            tmax_month = tf.read()  # shape (days_in_mon, 721, 1440), Kelvin

        for d_idx in range(days_in_mon):
            doy = global_doy
            pad = f'{doy:03d}'
            print(f"  DOY {pad} ({date(2025, m_idx+1, d_idx+1).strftime('%b %d')})", end=' ')

            tmax_k = tmax_month[d_idx].astype(np.float32)  # (721, 1440)
            norm_k = normals_all[doy - 1].astype(np.float32)

            # Check for missing data (all zeros from GEE when no hourly data exists)
            if np.all(tmax_k == 0.0):
                print("→ MISSING (all zeros)")
                missing_days.append(doy)
                global_doy += 1
                continue

            anomaly_k = tmax_k - norm_k  # (721, 1440), K = °C difference

            # ── PNG overlay ────────────────────────────────────────────────
            rgba = anomaly_to_rgba(anomaly_k, ocean_mask)
            img  = Image.fromarray(rgba, mode='RGBA')
            png_path = os.path.join(out_dir, 'overlays', f'day_{pad}.png')
            img.save(png_path, optimize=True)

            # ── Anomaly bin (int8) ─────────────────────────────────────────
            # Scale: val * 12.7, clamped to [-127, 127], ocean = -128
            anom_scaled = np.clip(np.round(anomaly_k * 12.7), -127, 127).astype(np.int8)
            anom_scaled[ocean_mask] = -128  # ocean sentinel
            bin_path = os.path.join(out_dir, 'daily', f'day_{pad}.bin')
            with open(bin_path, 'wb') as bf:
                bf.write(anom_scaled.tobytes())

            # ── Temps bin (float16 interleaved) ───────────────────────────
            # Flatten both arrays, interleave: [max0, norm0, max1, norm1, ...]
            max_flat  = tmax_k.flatten().astype(np.float16)
            norm_flat = norm_k.flatten().astype(np.float16)
            # Set ocean pixels to NaN
            max_flat[ ocean_mask.flatten()] = np.float16('nan')
            norm_flat[ocean_mask.flatten()] = np.float16('nan')
            interleaved = np.empty(max_flat.size * 2, dtype=np.float16)
            interleaved[0::2] = max_flat
            interleaved[1::2] = norm_flat
            temps_path = os.path.join(out_dir, 'daily', f'day_{pad}_temps.bin')
            with open(temps_path, 'wb') as tf2:
                tf2.write(interleaved.tobytes())

            available_days.append(doy)
            print(f"→ OK (anomaly mean: {anomaly_k[~ocean_mask].mean():.2f} K)")
            global_doy += 1

    # ── meta.json ──────────────────────────────────────────────────────────
    meta = {
        'year': 2025,
        'available_days': available_days,
        'missing_days': missing_days,
        'last_updated': str(date.today()),
        'normals_period': '1991-2020',
        'data_source': 'ERA5 via Google Earth Engine (ECMWF)',
    }
    meta_path = os.path.join(out_dir, 'meta.json')
    with open(meta_path, 'w') as mf:
        json.dump(meta, mf, indent=2)

    print(f"\n{'='*60}")
    print(f"Done.")
    print(f"  Available days: {len(available_days)}")
    print(f"  Missing days:   {len(missing_days)}")
    if missing_days:
        print(f"  Missing DOYs:   {missing_days}")
    print(f"  Output:         {out_dir}")
    print(f"  meta.json:      {meta_path}")

# ── CLI ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Process ERA5 GeoTIFFs for temperature-map.')
    parser.add_argument('--exports-dir', default='./gee_exports',
                        help='Directory containing GEE-exported GeoTIFFs (default: ./gee_exports)')
    parser.add_argument('--out-dir', default='../data/temperature-map',
                        help='Output directory for web assets (default: ../data/temperature-map)')
    args = parser.parse_args()

    process(
        exports_dir=os.path.abspath(args.exports_dir),
        out_dir=os.path.abspath(args.out_dir),
    )
