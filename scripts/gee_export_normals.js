/**
 * gee_export_normals.js
 *
 * Run this in the Google Earth Engine JavaScript Code Editor:
 *   https://code.earthengine.google.com/
 *
 * Computes 1991-2020 calendar-day normals for ERA5 daily Tmax.
 * Exports 12 monthly GeoTIFFs (~28-31 bands each) to Google Drive.
 *
 * Key design: uses ee.Filter.calendarRange() to select all images for a given
 * DOY across the entire 1991-2020 period in one flat filter+mean operation.
 * This keeps the GEE computation graph shallow (avoids the year-loop nesting
 * that caused silent truncation in earlier versions).
 *
 * Output files in Google Drive → 'temperature_map_exports':
 *   normals_era5_1991_2020_jan.tif  (31 bands: DOY 1–31)
 *   normals_era5_1991_2020_feb.tif  (28 bands: DOY 32–59)
 *   ... normals_era5_1991_2020_dec.tif
 *
 * Band names: b001, b002, ... b365 (matching their DOY)
 * Values: float32 Kelvin
 * Resolution: ~0.25° (scale 27830 m), 1440×721, EPSG:4326
 */

// ── Configuration ──────────────────────────────────────────────────────────

var NORM_START  = '1991-01-01';
var NORM_END    = '2021-01-01';  // exclusive upper bound

var MONTH_NAMES = ['jan','feb','mar','apr','may','jun',
                   'jul','aug','sep','oct','nov','dec'];
var MONTH_DAYS  = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// ── Load the full 1991-2020 ERA5 DAILY collection once ─────────────────────

var era5daily = ee.ImageCollection('ECMWF/ERA5/DAILY')
    .select('maximum_2m_air_temperature')
    .filterDate(NORM_START, NORM_END);

// ── Helpers ────────────────────────────────────────────────────────────────

function pad3(n) {
    var s = String(n);
    while (s.length < 3) s = '0' + s;
    return s;
}

/**
 * Return a single-band image: mean of all ERA5 DAILY images whose
 * day-of-year matches targetDoy (plain JS integer, 1-indexed).
 * Uses ee.Filter.calendarRange — one flat filter+reduce, no year loop.
 */
function buildNormalForDoy(targetDoy) {
    return era5daily
        .filter(ee.Filter.calendarRange(targetDoy, targetDoy, 'day_of_year'))
        .mean()
        .rename('b' + pad3(targetDoy));
}

// ── Quick sanity check (runs before exporting) ─────────────────────────────

var testBand = buildNormalForDoy(1);
print('DOY 1 band names:', testBand.bandNames());
print('DOY 1 sample value at (0°, 0°):', testBand.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: ee.Geometry.Point([0, 0]),
    scale: 27830
}));
print('DOY 1 sample value at (-90°, 45°):', testBand.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: ee.Geometry.Point([-90, 45]),
    scale: 27830
}));
// Check the image projection — should show EPSG:4326 and ~0.25° pixel size
print('DOY 1 projection:', testBand.projection());
// Verify the export region is non-degenerate
var exportRegion = ee.Geometry.Rectangle([-180, -90, 180, 90], null, false);
print('Export region area (should be ~64,800 sq-deg):', exportRegion.area(1).divide(1e10));

var vis = {
    min: 250, max: 320,
    palette: ['313695','4575b4','74add1','abd9e9','e0f3f8',
              'ffffbf','fee090','fdae61','f46d43','d73027','a50026']
};
Map.addLayer(testBand, vis, 'Normal Tmax DOY 001 (K)');
Map.setCenter(0, 20, 2);

// ── Export one task per month ───────────────────────────────────────────────

var doyStart = 1;
for (var m = 0; m < 12; m++) {
    var daysInMonth = MONTH_DAYS[m];
    var monthName   = MONTH_NAMES[m];
    var doyEnd      = doyStart + daysInMonth - 1;

    // Stack bands for this month (~28-31 addBands deep)
    var monthImage = buildNormalForDoy(doyStart);
    for (var doy = doyStart + 1; doy <= doyEnd; doy++) {
        monthImage = monthImage.addBands(buildNormalForDoy(doy));
    }

    Export.image.toDrive({
        image: monthImage,
        description: 'normals_era5_1991_2020_' + monthName,
        folder: 'temperature_map_exports',
        fileNamePrefix: 'normals_era5_1991_2020_' + monthName,
        region: ee.Geometry.Rectangle([-180, -90, 180, 90], null, false),
        crs: 'EPSG:4326',
        crsTransform: [0.25, 0, -180, 0, -0.25, 90],
        dimensions: '1440x721',
        maxPixels: 1e10,
        fileFormat: 'GeoTIFF',
    });

    doyStart = doyEnd + 1;
}

print('12 normals export tasks submitted. Check the Tasks tab.');
print('Expected file size per month: ~30-60 MB.');
