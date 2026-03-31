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

function getDailyTmax(year, month, day) {
    var startDate = ee.Date.fromYMD(year, month, day);
    var endDate   = startDate.advance(1, 'day');

    var hourlyImgs = ee.ImageCollection('ECMWF/ERA5/HOURLY')
        .select('temperature_2m')
        .filterDate(startDate, endDate);

    var count = hourlyImgs.size();
    var tmax  = ee.Image(ee.Algorithms.If(
        count.gt(0),
        hourlyImgs.max().rename('tmax_' + year + '_' +
            ee.Number(month).format('%02d') + '_' +
            ee.Number(day).format('%02d')),
        ee.Image.constant(0).rename('tmax_' + year + '_' +
            ee.Number(month).format('%02d') + '_' +
            ee.Number(day).format('%02d'))
    ));
    return tmax;
}

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

    Export.image.toDrive({
        image: monthlyStack,
        description: 'era5_2025_tmax_' + monthName,
        folder: 'temperature_map_exports',
        fileNamePrefix: 'era5_2025_tmax_' + monthName,
        region: ee.Geometry.Rectangle([-180, -90, 180, 90]),
        scale: 27830,
        crs: 'EPSG:4326',
        maxPixels: 1e10,
        fileFormat: 'GeoTIFF',
    });
}

print('12 monthly export tasks submitted. Check the Tasks tab.');
print('Wait for ALL tasks to complete before running the Python processing script.');
