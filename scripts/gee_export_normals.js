/**
 * gee_export_normals.js
 *
 * Run this in the Google Earth Engine JavaScript Code Editor:
 *   https://code.earthengine.google.com/
 *
 * Computes the 1991-2020 calendar-day normals for daily Tmax using ERA5 DAILY.
 * Exports a single 365-band GeoTIFF to Google Drive (one band per DOY).
 *
 * IMPORTANT: This uses a ±7-day rolling window per DOY to produce smooth normals
 * and avoid gaps from leap years or missing data. Each band is the mean of all
 * ERA5 DAILY images whose calendar DOY falls within ±7 days of the target DOY,
 * across all years 1991-2020.
 *
 * Output: normals_era5_1991_2020.tif
 *   - 365 bands (band 1 = DOY 1, band 365 = DOY 365)
 *   - float32 Kelvin values
 *   - 1440 x 721 pixels, 0.25° resolution, WGS84 (EPSG:4326)
 *
 * This is a long-running export (~30-60 min). Monitor progress in the Tasks tab.
 */

// ── Configuration ──────────────────────────────────────────────────────────

var START_YEAR  = 1991;
var END_YEAR    = 2020;
var WINDOW_DAYS = 7;   // ±7 day rolling window for smoothing

// ── Helper: get the calendar DOY of an image ───────────────────────────────

// We filter using filterDate rather than by DOY property, looping over
// a ±WINDOW_DAYS range of dates per year for each target DOY.

// ── Build normals band by band ──────────────────────────────────────────────

var years = ee.List.sequence(START_YEAR, END_YEAR);

/**
 * For a given target DOY (1-indexed), collect all ERA5 DAILY images
 * with calendar dates within ±WINDOW_DAYS of that DOY across all years,
 * then return the pixel-wise mean.
 */
function buildNormalForDoy(targetDoy) {
    targetDoy = ee.Number(targetDoy);

    // For each year, collect images in the window [targetDoy - WINDOW, targetDoy + WINDOW]
    var imagesForDoy = years.map(function(year) {
        year = ee.Number(year);

        // Anchor date for this year + DOY
        var anchorDate  = ee.Date.fromYMD(year, 1, 1).advance(targetDoy.subtract(1), 'day');
        var windowStart = anchorDate.advance(-WINDOW_DAYS, 'day');
        var windowEnd   = anchorDate.advance(WINDOW_DAYS + 1, 'day'); // exclusive

        var imgs = ee.ImageCollection('ECMWF/ERA5/DAILY')
            .select('maximum_2m_air_temperature')
            .filterDate(windowStart, windowEnd);

        // Return mean over the window for this year, or null if empty
        var count = imgs.size();
        return ee.Algorithms.If(count.gt(0), imgs.mean(), null);
    }).removeAll([null]);

    var col = ee.ImageCollection.fromImages(imagesForDoy);
    return col.mean().rename('tmax_normal_doy_' + targetDoy.format('%03d'));
}

// Build each DOY band and combine into a multi-band image
// Note: GEE has limits on how many images you can assemble at once.
// We export in a single call by iterating and combining.

var doys = ee.List.sequence(1, 365);

var bands = doys.map(function(doy) {
    return buildNormalForDoy(doy);
});

var normalsImage = ee.ImageCollection.fromImages(bands).toBands();

print('Normals image band count:', normalsImage.bandNames().size());
print('First band name:', normalsImage.bandNames().get(0));

// ── Visualize a sample band for sanity check ───────────────────────────────

var vis = {
    min: 250,
    max: 320,
    palette: ['313695', '4575b4', '74add1', 'abd9e9', 'e0f3f8',
              'ffffbf', 'fee090', 'fdae61', 'f46d43', 'd73027', 'a50026']
};
// Show DOY 91 (April 1) normal
var band91 = normalsImage.select([90]); // 0-indexed
Map.addLayer(band91, vis, 'Normal Tmax - DOY 091 (K)');
Map.setCenter(0, 20, 2);

// ── Export ─────────────────────────────────────────────────────────────────

Export.image.toDrive({
    image: normalsImage,
    description: 'normals_era5_1991_2020',
    folder: 'temperature_map_exports',
    fileNamePrefix: 'normals_era5_1991_2020',
    region: ee.Geometry.Rectangle([-180, -90, 180, 90]),
    scale: 27830,         // ERA5 native pixel size at equator (~0.25°)
    crs: 'EPSG:4326',
    maxPixels: 1e10,
    fileFormat: 'GeoTIFF',
});

print('Export task submitted. Check the Tasks tab.');
