// Production-Ready Disney Data Proxy Server v3.0
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const helmet = require('helmet');
const cheerio = require('cheerio');
const CircuitBreaker = require('opossum');
const { v4: uuidv4 } = require('uuid');

const app = express();

// ========== ENHANCED SECURITY & MIDDLEWARE ==========
app.set('trust proxy', 1);

// Enhanced Helmet Configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

app.use(express.json({ limit: '10mb' }));

// Request ID Middleware (CRITICAL for debugging)
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  console.log(`📝 ${req.method} ${req.path} - Request ID: ${req.id}`);
  next();
});

// Enhanced CORS with Production Domains
app.use(cors({
  origin: [
    'http://localhost:8081',
    'https://your-pixie-pal-app.vercel.app',
    /^https:\/\/.*\.vercel\.app$/,
    /^exp:\/\/.*/, // Expo development
    /^https:\/\/.*\.netlify\.app$/,
    'https://your-production-domain.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID']
}));

// ========== ENHANCED CACHING SYSTEM ==========
// Environment-based cache configuration
const CACHE_TTL_PARK_HOURS = process.env.CACHE_TTL_PARK_HOURS || 3600; // 1 hour
const CACHE_TTL_ENTERTAINMENT = process.env.CACHE_TTL_ENTERTAINMENT || 1800; // 30 minutes  
const CACHE_TTL_WAIT_TIMES = process.env.CACHE_TTL_WAIT_TIMES || 300; // 5 minutes

const caches = {
  parkHours: new NodeCache({ stdTTL: CACHE_TTL_PARK_HOURS, checkperiod: 600 }),
  entertainment: new NodeCache({ stdTTL: CACHE_TTL_ENTERTAINMENT, checkperiod: 300 }),
  waitTimes: new NodeCache({ stdTTL: CACHE_TTL_WAIT_TIMES, checkperiod: 60 })
};

// Data freshness tracking (DeepSeek suggestion)
const dataState = {
  lastSuccessfulFetch: {
    parkHours: null,
    entertainment: null,
    waitTimes: null
  },
  errorCounts: {
    parkHours: 0,
    entertainment: 0,
    waitTimes: 0
  }
};

// ========== ENHANCED RATE LIMITING ==========
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Per IP
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    console.log(`🚫 Rate limit exceeded for IP: ${req.ip} - Request ID: ${req.id}`);
    res.status(429).json({
      error: 'Too many requests',
      referenceId: req.id,
      retryAfter: '15 minutes'
    });
  }
});

app.use('/api/', apiLimiter);

// ========== INPUT VALIDATION ==========
const validParks = ['magic-kingdom', 'epcot', 'hollywood-studios', 'animal-kingdom'];

const validatePark = (req, res, next) => {
  const park = req.params.park || 'magic-kingdom';
  if (!validParks.includes(park)) {
    console.log(`❌ Invalid park parameter: ${park} - Request ID: ${req.id}`);
    return res.status(400).json({
      error: `Invalid park. Valid parks are: ${validParks.join(', ')}`,
      referenceId: req.id,
      validParks: validParks
    });
  }
  req.park = park;
  next();
};

// ========== ENHANCED NETWORKING WITH RETRY & TIMEOUT ==========
const fetchWithRetry = async (url, options = {}, retries = 2) => {
  const requestId = options.requestId || 'unknown';
  
  try {
    console.log(`🌐 Fetching: ${url} (${retries + 1} attempts left) - Request ID: ${requestId}`);
    
    const response = await axios.get(url, {
      timeout: 5000, // 5-second timeout
      headers: {
        'User-Agent': 'PixiePal Disney Companion App/2.0 (+https://pixiepal.app)',
        'Accept': 'application/json',
        ...options.headers
      }
    });
    
    if (response.data) {
      console.log(`✅ Successful fetch: ${url} - Request ID: ${requestId}`);
      return response;
    }
    throw new Error(`No data received from ${url}`);
    
  } catch (error) {
    console.log(`❌ Fetch failed: ${url} - ${error.message} - Request ID: ${requestId}`);
    
    if (retries > 0) {
      console.log(`🔄 Retrying ${url} (${retries} left) - Request ID: ${requestId}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
};

// ========== CIRCUIT BREAKER IMPLEMENTATION ==========
const circuitBreakerOptions = {
  timeout: 5000, // 5 seconds
  errorThresholdPercentage: 50,
  resetTimeout: 30000 // 30 seconds
};

// Wait Times Circuit Breaker
const waitTimesBreaker = new CircuitBreaker(
  async (park, requestId) => {
    const sources = [
      { 
        url: `https://queue-times.com/parks/${getParkId(park)}/queue_times.json`, 
        priority: 1, 
        timeout: 3000 
      },
      { 
        url: `https://touringplans.com/${park}/wait-times.json`, 
        priority: 2, 
        timeout: 5000 
      }
    ];

    // Sort by priority
    sources.sort((a, b) => a.priority - b.priority);

    for (const { url, timeout } of sources) {
      try {
        const response = await fetchWithRetry(
          url, 
          { timeout, requestId }, 
          1 // Only 1 retry for circuit breaker
        );
        
        dataState.lastSuccessfulFetch.waitTimes = new Date();
        dataState.errorCounts.waitTimes = 0;
        
        return {
          park,
          attractions: parseWaitTimesData(response.data, park),
          source: getSourceName(url),
          lastUpdated: new Date().toISOString(),
          freshnessScore: 100
        };
      } catch (error) {
        console.log(`❌ Failed source: ${url} - ${error.message} - Request ID: ${requestId}`);
        dataState.errorCounts.waitTimes++;
        continue;
      }
    }
    throw new Error('All wait time sources failed');
  },
  circuitBreakerOptions
);

// Circuit breaker fallback
waitTimesBreaker.fallback(async (park, requestId) => {
  console.log(`🔧 Circuit breaker fallback for ${park} - Request ID: ${requestId}`);
  return getFallbackWaitTimes(park);
});

// ========== ENDPOINTS ==========

// Welcome endpoint with system status
app.get('/', (req, res) => {
  res.json({
    message: '🏰 Disney Data Proxy Server - Production Ready',
    version: '3.0.0',
    status: 'active',
    requestId: req.id,
    endpoints: [
      'GET /api/disney/park-hours/:park',
      'GET /api/disney/entertainment/:park', 
      'GET /api/disney/wait-times/:park',
      'GET /health',
      'GET /debug/themeparkiq',
      'GET /debug/static-characters/:park',
      'GET /api/cache/status',
      'POST /api/cache/reset/:type'
    ],
    lastUpdated: new Date().toISOString(),
    dataState: {
      lastSuccessfulFetch: dataState.lastSuccessfulFetch,
      errorCounts: dataState.errorCounts
    }
  });
});

// ========== PARK HOURS ENDPOINT (FIXED) ==========
app.get('/api/disney/park-hours/:park', validatePark, async (req, res) => {
  const park = req.park;
  const cacheKey = `park_hours_${park}`;
  
  try {
    // Check cache first
    const cached = caches.parkHours.get(cacheKey);
    if (cached) {
      console.log(`💾 Cache hit for park hours: ${park} - Request ID: ${req.id}`);
      return res.json({ 
        ...cached, 
        fromCache: true,
        requestId: req.id
      });
    }

    console.log(`🕐 Fetching park hours for ${park} - Request ID: ${req.id}`);
    
    // Static park hours (would be replaced with real data source in production)
    const parkHoursData = {
      'magic-kingdom': {
        date: new Date().toISOString().split('T')[0],
        openingTime: '09:00',
        closingTime: '23:00',
        type: 'Operating',
        park: 'Magic Kingdom',
        specialHours: null,
        lastUpdated: new Date().toISOString()
      },
      'epcot': {
        date: new Date().toISOString().split('T')[0],
        openingTime: '09:00',
        closingTime: '21:00',
        type: 'Operating',
        park: 'EPCOT',
        specialHours: null,
        lastUpdated: new Date().toISOString()
      },
      'hollywood-studios': {
        date: new Date().toISOString().split('T')[0],
        openingTime: '09:00',
        closingTime: '21:00',
        type: 'Operating',
        park: 'Hollywood Studios',
        specialHours: null,
        lastUpdated: new Date().toISOString()
      },
      'animal-kingdom': {
        date: new Date().toISOString().split('T')[0],
        openingTime: '08:00',
        closingTime: '20:00',
        type: 'Operating',
        park: 'Animal Kingdom',
        specialHours: null,
        lastUpdated: new Date().toISOString()
      }
    };
    
    const hoursData = parkHoursData[park] || parkHoursData['magic-kingdom'];
    
    // Cache the result
    caches.parkHours.set(cacheKey, hoursData);
    dataState.lastSuccessfulFetch.parkHours = new Date();
    
    res.json({ 
      ...hoursData,
      fromCache: false,
      requestId: req.id
    });
    
  } catch (error) {
    console.error(`❌ Park hours error for ${park}: ${error.message} - Request ID: ${req.id}`);
    res.status(500).json({
      error: 'Failed to fetch park hours',
      referenceId: req.id,
      fallback: {
        date: new Date().toISOString().split('T')[0],
        openingTime: '09:00',
        closingTime: '21:00',
        type: 'Operating',
        park: park
      }
    });
  }
});

// ========== WAIT TIMES ENDPOINT ==========
app.get('/api/disney/wait-times/:park?', validatePark, async (req, res) => {
  const park = req.park;
  const cacheKey = `wait_times_${park}`;
  
  try {
    const cached = caches.waitTimes.get(cacheKey);
    if (cached) {
      console.log(`💾 Cache hit for wait times: ${park} - Request ID: ${req.id}`);
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
      return res.json({ 
        ...cached, 
        fromCache: true,
        requestId: req.id
      });
    }

    console.log(`🎢 Fetching wait times for ${park} - Request ID: ${req.id}`);
    const waitTimesData = await waitTimesBreaker.fire(park, req.id);
    
    if (waitTimesData) {
      caches.waitTimes.set(cacheKey, waitTimesData);
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
      res.json({ 
        ...waitTimesData, 
        fromCache: false,
        requestId: req.id
      });
    } else {
      throw new Error('No wait times data available');
    }
    
  } catch (error) {
    console.error(`❌ Wait times error for ${park}: ${error.message} - Request ID: ${req.id}`);
    const fallback = getFallbackWaitTimes(park);
    res.status(500).json({
      error: 'Failed to fetch wait times',
      fallback,
      referenceId: req.id,
      source: 'fallback'
    });
  }
});

// ========== ENTERTAINMENT ENDPOINT (ENHANCED FOR OPENAI) ==========
app.get('/api/disney/entertainment/:park?', validatePark, async (req, res) => {
  const park = req.park;
  const cacheKey = `entertainment_${park}`;
  
  try {
    const cached = caches.entertainment.get(cacheKey);
    if (cached) {
      console.log(`💾 Cache hit for entertainment: ${park} - Request ID: ${req.id}`);
      return res.json({ 
        ...cached, 
        fromCache: true,
        requestId: req.id
      });
    }

    console.log(`🎭 Fetching entertainment for ${park} - Request ID: ${req.id}`);
    
    // Static character meets
    const staticCharacterMeets = getStaticCharacterMeets(park);
    
    // Try to fetch additional entertainment data
    const [baseEntertainment, characterData] = await Promise.all([
      fetchEntertainmentData(park, req.id).catch(err => {
        console.log(`⚠️ Base entertainment fetch failed: ${err.message} - Request ID: ${req.id}`);
        return null;
      }),
      scrapeThemeParkIQCharacters(park, req.id).catch(err => {
        console.log(`⚠️ Character scraping failed: ${err.message} - Request ID: ${req.id}`);
        return { characters: [] };
      })
    ]);
    
    let allEntertainment = [...staticCharacterMeets];
    
    if (baseEntertainment?.entertainment) {
      allEntertainment.push(...baseEntertainment.entertainment);
    }
    if (characterData?.characters) {
      allEntertainment.push(...characterData.characters);
    }
    
    if (allEntertainment.length === 0) {
      allEntertainment = getFallbackEntertainment(park).entertainment;
    }
    
    // FORMAT FOR OPENAI CONTEXT
    const characterMeetData = allEntertainment
      .filter(item => item.type === 'character_meet')
      .map(meet => ({
        id: meet.id,
        name: meet.name,
        type: meet.type,
        times: meet.times,
        location: meet.location,
        characters: meet.characters,
        duration: meet.duration
      }));
    
    const result = {
      park,
      entertainment: allEntertainment,
      characterMeets: characterMeetData, // Special OpenAI-friendly format
      sources: {
        base: baseEntertainment?.source || 'fallback',
        characters: characterData?.characters?.length > 0 ? 'theme_park_iq' : 'static',
        staticCount: staticCharacterMeets.length
      },
      totalItems: allEntertainment.length,
      lastUpdated: new Date().toISOString(),
      requestId: req.id
    };
    
    caches.entertainment.set(cacheKey, result);
    dataState.lastSuccessfulFetch.entertainment = new Date();
    
    res.json(result);
    
  } catch (error) {
    console.error(`❌ Entertainment error for ${park}: ${error.message} - Request ID: ${req.id}`);
    const fallback = getFallbackEntertainment(park);
    res.status(500).json({
      error: 'Failed to fetch entertainment data',
      fallback,
      referenceId: req.id
    });
  }
});

// ========== DEBUG ENDPOINTS ==========
app.get('/debug/themeparkiq', async (req, res) => {
  try {
    console.log(`🐛 DEBUG: Testing ThemeParkIQ scraper - Request ID: ${req.id}`);
    
    const startTime = Date.now();
    const result = await scrapeThemeParkIQCharacters('magic-kingdom', req.id);
    const duration = Date.now() - startTime;
    
    const debugInfo = {
      success: result.characters.length > 0,
      characterCount: result.characters.length,
      duration: `${duration}ms`,
      sampleCharacters: result.characters.slice(0, 3),
      allCharacters: result.characters,
      timestamp: new Date().toISOString(),
      requestId: req.id
    };
    
    console.log(`🐛 DEBUG RESULT: ${result.characters.length} characters found in ${duration}ms - Request ID: ${req.id}`);
    
    res.json(debugInfo);
    
  } catch (error) {
    console.error(`🐛 DEBUG ERROR: ${error.message} - Request ID: ${req.id}`);
    res.status(500).json({
      error: 'Debug endpoint failed',
      message: error.message,
      requestId: req.id
    });
  }
});

app.get('/debug/static-characters/:park?', validatePark, (req, res) => {
  const park = req.park;
  const staticData = getStaticCharacterMeets(park);
  
  res.json({
    park,
    staticCharacterCount: staticData.length,
    characters: staticData,
    requestId: req.id
  });
});

// ========== CACHE MANAGEMENT ENDPOINTS ==========
app.post('/api/cache/reset/:type', (req, res) => {
  const { type } = req.params;
  
  if (caches[type]) {
    const keyCount = caches[type].keys().length;
    caches[type].flushAll();
    
    console.log(`🗑️ Cache cleared: ${type} (${keyCount} keys) - Request ID: ${req.id}`);
    res.json({ 
      status: `${type} cache cleared`,
      clearedKeys: keyCount,
      timestamp: new Date().toISOString(),
      requestId: req.id
    });
  } else {
    res.status(400).json({ 
      error: 'Invalid cache type',
      validTypes: Object.keys(caches),
      referenceId: req.id
    });
  }
});

app.get('/api/cache/status', (req, res) => {
  res.json({
    caches: {
      parkHours: { 
        keys: caches.parkHours.keys().length, 
        stats: caches.parkHours.getStats() 
      },
      entertainment: { 
        keys: caches.entertainment.keys().length, 
        stats: caches.entertainment.getStats() 
      },
      waitTimes: { 
        keys: caches.waitTimes.keys().length, 
        stats: caches.waitTimes.getStats() 
      }
    },
    dataState,
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

// ========== HEALTH CHECK ENDPOINT ==========
app.get('/health', (req, res) => {
  const status = {
    status: 'OK',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    caches: {
      parkHours: caches.parkHours.keys().length,
      entertainment: caches.entertainment.keys().length,
      waitTimes: caches.waitTimes.keys().length
    },
    lastSuccessfulFetch: dataState.lastSuccessfulFetch,
    errorCounts: dataState.errorCounts,
    circuitBreaker: {
      waitTimes: {
        state: waitTimesBreaker.state,
        stats: waitTimesBreaker.stats
      }
    },
    timestamp: new Date().toISOString(),
    requestId: req.id
  };
  
  res.status(200).json(status);
});

// ========== CHARACTER SCRAPING FUNCTION ==========
async function scrapeThemeParkIQCharacters(park, requestId) {
  if (park !== 'magic-kingdom') {
    return { characters: [] };
  }

  try {
    console.log(`🧚‍♀️ Starting ThemeParkIQ scrape for ${park} - Request ID: ${requestId}`);
    
    // Network reachability check
    try {
      await axios.head('https://www.themeparkiq.com', { timeout: 5000 });
      console.log(`✅ ThemeParkIQ site reachable - Request ID: ${requestId}`);
    } catch (headError) {
      throw new Error(`Site unreachable: ${headError.message}`);
    }

    // Make request with enhanced headers
    const response = await axios.get(
      'https://www.themeparkiq.com/disneyworld/character/schedule',
      {
        timeout: 15000,
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.google.com/',
          'DNT': '1'
        },
        validateStatus: () => true
      }
    );

    // Response diagnostics
    console.log(`📊 ThemeParkIQ Response: ${response.status} ${response.statusText}`);
    console.log(`📏 Response size: ${response.data.length} bytes - Request ID: ${requestId}`);
    
    // Check for blocking
    if (response.status === 403) throw new Error('HTTP 403 Forbidden');
    if (response.status === 429) throw new Error('HTTP 429 Too Many Requests');
    if (response.data.includes('Access Denied')) throw new Error('Blocked by access control');
    if (response.status !== 200) throw new Error(`Unexpected HTTP status: ${response.status}`);

    const $ = cheerio.load(response.data);
    const liveCharacters = [];

    // Parse character data
    $('.character-schedule-container').each((_, container) => {
      const parkName = $(container).find('h2, h3').text().trim();
      if (!parkName.toLowerCase().includes('magic kingdom')) return;
      
      $(container).find('.character-card, .character-schedule').each((_, card) => {
        const name = $(card).find('.character-name').text().trim();
        const location = $(card).find('.character-location').text().trim();
        const times = [];
        
        $(card).find('.character-time-slot, .character-time, .time').each((_, slot) => {
          const timeText = $(slot).text().trim();
          if (timeText) times.push(timeText);
        });
        
        if (name) {
          liveCharacters.push({
            id: `live_${name.replace(/\W+/g, '_').toLowerCase()}`,
            name,
            type: 'character_meet',
            times: times.length ? times : ['Check Times'],
            location: location || 'Magic Kingdom',
            characters: [name],
            source: 'theme_park_iq',
            duration: 20
          });
        }
      });
    });

    console.log(`✅ ThemeParkIQ scrape completed: ${liveCharacters.length} characters found - Request ID: ${requestId}`);
    return { characters: liveCharacters };
    
  } catch (error) {
    console.error(`❌ ThemeParkIQ scrape FAILED: ${error.message} - Request ID: ${requestId}`);
    return { characters: [] };
  }
}

// ========== UTILITY FUNCTIONS ==========
function parseWaitTimesData(data, park) {
  const attractions = [];
  
  try {
    if (data.lands && Array.isArray(data.lands)) {
      data.lands.forEach(land => {
        if (land.rides && Array.isArray(land.rides)) {
          land.rides.forEach(ride => {
            attractions.push({
              id: `${park}-${ride.id}`,
              name: ride.name,
              land: land.name,
              waitTime: ride.wait_time || 0,
              isOpen: ride.is_open || false,
              hasLightningLane: ride.fast_pass || false,
              lastUpdated: ride.last_updated || new Date().toISOString()
            });
          });
        }
      });
    }
  } catch (error) {
    console.error(`Error parsing wait times data for ${park}:`, error);
    return [];
  }
  
  return attractions;
}

function getSourceName(url) {
  if (url.includes('touringplans')) return 'touringplans';
  if (url.includes('queue-times')) return 'queue_times';
  return 'unknown';
}

function getParkId(park) {
  const ids = {
    'magic-kingdom': 6,
    'epcot': 5,
    'hollywood-studios': 7,
    'animal-kingdom': 8
  };
  return ids[park] || 6;
}

// ========== STATIC CHARACTER DATA ==========
function getStaticCharacterMeets(park) {
  const characterMeets = {
    'magic-kingdom': [
      {
        id: "princess_fairytale_hall",
        name: "Princess Fairytale Hall",
        type: "character_meet",
        times: ["9:00 AM - Park Close"],
        location: "Fantasyland",
        characters: ["Cinderella", "Elena", "Tiana", "Rapunzel"],
        duration: 15,
        source: 'static'
      },
      {
        id: "town_square_theater_mickey",
        name: "Mickey Mouse Meet", 
        type: "character_meet",
        times: ["9:00 AM - Park Close"],
        location: "Town Square Theater",
        characters: ["Mickey Mouse"],
        duration: 15,
        source: 'static'
      },
      {
        id: "petes_silly_sideshow",
        name: "Pete's Silly Sideshow",
        type: "character_meet",
        times: ["10:00 AM - 6:00 PM"],
        location: "Storybook Circus",
        characters: ["Goofy", "Donald", "Minnie", "Daisy"],
        duration: 15,
        source: 'static'
      },
      {
        id: "tinker_bell_nook",
        name: "Tinker Bell's Magical Nook", 
        type: "character_meet",
        times: ["9:00 AM - 5:00 PM"],
        location: "Main Street, USA",
        characters: ["Tinker Bell"],
        duration: 15,
        source: 'static'
      },
      {
        id: "enchanted_tales_belle",
        name: "Enchanted Tales with Belle",
        type: "character_meet",
        times: ["10:00 AM - 8:00 PM"],
        location: "Fantasyland",
        characters: ["Belle"],
        duration: 20,
        source: 'static'
      }
    ],
    'epcot': [
      {
        id: "epcot_character_spot",
        name: "Character Spot",
        type: "character_meet",
        times: ["11:00 AM - 5:00 PM"],
        location: "Future World",
        characters: ["Mickey", "Minnie", "Goofy"],
        duration: 15,
        source: 'static'
      }
    ],
    'hollywood-studios': [
      {
        id: "red_carpet_dreams",
        name: "Red Carpet Dreams",
        type: "character_meet",
        times: ["9:30 AM - 7:00 PM"],
        location: "Commissary Lane",
        characters: ["Mickey", "Minnie"],
        duration: 15,
        source: 'static'
      }
    ],
    'animal-kingdom': [
      {
        id: "adventure_outpost",
        name: "Adventure Outpost",
        type: "character_meet",
        times: ["10:00 AM - 4:30 PM"],
        location: "Discovery Island",
        characters: ["Mickey", "Minnie"],
        duration: 15,
        source: 'static'
      }
    ]
  };
  return characterMeets[park] || [];
}

// ========== FALLBACK DATA ==========
function getFallbackWaitTimes(park) {
  const fallbacks = {
    'magic-kingdom': [
      { id: 'mk-space-mountain', name: 'Space Mountain', land: 'Tomorrowland', waitTime: 45, isOpen: true },
      { id: 'mk-pirates', name: 'Pirates', land: 'Adventureland', waitTime: 25, isOpen: true }
    ],
    'epcot': [
      { id: 'ep-guardians', name: 'Guardians', land: 'Future World', waitTime: 85, isOpen: true }
    ],
    'hollywood-studios': [
      { id: 'hs-rise', name: 'Rise of Resistance', land: 'Galaxy\'s Edge', waitTime: 120, isOpen: true }
    ],
    'animal-kingdom': [
      { id: 'ak-avatar', name: 'Flight of Passage', land: 'Pandora', waitTime: 90, isOpen: true }
    ]
  };
  return {
    park,
    attractions: fallbacks[park] || [],
    source: 'fallback',
    lastUpdated: new Date().toISOString()
  };
}

function getFallbackEntertainment(park) {
  return {
    park,
    entertainment: [
      {
        id: 'parade_fallback',
        name: 'Parade',
        type: 'parade',
        times: ['3:00 PM'],
        location: 'Main Street',
        duration: 20,
        source: 'fallback'
      }
    ],
    source: 'fallback',
    lastUpdated: new Date().toISOString()
  };
}

// Placeholder functions
async function fetchEntertainmentData(park, requestId) {
  return null;
}

// ========== ERROR HANDLING ==========
app.use((err, req, res, next) => {
  console.error(`🚨 ${req.method} ${req.path}:`, {
    error: err.message,
    referenceId: req.id,
    timestamp: new Date().toISOString()
  });
  res.status(500).json({
    error: 'Internal server error',
    referenceId: req.id
  });
});

process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('🚨 Unhandled Rejection:', err);
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏰 Disney Data Proxy Server running on port ${PORT}`);
  console.log(`📊 Cache TTLs: WT:${CACHE_TTL_WAIT_TIMES}s, ENT:${CACHE_TTL_ENTERTAINMENT}s`);
  console.log(`🛡️ Security enabled`);
  console.log(`⚡ Circuit breakers active`);
});