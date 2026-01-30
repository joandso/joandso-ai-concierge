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
    // Get all collections
    const collectionsData = await fetchWebflowCollections();
    const collections = collectionsData.collections || [];
    
    // Find relevant collections by name
    let hotelsCollectionId = null;
    let regionsCollectionId = null;
    let collectionsCollectionId = null;

    for (const collection of collections) {
      const name = (collection.displayName || collection.slug || '').toLowerCase();
      if (name.includes('hotel') && !name.includes('type')) {
        hotelsCollectionId = collection.id;
      } else if (name.includes('region') || name.includes('location')) {
        regionsCollectionId = collection.id;
      } else if (name === 'collections' || name.includes('collection')) {
        collectionsCollectionId = collection.id;
      }
    }

    console.log('Found collections:', { hotelsCollectionId, regionsCollectionId, collectionsCollectionId });

    // Fetch items from each collection
    if (hotelsCollectionId) {
      cmsCache.hotels = await fetchAllCollectionItems(hotelsCollectionId);
      console.log(`Loaded ${cmsCache.hotels.length} hotels`);
    }

    if (regionsCollectionId) {
      cmsCache.regions = await fetchAllCollectionItems(regionsCollectionId);
      console.log(`Loaded ${cmsCache.regions.length} regions`);
    }

    if (collectionsCollectionId) {
      cmsCache.collections = await fetchAllCollectionItems(collectionsCollectionId);
      console.log(`Loaded ${cmsCache.collections.length} collections`);
    }

    cmsCache.lastFetch = Date.now();
    console.log('CMS cache refreshed successfully');
    
  } catch (error) {
    console.error('Error refreshing CMS cache:', error);
  }
}

// ============================================
// BUILD AI CONTEXT FROM CMS DATA
// ============================================

function buildHotelContext() {
  if (cmsCache.hotels.length === 0) {
    return '';
  }

  const hotelSummaries = cmsCache.hotels
    .filter(hotel => hotel.fieldData && !hotel.fieldData.archived && !hotel.fieldData['is-closed'])
    .slice(0, 100) // Limit to avoid token overflow
    .map(hotel => {
      const f = hotel.fieldData;
      const name = f.name || f['hotel-name'] || 'Unnamed';
      const region = f.region || f.location || f['region-2'] || 'Portugal';
      const description = f['short-description'] || f.description || f['meta-description'] || '';
      const rooms = f['number-of-rooms'] || f.rooms || '';
      const slug = f.slug || '';
      
      let summary = `• ${name}`;
      if (region) summary += ` (${region})`;
      if (rooms) summary += ` - ${rooms} rooms`;
      if (description) summary += `: ${description.substring(0, 150)}`;
      if (slug) summary += ` [joandso.com/hotels-portugal/${slug}]`;
      
      return summary;
    })
    .join('\n');

  return `\n\n--- CURRENT HOTEL DATABASE (${cmsCache.hotels.length} properties) ---\n${hotelSummaries}`;
}

function buildSystemPrompt() {
  const basePrompt = `You are the JO&SO AI assistant, representing a curated Portuguese boutique hotel guide founded by two Portuguese sisters, Joana and Sofia de Lacerda in 2016.

Your role is to help travellers discover the coolest design-led boutique hotels across Portugal. You speak as "we" (representing the two sisters) with warmth, expertise, and authentic local knowledge.

## Brand Principles
- Selection criteria: beautiful design, thoughtful service, and good energy
- All properties are personally visited and handpicked
- No paid placements - complete editorial integrity
- Focus on boutique, design-led properties
- NEVER use words like "luxury", "resort", "premium", or "sophisticated"
- Use British English spelling (colour, centre, travelled, favourite)
- Refer to the website as "our guide" or "joandso.com", never "blog"

## Key Regions
- Lisbon: Chiado, Alfama, Príncipe Real, Baixa, Santos - "Portugal's vibrant capital"
- Porto: Ribeira, Baixa, Foz do Douro - "our hometown"
- Algarve: Lagos, Tavira, Faro, Aljezur - "golden cliffs and hidden coves"
- Alentejo: Comporta, Évora, Monsaraz, Melides - "cork forests and endless plains"
- Douro Valley: UNESCO wine region - "terraced vineyards and river views"
- Azores: São Miguel, Faial, Pico - "volcanic islands in the Atlantic"
- Madeira: Funchal - "subtropical gardens and dramatic cliffs"
- Central Portugal: Serra da Estrela, Monsanto - "schist villages and mountain retreats"
- North Portugal: Minho, Viana do Castelo - "green valleys and historic towns"

## Response Guidelines
- Be specific about what makes each property special
- Mention design elements, atmosphere, and standout features
- Share insider tips when relevant
- Keep responses warm but concise (2-4 paragraphs typically)
- When recommending hotels, include the URL: joandso.com/hotels-portugal/[slug]
- If asked about hotels you don't have data for, direct users to joandso.com to explore
- Never make up hotel details - if you're not sure, say so

## Personality
- Friendly and knowledgeable, like advising a friend planning a trip
- Passionate about Portuguese design and hospitality
- Honest - mention if a place might not suit certain travellers
- Curious about what the traveller is looking for`;

  // Add hotel data if available
  const hotelContext = buildHotelContext();
  
  return basePrompt + hotelContext + `

Use this database to provide accurate, specific recommendations. Reference actual hotels from our collection when answering questions. Always prioritise hotels we've personally visited and featured.`;
}

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    cmsLoaded: cmsCache.hotels.length > 0,
    hotelCount: cmsCache.hotels.length,
    lastCacheUpdate: cmsCache.lastFetch
  });
});

// Get config (public tokens only)
app.get('/api/config', (req, res) => {
  res.json({
    mapboxToken: MAPBOX_TOKEN || '',
    hasWebflow: !!WEBFLOW_API_TOKEN,
    hasClaude: !!ANTHROPIC_API_KEY,
    hotelCount: cmsCache.hotels.length
  });
});

// Get CMS stats
app.get('/api/cms/stats', (req, res) => {
  res.json({
    hotels: cmsCache.hotels.length,
    regions: cmsCache.regions.length,
    collections: cmsCache.collections.length,
    lastFetch: cmsCache.lastFetch,
    cacheAge: cmsCache.lastFetch ? Date.now() - cmsCache.lastFetch : null
  });
});

// Force cache refresh
app.post('/api/cms/refresh', async (req, res) => {
  await refreshCMSCache();
  res.json({ 
    success: true, 
    hotelCount: cmsCache.hotels.length 
  });
});

// Chat endpoint
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

    // Build messages array with history
    const messages = [
      ...history.map(msg => ({
        role: msg.role,
        content: msg.content
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
    
    res.json({
      response: data.content[0]?.text || 'I couldn\'t generate a response.',
      usage: data.usage
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat request' });
  }
});

// Get hotels for map markers
app.get('/api/hotels/markers', (req, res) => {
  const markers = cmsCache.hotels
    .filter(hotel => {
      const f = hotel.fieldData;
      return f && !f.archived && !f['is-closed'];
    })
    .map(hotel => {
      const f = hotel.fieldData;
      return {
        name: f.name || f['hotel-name'] || 'Unnamed',
        slug: f.slug,
        region: f.region || f.location || 'Portugal',
        lat: f.latitude || f.lat,
        lng: f.longitude || f.lng || f.lon,
        image: f['cover-image']?.url || f.cover?.url || f['main-image']?.url
      };
    })
    .filter(h => h.lat && h.lng);

  res.json(markers);
});

// Serve the main page
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
  
  // Initial cache load
  if (WEBFLOW_API_TOKEN) {
    await refreshCMSCache();
  }
});
