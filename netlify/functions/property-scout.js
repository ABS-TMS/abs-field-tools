// netlify/functions/property-scout.js
// Server-side proxy aggregating multiple property data sources:
//   - RentCast: property details, tax assessments, sale history, market data
//   - FEMA NFHL: flood zone classification (free, no API key)
//   - EPA FRS: Superfund/NPL site lookup within 5 miles (free, no API key)
//   - EPA Radon Zone: static lookup table by state + county FIPS (no API call)
//   - Google Maps Static API: satellite/roadmap/street view imagery (needs GOOGLE_MAPS_API_KEY)
//   - Google Places API (New): nearest grocery/transit/hospital/school/park/pharmacy (needs GOOGLE_MAPS_API_KEY)
//
// All keys stay server-side. If GOOGLE_MAPS_API_KEY is not set, images and neighborhood
// data are simply omitted from the response -- RentCast + FEMA + EPA still work without it.

// -- EPA Radon Zone lookup by state + county FIPS (static data, Zone 1=highest, 3=lowest) --
// Source: EPA Map of Radon Zones https://www.epa.gov/radon/epa-map-radon-zones
const RADON_ZONES = {
  TX: { default: '2', '029': '2', '113': '2', '453': '2', '201': '2', '121': '2', '085': '3', '061': '3', '215': '3', '409': '3' },
  CA: { default: '3' },
  FL: { default: '3' },
  NY: { default: '2', '061': '1', '005': '1' },
  IL: { default: '1' },
  PA: { default: '1' },
  OH: { default: '1' },
  MI: { default: '1' },
  GA: { default: '2' },
  NC: { default: '2' },
  VA: { default: '2' },
  CO: { default: '1' },
  AZ: { default: '2' },
  WA: { default: '2' },
  TN: { default: '2' },
  IN: { default: '1' },
  MO: { default: '1' },
  WI: { default: '1' },
  MN: { default: '1' },
  KY: { default: '2' },
  OK: { default: '2' },
  NV: { default: '2' },
  UT: { default: '1' },
  NM: { default: '2' },
  KS: { default: '1' },
  NE: { default: '1' },
  IA: { default: '1' },
  SD: { default: '1' },
  ND: { default: '1' },
  MT: { default: '1' },
  WY: { default: '1' },
  ID: { default: '1' },
  OR: { default: '2' },
  AR: { default: '2' },
  LA: { default: '3' },
  MS: { default: '3' },
  AL: { default: '2' },
  SC: { default: '2' },
  MD: { default: '2' },
  NJ: { default: '2' },
  CT: { default: '2' },
  MA: { default: '2' },
  RI: { default: '2' },
  NH: { default: '2' },
  VT: { default: '1' },
  ME: { default: '1' },
  DE: { default: '2' },
  WV: { default: '1' },
  AK: { default: '2' },
  HI: { default: '3' },
};

function getRadonZone(state, countyFips) {
  const stateData = RADON_ZONES[state];
  if (!stateData) return '2';
  return stateData[countyFips] || stateData.default || '2';
}

// -- Haversine distance formula (returns miles) --
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// -- Google Places API (New): nearest place in each amenity category --
async function fetchNeighborhoodData(lat, lng, apiKey) {
  const categories = [
    { key: 'grocery', types: ['grocery_or_supermarket', 'supermarket'], label: 'Grocery Store' },
    { key: 'transit', types: ['transit_station', 'bus_station', 'subway_station'], label: 'Transit' },
    { key: 'hospital', types: ['hospital', 'emergency_room_doctor'], label: 'Hospital / ER' },
    { key: 'school', types: ['school', 'primary_school', 'secondary_school'], label: 'School' },
    { key: 'park', types: ['park', 'national_park'], label: 'Park' },
    { key: 'pharmacy', types: ['pharmacy', 'drugstore'], label: 'Pharmacy' },
  ];

  const results = await Promise.all(
    categories.map(async (cat) => {
      for (const type of cat.types) {
        try {
          const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating',
            },
            body: JSON.stringify({
              includedTypes: [type],
              maxResultCount: 1,
              locationRestriction: {
                circle: { center: { latitude: lat, longitude: lng }, radius: 8047 }, // 5 miles in meters
              },
            }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          const place = data.places?.[0];
          if (place) {
            const placeLat = place.location?.latitude;
            const placeLng = place.location?.longitude;
            const distanceMiles = placeLat && placeLng ? haversineDistance(lat, lng, placeLat, placeLng) : null;
            return {
              key: cat.key,
              label: cat.label,
              name: place.displayName?.text || 'Unknown',
              address: place.formattedAddress || '',
              rating: place.rating || null,
              distanceMiles: distanceMiles ? Math.round(distanceMiles * 10) / 10 : null,
            };
          }
        } catch (_) { /* try next type in category */ }
      }
      return { key: cat.key, label: cat.label, name: null, address: null, rating: null, distanceMiles: null };
    })
  );

  return results.reduce((acc, item) => {
    acc[item.key] = item;
    return acc;
  }, {});
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { address } = body;
  if (!address || !address.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a property address.' }) };
  }

  const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
  const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY; // optional -- photo + amenities only

  if (!RENTCAST_API_KEY) {
    console.error('RENTCAST_API_KEY is not set in Netlify environment variables');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured. Missing RentCast API key.' }) };
  }

  const encodedAddress = encodeURIComponent(address.trim());

  try {
    // -- 1. RentCast property lookup --
    const rcRes = await fetch(`https://api.rentcast.io/v1/properties?address=${encodedAddress}`, {
      headers: { 'X-Api-Key': RENTCAST_API_KEY, Accept: 'application/json' },
    });

    if (!rcRes.ok) {
      if (rcRes.status === 404) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Property not found. Try including the full street address, city, and state.' }) };
      }
      const err = await rcRes.text();
      return { statusCode: rcRes.status, body: JSON.stringify({ error: `RentCast error: ${err}` }) };
    }

    const rcData = await rcRes.json();
    const property = Array.isArray(rcData) ? rcData[0] : rcData;

    if (!property) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Property not found. Try including the full street address, city, and state.' }) };
    }

    // -- Normalize RentCast fields --
    const taxYears = property.taxAssessments ? Object.values(property.taxAssessments).sort((a, b) => b.year - a.year) : [];
    const taxBillYears = property.propertyTaxes ? Object.values(property.propertyTaxes).sort((a, b) => b.year - a.year) : [];
    const latestTax = taxYears[0] || {};
    const latestBill = taxBillYears[0] || {};

    const historyEntries = property.history
      ? Object.values(property.history).filter((h) => h.event === 'Sale').sort((a, b) => new Date(b.date) - new Date(a.date))
      : [];
    const lastSale = historyEntries[0] || {};
    const prevSale = historyEntries[1] || {};

    const ownerNames = property.owner?.names || [];
    const ownerMailingAddr = property.owner?.mailingAddress;
    const ownerMailingStr = ownerMailingAddr
      ? [ownerMailingAddr.addressLine1, ownerMailingAddr.city, ownerMailingAddr.state, ownerMailingAddr.zipCode].filter(Boolean).join(', ')
      : null;

    Object.assign(property, {
      apn: property.assessorID,
      ownerName: ownerNames.join(' & ') || null,
      ownerType: property.ownerOccupied === true ? 'Owner-Occupied' : property.ownerOccupied === false ? 'Non-Owner-Occupied' : null,
      ownerAddress: ownerMailingStr,
      assessedValue: latestTax.value || null,
      assessedLandValue: latestTax.land || null,
      assessedImprovementValue: latestTax.improvements || null,
      taxAnnualAmount: latestBill.total || null,
      taxYear: latestTax.year || null,
      lastSaleDate: lastSale.date || property.lastSaleDate || null,
      lastSalePrice: lastSale.price || property.lastSalePrice || null,
      previousSaleDate: prevSale.date || null,
      previousSalePrice: prevSale.price || null,
    });

    const taxTrend = taxYears.slice(0, 5).reverse().map((t) => ({
      year: t.year,
      value: t.value,
      land: t.land,
      improvements: t.improvements,
    }));

    const lat = property.latitude;
    const lng = property.longitude;
    const state = property.state;
    const countyFips = property.countyFips;

    // -- 2. Parallel: FEMA + EPA Superfund + RentCast market data + neighborhood --
    const [femaData, superfundData, marketData, neighborhood] = await Promise.all([
      // FEMA Flood Zone -- free, no API key
      lat && lng
        ? fetch(
            `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/2/query?where=1%3D1&geometry=${lng}%2C${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false&outFields=*&f=json`
          )
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        : Promise.resolve(null),

      // EPA Superfund (CERCLIS) -- free, no API key. ~5 mile bounding box (0.07 degrees).
      lat && lng
        ? fetch(
            `https://data.epa.gov/efservice/FACILITIES/LATITUDE83/BEGINNING/${lat - 0.07}/LATITUDE83/ENDING/${lat + 0.07}/LONGITUDE83/BEGINNING/${lng - 0.07}/LONGITUDE83/ENDING/${lng + 0.07}/ACTIVE_STATUS/A/JSON`
          )
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => [])
        : Promise.resolve([]),

      // RentCast market data -- ZIP-level sale + rental data with 6-month history
      property.zipCode
        ? fetch(`https://api.rentcast.io/v1/markets?zipCode=${property.zipCode}&dataType=All&historyRange=6`, {
            headers: { 'X-Api-Key': RENTCAST_API_KEY, Accept: 'application/json' },
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        : Promise.resolve(null),

      // Google Places neighborhood data -- only if key is configured
      GOOGLE_MAPS_API_KEY && lat && lng
        ? fetchNeighborhoodData(lat, lng, GOOGLE_MAPS_API_KEY)
        : Promise.resolve(null),
    ]);

    // -- Parse FEMA --
    const femaFloodZone = femaData?.features?.[0]?.attributes?.FLD_ZONE || femaData?.features?.[0]?.attributes?.Zone || 'X';
    const femaFloodZoneDescription =
      femaData?.features?.[0]?.attributes?.ZONE_SUBTY ||
      femaData?.features?.[0]?.attributes?.Descr ||
      (femaFloodZone === 'X' ? 'Area of Minimal Flood Hazard' : femaFloodZone);

    // -- Parse EPA Superfund -- filter to NPL-listed facilities only --
    const superfundSites = Array.isArray(superfundData)
      ? superfundData
          .filter((f) => f.SITE_TYPE_NAME && /superfund|npl|cerclis/i.test(f.SITE_TYPE_NAME))
          .slice(0, 5)
          .map((f) => ({
            name: f.FACILITY_NAME || f.PRIMARY_NAME || 'Unknown Site',
            city: f.CITY_NAME || '',
            state: f.STATE_CODE || '',
            status: f.SITE_TYPE_NAME || '',
          }))
      : [];

    // -- EPA Radon Zone -- static lookup, no API call --
    const radonZone = getRadonZone(state, countyFips);

    // -- Parse RentCast market data --
    const saleData = marketData?.saleData || {};
    const rentalData = marketData?.rentalData || {};
    const saleHistory = saleData.history || {};
    const rentalHistory = rentalData.history || {};

    const appreciationHistory = saleHistory.medianPrice || [];
    const zipMedianPricePerSqft = saleData.medianPricePerSquareFoot || null;
    const subjectPricePerSqft =
      property.squareFootage && property.assessedValue ? Math.round(property.assessedValue / property.squareFootage) : null;
    const totalListings = saleData.totalListings || null;
    const newListings = saleData.newListings || null;
    const dataByBedrooms = saleData.dataByBedrooms || [];
    const subjectBeds = property.bedrooms;
    const bedroomComp = subjectBeds ? dataByBedrooms.find((d) => d.bedrooms === subjectBeds) : null;
    const rentalSnapshot = {
      medianRent: rentalData.medianRent || null,
      averageRent: rentalData.averageRent || null,
      rentalByBedrooms: rentalData.dataByBedrooms || [],
    };
    const domBaseline = saleData.averageDaysOnMarket ?? null;
    const medianListPrice = saleData.medianPrice ?? null;
    const monthsOfSupply = marketData?.monthsOfSupply ?? null;
    const marketStatus = domBaseline != null ? (domBaseline <= 30 ? 'Hot' : domBaseline <= 60 ? 'Balanced' : 'Stale') : null;

    // -- Images -- only if Google Maps key is configured --
    const images = {
      roadmap: GOOGLE_MAPS_API_KEY
        ? `https://maps.googleapis.com/maps/api/staticmap?center=${encodedAddress}&zoom=17&size=640x400&maptype=roadmap&markers=color:red%7C${encodedAddress}&key=${GOOGLE_MAPS_API_KEY}`
        : null,
      streetview: GOOGLE_MAPS_API_KEY
        ? `https://maps.googleapis.com/maps/api/streetview?size=640x400&location=${encodedAddress}&key=${GOOGLE_MAPS_API_KEY}`
        : null,
    };

    const responsePayload = {
      property,
      images,
      hazards: {
        femaFloodZone,
        femaFloodZoneDescription,
        superfundSites,
        radonZone,
      },
      marketData: {
        taxTrend,
        domBaseline,
        medianListPrice,
        monthsOfSupply,
        marketStatus,
        appreciationHistory,
        zipMedianPricePerSqft,
        subjectPricePerSqft,
        totalListings,
        newListings,
        bedroomComp,
        rentalSnapshot,
      },
      neighborhood,
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(responsePayload),
    };
  } catch (err) {
    console.error('property-scout.js error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Failed to reach property data sources' }) };
  }
};
