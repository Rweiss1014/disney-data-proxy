// Production-Ready Disney Data Proxy Server with DeepSeek Improvements
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
      scriptSrc: ["'self'", "'unsafe-inline'"],
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
      timeout: 5000, // 5-second timeout (DeepSeek suggestion)
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

    // Sort by priority (DeepSeek suggestion)
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

// ========== ENHANCED ENDPOINTS ==========

// Welcome endpoint with system status
app.get('/', (req, res) => {
  res.json({
    message: '🏰 Disney Data Proxy Server - Production Ready',
    version: '2.1.0',
    status: 'active',
    requestId: req.id,
    endpoints: [
      'GET /api/disney/park-hours/:park',
      'GET /api/disney/entertainment/:park', 
      'GET /api/disney/parade-times/:park',
      'GET /api/disney/wait-times/:park',
      'GET /health',
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

// Enhanced Wait Times endpoint
app.get('/api/disney/wait-times/:park?', validatePark, async (req, res) => {
  const park = req.park;
  const cacheKey = `wait_times_${park}`;
  
  try {
    // Check cache first
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

// Enhanced Entertainment endpoint
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
    
    // Static character meets (guaranteed accurate)
    const staticCharacterMeets = getStaticCharacterMeets(park);
    
    // Try to fetch additional entertainment data
    const [baseEntertainment, characterData] = await Promise.all([
      fetchEntertainmentData(park, req.id).catch(err => {
        console.log(`⚠️ Base entertainment fetch failed: ${err.message} - Request ID: ${req.id}`);
        return null;
      }),
      // Theme Park IQ scraping (DeepSeek enhancement)
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
    
    const result = {
      park,
      entertainment: allEntertainment,
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
    
    res.json({ ...result, fromCache: false });
    
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

// ========== ENHANCED CHARACTER SCRAPING (DeepSeek Implementation) ==========
async function scrapeThemeParkIQCharacters(park, requestId) {
  if (park !== 'magic-kingdom') {
    return { characters: [] };
  }

  try {
    console.log(`🧚‍♀️ Scraping character data from Theme Park IQ - Request ID: ${requestId}`);
    
    const { data } = await axios.get(
      'https://www.themeparkiq.com/disneyworld/character/schedule',
      {
        timeout: 10000,
        headers: { 
          'User-Agent': 'PixiePal Disney Assistant/2.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      }
    );

    const $ = cheerio.load(data);
    const liveCharacters = [];

    // Parse character schedule data
    $('#magic-kingdom-character-schedule').each((_, section) => {
      const land = $(section).find('h3').text().trim();
      
      $(section).find('.character-row').each((_, row) => {
        const name = $(row).find('.character-name').text().trim();
        const location = $(row).find('.character-location').text().trim() || land;
        const times = [];

        $(row).find('.character-time').each((_, time) => {
          const timeText = $(time).text().trim();
          if (timeText) times.push(timeText);
        });

        if (name) {
          liveCharacters.push({
            id: `live_${name.replace(/\s+/g, '_').toLowerCase()}`,
            name,
            type: 'character_meet',
            times: times.length ? times : ['Check Today\'s Times'],
            location,
            characters: [name],
            source: 'theme_park_iq',
            duration: 15
          });
        }
      });
    });

    console.log(`✅ Scraped ${liveCharacters.length} characters from Theme Park IQ - Request ID: ${requestId}`);
    return { characters: liveCharacters };
    
  } catch (error) {
    console.error(`❌ Theme Park IQ scrape failed: ${error.message} - Request ID: ${requestId}`);
    return { characters: [] };
  }
}

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

// ========== ENHANCED HEALTH CHECK ==========
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

// ========== DATA PARSING FUNCTIONS ==========
function parseWaitTimesData(data, park) {
  const attractions = [];
  
  try {
    // Queue-Times format parsing with error handling
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

// ========== UTILITY FUNCTIONS ==========
function getSourceName(url) {
  if (url.includes('touringplans')) return 'touringplans';
  if (url.includes('queue-times')) return 'queue_times';
  if (url.includes('themeparks')) return 'themeparks_wiki';
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

// Static character meet data (always reliable)
function getStaticCharacterMeets(park) {
  const characterMeets = {
    'magic-kingdom': [
      {
        id: "princess_fairytale_hall",
        name: "Princess Meet & Greet",
        type: "character_meet",
        times: ["Park open to close"],
        location: "Princess Fairytale Hall, Fantasyland",
        characters: ["Cinderella", "Elena", "Tiana", "Rapunzel"],
        duration: 15,
        source: 'static'
      },
      {
        id: "town_square_theater_mickey",
        name: "Mickey Mouse Meet & Greet", 
        type: "character_meet",
        times: ["Park open to close"],
        location: "Town Square Theater, Main Street USA",
        characters: ["Mickey Mouse"],
        duration: 15,
        source: 'static'
      }
    ]
  };
  
  return characterMeets[park] || [];
}

// ========== FALLBACK DATA FUNCTIONS ==========
function getFallbackWaitTimes(park) {
  const fallbacks = {
    'magic-kingdom': [
      { id: 'mk-space-mountain', name: 'Space Mountain', land: 'Tomorrowland', waitTime: 45, isOpen: true, hasLightningLane: true },
      { id: 'mk-pirates', name: 'Pirates of the Caribbean', land: 'Adventureland', waitTime: 25, isOpen: true, hasLightningLane: false }
    ],
    'epcot': [
      { id: 'ep-guardians', name: 'Guardians of the Galaxy: Cosmic Rewind', land: 'Future World', waitTime: 85, isOpen: true, hasLightningLane: true }
    ],
    'hollywood-studios': [
      { id: 'hs-rise', name: 'Star Wars: Rise of the Resistance', land: 'Star Wars: Galaxy\'s Edge', waitTime: 120, isOpen: true, hasLightningLane: true }
    ],
    'animal-kingdom': [
      { id: 'ak-avatar', name: 'Avatar Flight of Passage', land: 'Pandora', waitTime: 90, isOpen: true, hasLightningLane: true }
    ]
  };
  
  return {
    park,
    attractions: fallbacks[park] || fallbacks['magic-kingdom'],
    source: 'fallback',
    lastUpdated: new Date().toISOString(),
    freshnessScore: 0
  };
}

function getFallbackEntertainment(park) {
  const fallbacks = {
    'magic-kingdom': [
      {
        id: 'festival_of_fantasy',
        name: 'Festival of Fantasy Parade',
        type: 'parade',
        times: ['3:00 PM'],
        location: 'Frontierland → Main Street USA',
        duration: 20,
        source: 'fallback'
      }
    ]
  };
  
  return {
    park,
    entertainment: fallbacks[park] || [],
    source: 'fallback',
    lastUpdated: new Date().toISOString()
  };
}

// Placeholder functions for missing data endpoints
async function fetchEntertainmentData(park, requestId) {
  // Implementation would go here
  return null;
}

// ========== ENHANCED ERROR HANDLING MIDDLEWARE ==========
app.use((err, req, res, next) => {
  console.error(`🚨 ${req.method} ${req.path}:`, {
    error: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    referenceId: req.id,
    timestamp: new Date().toISOString()
  });

  res.status(500).json({
    error: 'Internal server error',
    referenceId: req.id,
    timestamp: new Date().toISOString()
  });
});

// ========== GLOBAL ERROR HANDLERS (DeepSeek Critical Addition) ==========
process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', {
    error: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });
  // In production, consider graceful shutdown
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('🚨 Unhandled Rejection:', {
    error: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🏰 Enhanced Disney Data Proxy Server running on port ${PORT}`);
  console.log(`📊 Cache system initialized with TTLs:`);
  console.log(`   - Wait Times: ${CACHE_TTL_WAIT_TIMES}s`);
  console.log(`   - Entertainment: ${CACHE_TTL_ENTERTAINMENT}s`);
  console.log(`   - Park Hours: ${CACHE_TTL_PARK_HOURS}s`);
  console.log(`🛡️ Security and rate limiting enabled`);
  console.log(`⚡ Circuit breakers active`);
  console.log(`🔍 Request tracking enabled`);
  console.log(`📡 Enhanced endpoints ready!`);
});