/**
 * gee_export_2025.js
 *
 * Run this in the Google Earth Engine JavaScript Code Editor:
 *   https://code.earthengine.google.com/
 *
 * Exports 2025 daily Tmax from ERA5 HOURLY as 12 monthly multi-band GeoTIFFs
 * (one batch per month, each with N bands where N = days in that month).
 * This approach stays well within GEE's concurrent task limit and avoids
 * the overhead of 365 individual export tasks.
 *
 * Output files (in Google Drive folder 'temperature_map_exports'):
 *   era5_2025_tmax_jan.tif  (31 bands: Jan 1 - Jan 31)
 *   era5_2025_tmax_feb.tif  (28 bands: Feb 1 - Feb 28)
 *   era5_2025_tmax_mar.tif  (31 bands)
 *   ... etc.
 *
 * Each band = daily Tmax in Kelvin, float32, 1440x721, 0.25°, EPSG:4326.
 * Band naming: 'tmax_YYYY_MM_DD'
 *
 * NOTES:
 * - ERA5 HOURLY has a ~5-7 day lag. All of 2025 should be available by the
 *   time you run this (in 2026).
 * - If a date has 0 hourly images (very rare), that day's band will be empty.
 *   The Python script handles this by writing a NaN band and flagging the
 *   day as missing in meta.json.
 * - Run all 12 export tasks and wait for them to finish before running the
 *   Python processing script.
 */

// ── Configuration ──────────────────────────────────────────────────────────

var YEAR = 2025;

// Month lengths for 2025 (not a leap year)
var MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var MONTH_NAMES = ['jan','feb','mar','apr','may','jun',
                   'jul','aug','sep','oct','nov','dec'];

// ── Build daily Tmax band for a single date ─────────────────────────────────

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function getDailyTmax(year, month, day) {
    // Band name built entirely from plain JS — no ee.Number.format()
    var bandName  = 'tmax_' + year + '_' + pad2(month) + '_' + pad2(day);
    var startDate = ee.Date.fromYMD(year, month, day);
    var endDate   = startDate.advance(1, 'day');

    // Let the export's crsTransform handle the reprojection to 0.25°.
    // Specifying reproject() here as well causes conflicting reprojection
    // instructions that produce edge-alignment errors at GEE tile boundaries.
    return ee.ImageCollection('ECMWF/ERA5/HOURLY')
        .select('temperature_2m')
        .filterDate(startDate, endDate)
        .max()
        .rename(bandName);
}

// ── Quick sanity check (runs before exporting) ─────────────────────────────

var testDay = getDailyTmax(YEAR, 1, 1);
print('Jan 1 band names:', testDay.bandNames());
print('Jan 1 sample value at (0°, 0°):', testDay.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: ee.Geometry.Point([0, 0]),
    scale: 27830
}));
print('Jan 1 sample value at (-90°, 45°):', testDay.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: ee.Geometry.Point([-90, 45]),
    scale: 27830
}));
print('Jan 1 projection:', testDay.projection());
var exportRegion = ee.Geometry.Rectangle([-180, -90, 180, 90], null, false);
print('Export region area (should be ~64,800 sq-deg):', exportRegion.area(1).divide(1e10));

var vis = {
    min: 250, max: 320,
    palette: ['313695','4575b4','74add1','abd9e9','e0f3f8',
              'ffffbf','fee090','fdae61','f46d43','d73027','a50026']
};
Map.addLayer(testDay, vis, 'Tmax Jan 1 2025 (K)');
Map.setCenter(0, 20, 2);

// ── Submit one export task per month ───────────────────────────────────────

for (var m = 0; m < 12; m++) {
    var monthNum  = m + 1;
    var daysInMonth = MONTH_DAYS[m];
    var monthName = MONTH_NAMES[m];

    // Build list of daily Tmax images for this month
    var dailyImages = [];
    for (var d = 1; d <= daysInMonth; d++) {
        dailyImages.push(getDailyTmax(YEAR, monthNum, d));
    }

    var monthlyStack = ee.Image(dailyImages[0]);
    for (var i = 1; i < dailyImages.length; i++) {
        monthlyStack = monthlyStack.addBands(dailyImages[i]);
    }

    // Debug: verify band count and first/last band names before submitting
    print('Month ' + monthName + ': band count =', monthlyStack.bandNames().size());
    print('Month ' + monthName + ': bands =', monthlyStack.bandNames());

    Export.image.toDrive({
        image: monthlyStack,
        description: 'era5_2025_tmax_' + monthName,
        folder: 'temperature_map_exports',
        fileNamePrefix: 'era5_2025_tmax_' + monthName,
        region: ee.Geometry.Rectangle([-180, -90, 179.999, 90], null, false),
        crs: 'EPSG:4326',
        scale: 27830,
        maxPixels: 1e10,
        fileFormat: 'GeoTIFF',
    });
}

print('12 monthly export tasks submitted. Check the Tasks tab.');
print('Wait for ALL tasks to complete before running the Python processing script.');
