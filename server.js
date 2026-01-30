const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || '6005cd6988e875868452d33d';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Cache for CMS data (refreshes every 30 minutes)
let cmsCache = {
  hotels: [],
  regions: [],
  collections: [],
  lastFetch: null
};

const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// ============================================
// WEBFLOW CMS FUNCTIONS
// ============================================

async function fetchAllCollectionItems(collectionId) {
  const items = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=${limit}`,
      {
        headers: {
          'Authorization': `Bearer ${WEBFLOW_API_TOKEN}`,
          'accept': 'application/json'
        }
      }
    );

    if (!response.ok) {
      console.error(`Failed to fetch collection ${collectionId}:`, response.status);
      break;
    }

    const data = await response.json();
    items.push(...(data.items || []));
    
    hasMore = data.items && data.items.length === limit;
    offset += limit;
    
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return items;
}

async function fetchWebflowCollections() {
  try {
    const response = await fetch(
      `https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/collections`,
      {
        headers: {
          'Authorization': `Bearer ${WEBFLOW_API_TOKEN}`,
          'accept': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch collections: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching Webflow collections:', error);
    return { collections: [] };
  }
}

async function refreshCMSCache() {
  if (!WEBFLOW_API_TOKEN) {
    console.log('No Webflow API token configured');
    return;
  }

  console.log('Refreshing CMS cache...');
  
  try {
    const collectionsData = await fetchWebflowCollections();
    const collections = collectionsData.collections || [];
    
    let hotelsCollectionId = null;
    let regionsCollectionId = null;

    for (const collection of collections) {
      const name = (collection.displayName || collection.slug || '').toLowerCase();
      if (name.includes('hotel') && !name.includes('type')) {
        hotelsCollectionId = collection.id;
      } else if (name.includes('region') || name.includes('location')) {
        regionsCollectionId = collection.id;
      }
    }

    console.log('Found collections:', { hotelsCollectionId, regionsCollectionId });

    if (hotelsCollectionId) {
      cmsCache.hotels = await fetchAllCollectionItems(hotelsCollectionId);
      console.log(`Loaded ${cmsCache.hotels.length} hotels`);
    }

    if (regionsCollectionId) {
      cmsCache.regions = await fetchAllCollectionItems(regionsCollectionId);
      console.log(`Loaded ${cmsCache.regions.length} regions`);
    }

    cmsCache.lastFetch = Date.now();
    console.log('CMS cache refreshed successfully');
    
  } catch (error) {
    console.error('Error refreshing CMS cache:', error);
  }
}

// ============================================
// HOTEL DATA HELPERS
// ============================================

function getHotelBySlug(slug) {
  const hotel = cmsCache.hotels.find(h => h.fieldData?.slug === slug);
  if (!hotel) return null;
  
  const f = hotel.fieldData;
  return {
    name: f.name || f['hotel-name'] || 'Unnamed',
    slug: f.slug,
    region: f.region || f.location || f['region-2'] || 'Portugal',
    description: f['short-description'] || f.description || f['meta-description'] || '',
    lat: parseFloat(f.latitude || f.lat) || null,
    lng: parseFloat(f.longitude || f.lng || f.lon) || null,
    image: f['cover-image']?.url || f.cover?.url || f['main-image']?.url || '',
    bookingUrl: f['booking-url'] || f['booking-link'] || f['show-prices-url'] || '',
    rooms: f['number-of-rooms'] || f.rooms || '',
    url: `https://joandso.com/hotels-portugal/${f.slug}`
  };
}

function getAllHotels() {
  return cmsCache.hotels
    .filter(h => h.fieldData && !h.fieldData.archived && !h.fieldData['is-closed'])
    .map(h => {
      const f = h.fieldData;
      return {
        name: f.name || f['hotel-name'] || 'Unnamed',
        slug: f.slug,
        region: f.region || f.location || f['region-2'] || 'Portugal',
        description: f['short-description'] || f.description || '',
        lat: parseFloat(f.latitude || f.lat) || null,
        lng: parseFloat(f.longitude || f.lng || f.lon) || null,
        image: f['cover-image']?.url || f.cover?.url || f['main-image']?.url || '',
        bookingUrl: f['booking-url'] || f['booking-link'] || f['show-prices-url'] || '',
        url: `https://joandso.com/hotels-portugal/${f.slug}`
      };
    });
}

// ============================================
// BUILD AI SYSTEM PROMPT
// ============================================

function buildSystemPrompt() {
  const hotels = getAllHotels();
  
  const hotelContext = hotels.slice(0, 100).map(h => 
    `- ${h.name} | region: ${h.region} | slug: ${h.slug}`
  ).join('\n');

  return `You are the JO&SO AI concierge - an interactive guide to Portugal's coolest boutique hotels, created by two Portuguese sisters, Joana and Sofia de Lacerda.

## YOUR ROLE
You control an interactive visual interface. When you respond, you trigger visual actions: showing hotel cards, moving the map. Keep text SHORT - the visuals do the talking.

## RESPONSE FORMAT
You MUST respond with valid JSON only:
{
  "message": "Short friendly text (1-3 sentences max)",
  "hotels": ["slug-1", "slug-2", "slug-3"],
  "mapAction": {"type": "flyTo", "lat": 38.72, "lng": -9.14, "zoom": 12}
}

Fields:
- "message": Short, warm response. Max 2-3 sentences. Like texting a friend.
- "hotels": Array of hotel slugs to show as cards (max 4-6). Use EXACT slugs from the database below.
- "mapAction": Where to fly the map. Set to null if no movement needed.

## BRAND VOICE
- Speak as "we" (two Portuguese sisters)
- Porto is "our hometown"
- British English (colour, favourite)
- NEVER use: luxury, resort, premium, sophisticated, blog
- Keep it SHORT - visuals do the work

## REGION COORDINATES (for mapAction)
- Lisbon: lat 38.7223, lng -9.1393, zoom 12
- Porto: lat 41.1579, lng -8.6291, zoom 12
- Algarve: lat 37.0179, lng -8.2500, zoom 9
- Alentejo: lat 38.5667, lng -7.9135, zoom 9
- Douro Valley: lat 41.1621, lng -7.5300, zoom 10
- Azores: lat 37.7412, lng -25.6687, zoom 8
- Madeira: lat 32.6669, lng -16.9595, zoom 10
- Comporta: lat 38.3799, lng -8.7849, zoom 11
- Central Portugal: lat 40.2033, lng -7.8659, zoom 9
- North Portugal: lat 41.6946, lng -8.2, zoom 9
- Portugal (overview): lat 39.5, lng -8.5, zoom 6.2

## HOTEL DATABASE (${hotels.length} properties)
${hotelContext}

## EXAMPLES

User: "Hotels in Lisbon with rooftop?"
Response:
{"message":"Rooftop moments in Lisbon are unbeatable! Here are our favourites with gorgeous terraces.","hotels":["memmo-alfama","memmo-principe-real","the-lumiares"],"mapAction":{"type":"flyTo","lat":38.7223,"lng":-9.1393,"zoom":12}}

User: "Where is the Douro Valley?"
Response:
{"message":"The Douro is in northern Portugal - a UNESCO wine region about 2 hours east of Porto. The terraced vineyards are stunning.","hotels":[],"mapAction":{"type":"flyTo","lat":41.1621,"lng":-7.5300,"zoom":10}}

User: "Something romantic in Alentejo"
Response:
{"message":"For romance in Alentejo, you can't go wrong with these. Rolling plains, cork forests, and that slow pace we love.","hotels":["sao-lourenco-do-barrocal","herdade-da-malhadinha-nova","sublime-comporta"],"mapAction":{"type":"flyTo","lat":38.5667,"lng":-7.9135,"zoom":9}}

User: "Hi!"
Response:
{"message":"Hello! We're Joana and Sofia - welcome to our guide. What kind of Portugal trip are you dreaming of?","hotels":[],"mapAction":null}

CRITICAL: Respond with valid JSON only. No markdown. No text outside the JSON.`;
}

// ============================================
// API ROUTES
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    cmsLoaded: cmsCache.hotels.length > 0,
    hotelCount: cmsCache.hotels.length,
    lastCacheUpdate: cmsCache.lastFetch
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    mapboxToken: MAPBOX_TOKEN || '',
    hasWebflow: !!WEBFLOW_API_TOKEN,
    hasClaude: !!ANTHROPIC_API_KEY,
    hotelCount: cmsCache.hotels.length
  });
});

app.get('/api/hotels', (req, res) => {
  res.json(getAllHotels());
});

app.get('/api/hotels/:slug', (req, res) => {
  const hotel = getHotelBySlug(req.params.slug);
  if (hotel) {
    res.json(hotel);
  } else {
    res.status(404).json({ error: 'Hotel not found' });
  }
});

app.post('/api/cms/refresh', async (req, res) => {
  await refreshCMSCache();
  res.json({ success: true, hotelCount: cmsCache.hotels.length });
});

// Main chat endpoint - returns structured JSON for visual interface
app.post('/api/chat', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  const { message, history = [] } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Refresh cache if stale
    if (!cmsCache.lastFetch || Date.now() - cmsCache.lastFetch > CACHE_DURATION) {
      await refreshCMSCache();
    }

    const messages = [
      ...history.slice(-10).map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: buildSystemPrompt(),
        messages: messages
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Anthropic API error:', errorData);
      return res.status(response.status).json({ error: errorData.error?.message || 'API error' });
    }

    const data = await response.json();
    const rawResponse = data.content[0]?.text || '';
    
    // Parse the JSON response
    let parsed;
    try {
      // Clean up potential markdown formatting
      let cleanJson = rawResponse.trim();
      if (cleanJson.startsWith('```json')) {
        cleanJson = cleanJson.slice(7);
      }
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.slice(3);
      }
      if (cleanJson.endsWith('```')) {
        cleanJson = cleanJson.slice(0, -3);
      }
      parsed = JSON.parse(cleanJson.trim());
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', rawResponse);
      // Fallback response
      parsed = {
        message: rawResponse.substring(0, 200) || "Let me help you find the perfect hotel in Portugal.",
        hotels: [],
        mapAction: null
      };
    }

    // Resolve hotel slugs to full hotel data
    const hotelCards = (parsed.hotels || [])
      .map(slug => getHotelBySlug(slug))
      .filter(h => h !== null);

    res.json({
      message: parsed.message || '',
      hotels: hotelCards,
      mapAction: parsed.mapAction || null,
      usage: data.usage
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat request' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, async () => {
  console.log(`JO&SO AI Concierge running on port ${PORT}`);
  console.log(`Webflow API: ${WEBFLOW_API_TOKEN ? 'Configured' : 'Not configured'}`);
  console.log(`Anthropic API: ${ANTHROPIC_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`Mapbox: ${MAPBOX_TOKEN ? 'Configured' : 'Not configured'}`);
  
  if (WEBFLOW_API_TOKEN) {
    await refreshCMSCache();
  }
});
