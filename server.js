// Disney Data Proxy Server - Render Deployment Ready
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const helmet = require('helmet');

const app = express();

// ========== SECURITY & MIDDLEWARE ==========
app.use(helmet());
app.use(express.json());

// CORS configuration for your Pixie Pal app
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
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ========== CACHING SYSTEM ==========
const caches = {
  parkHours: new NodeCache({ stdTTL: 3600, checkperiod: 600 }), // 1 hour
  entertainment: new NodeCache({ stdTTL: 1800, checkperiod: 300 }), // 30 min  
  waitTimes: new NodeCache({ stdTTL: 300, checkperiod: 60 }) // 5 min
};

// ========== RATE LIMITING ==========
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Generous limit for your app
  message: { 
    error: 'Too many requests, please try again later',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', limiter);

// ========== API ENDPOINTS ==========

// 🏠 Welcome endpoint
app.get('/', (req, res) => {
  res.json({
    message: '🏰 Disney Data Proxy Server',
    version: '1.0.0',
    status: 'active',
    endpoints: [
      'GET /api/disney/park-hours/:park',
      'GET /api/disney/entertainment/:park', 
      'GET /api/disney/parade-times/:park',
      'GET /api/disney/wait-times/:park',
      'GET /health'
    ],
    usage: 'This proxy solves CORS issues for Disney park data'
  });
});

// 🕐 Park Hours Endpoint
app.get('/api/disney/park-hours/:park?', async (req, res) => {
  const park = req.params.park || 'magic-kingdom';
  const cacheKey = `hours_${park}`;
  
  try {
    // Check cache first
    const cached = caches.parkHours.get(cacheKey);
    if (cached) {
      console.log(`💾 Cache hit: park hours for ${park}`);
      return res.json({ ...cached, fromCache: true });
    }
    
    console.log(`🕐 Fetching fresh park hours for ${park}`);
    
    // Try multiple sources for park hours
    const hoursData = await fetchParkHours(park);
    
    if (hoursData) {
      caches.parkHours.set(cacheKey, hoursData);
      res.json({ ...hoursData, fromCache: false });
    } else {
      const fallback = getFallbackHours(park);
      res.json({ ...fallback, source: 'fallback' });
    }
    
  } catch (error) {
    console.error(`❌ Park hours error for ${park}:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch park hours',
      fallback: getFallbackHours(park)
    });
  }
});

// 🎭 Entertainment Endpoint
app.get('/api/disney/entertainment/:park?', async (req, res) => {
  const park = req.params.park || 'magic-kingdom';
  const cacheKey = `entertainment_${park}`;
  
  try {
    const cached = caches.entertainment.get(cacheKey);
    if (cached) {
      console.log(`💾 Cache hit: entertainment for ${park}`);
      return res.json({ ...cached, fromCache: true });
    }
    
    console.log(`🎭 Fetching fresh entertainment data for ${park}`);
    
    const entertainmentData = await fetchEntertainmentData(park);
    
    if (entertainmentData) {
      caches.entertainment.set(cacheKey, entertainmentData);
      res.json({ ...entertainmentData, fromCache: false });
    } else {
      const fallback = getFallbackEntertainment(park);
      res.json({ ...fallback, source: 'fallback' });
    }
    
  } catch (error) {
    console.error(`❌ Entertainment error for ${park}:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch entertainment data',
      fallback: getFallbackEntertainment(park)
    });
  }
});

// 🎪 Parade Times Endpoint (Specialized)
app.get('/api/disney/parade-times/:park?', async (req, res) => {
  const park = req.params.park || 'magic-kingdom';
  const cacheKey = `parades_${park}`;
  
  try {
    const cached = caches.entertainment.get(cacheKey);
    if (cached) {
      return res.json({ ...cached, fromCache: true });
    }
    
    console.log(`🎪 Fetching parade data for ${park}`);
    
    const paradeData = await fetchParadeData(park);
    
    if (paradeData) {
      caches.entertainment.set(cacheKey, paradeData);
      res.json({ ...paradeData, fromCache: false });
    } else {
      const fallback = getFallbackParades(park);
      res.json({ ...fallback, source: 'fallback' });
    }
    
  } catch (error) {
    console.error(`❌ Parade data error:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch parade data',
      fallback: getFallbackParades(park)
    });
  }
});

// 🎢 Wait Times Endpoint - FIXED AND PROPERLY PLACED
app.get('/api/disney/wait-times/:park?', async (req, res) => {
  const park = req.params.park || 'magic-kingdom';
  const cacheKey = `wait_times_${park}`;
  
  try {
    // Check cache first
    const cached = caches.waitTimes.get(cacheKey);
    if (cached) {
      console.log(`💾 Cache hit: wait times for ${park}`);
      return res.json({ ...cached, fromCache: true });
    }
    
    console.log(`🎢 Fetching fresh wait times for ${park}`);
    
    const waitTimesData = await fetchWaitTimes(park);
    
    if (waitTimesData) {
      caches.waitTimes.set(cacheKey, waitTimesData);
      res.json({ ...waitTimesData, fromCache: false });
    } else {
      const fallback = getFallbackWaitTimes(park);
      res.json({ ...fallback, source: 'fallback' });
    }
    
  } catch (error) {
    console.error(`❌ Wait times error for ${park}:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch wait times',
      fallback: getFallbackWaitTimes(park)
    });
  }
});

// ========== DATA FETCHING FUNCTIONS ==========

async function fetchParkHours(park) {
  const sources = [
    `https://touringplans.com/${park}/hours.json`,
    `https://queue-times.com/parks/${getParkId(park)}/calendar.json`,
    `https://api.themeparks.wiki/v1/entity/WaltDisneyWorld${capitalize(park)}/schedule`
  ];
  
  for (const source of sources) {
    try {
      console.log(`📡 Trying park hours source: ${source}`);
      
      const response = await axios.get(source, {
        headers: {
          'User-Agent': 'PixiePal Disney Companion App/1.0 (+https://pixiepal.app)',
          'Accept': 'application/json'
        },
        timeout: 10000
      });
      
      if (response.data) {
        console.log(`✅ Got park hours from: ${getSourceName(source)}`);
        return {
          park,
          hours: parseHoursData(response.data, park),
          source: getSourceName(source),
          lastUpdated: new Date().toISOString()
        };
      }
    } catch (error) {
      console.log(`❌ Failed source: ${source} - ${error.message}`);
      continue;
    }
  }
  
  return null;
}

async function fetchEntertainmentData(park) {
  const sources = [
    `https://touringplans.com/${park}/attractions.json`,
    `https://touringplans.com/${park}/entertainment.json`,
    `https://api.themeparks.wiki/v1/entity/WaltDisneyWorld${capitalize(park)}/showtimes`
  ];
  
  for (const source of sources) {
    try {
      console.log(`📡 Trying entertainment source: ${source}`);
      
      const response = await axios.get(source, {
        headers: {
          'User-Agent': 'PixiePal Disney Companion App/1.0 (+https://pixiepal.app)',
          'Accept': 'application/json'
        },
        timeout: 10000
      });
      
      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        console.log(`✅ Got entertainment from: ${getSourceName(source)}`);
        return {
          park,
          entertainment: parseEntertainmentData(response.data),
          source: getSourceName(source),
          lastUpdated: new Date().toISOString()
        };
      }
    } catch (error) {
      console.log(`❌ Failed source: ${source} - ${error.message}`);
      continue;
    }
  }
  
  return null;
}

async function fetchParadeData(park) {
  const sources = [
    `https://touringplans.com/${park}/shows.json`,
    `https://touringplans.com/${park}/entertainment.json`
  ];
  
  for (const source of sources) {
    try {
      const response = await axios.get(source, {
        headers: {
          'User-Agent': 'PixiePal Disney Companion App/1.0',
          'Accept': 'application/json'
        },
        timeout: 8000
      });
      
      if (response.data) {
        const parades = parseParadeData(response.data);
        if (parades.length > 0) {
          return {
            park,
            parades,
            source: getSourceName(source),
            lastUpdated: new Date().toISOString()
          };
        }
      }
    } catch (error) {
      continue;
    }
  }
  
  return null;
}

// FIXED: Wait times fetching function
async function fetchWaitTimes(park) {
  const sources = [
    `https://queue-times.com/parks/${getParkId(park)}/queue_times.json`,
    `https://touringplans.com/${park}/wait-times.json`
  ];
  
  for (const source of sources) {
    try {
      console.log(`📡 Trying wait times source: ${source}`);
      
      const response = await axios.get(source, {
        headers: {
          'User-Agent': 'PixiePal Disney Companion App/1.0 (+https://pixiepal.app)',
          'Accept': 'application/json'
        },
        timeout: 10000
      });
      
      if (response.data) {
        console.log(`✅ Got wait times from: ${getSourceName(source)}`);
        return {
          park,
          attractions: parseWaitTimesData(response.data, park),
          source: getSourceName(source),
          lastUpdated: new Date().toISOString()
        };
      }
    } catch (error) {
      console.log(`❌ Failed source: ${source} - ${error.message}`);
      continue;
    }
  }
  
  return null;
}

// ========== PARSING FUNCTIONS ==========

function parseHoursData(data, park) {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  
  // Try to parse different API formats
  if (data.operating_hours) {
    return [
      {
        date: today.toISOString().split('T')[0],
        openingTime: data.operating_hours.open || '9:00 AM',
        closingTime: data.operating_hours.close || '10:00 PM',
        type: 'Operating',
        specialEvents: data.special_events
      }
    ];
  }
  
  // Default format
  return [
    {
      date: today.toISOString().split('T')[0],
      openingTime: '9:00 AM',
      closingTime: '10:00 PM',
      type: 'Operating'
    },
    {
      date: tomorrow.toISOString().split('T')[0],
      openingTime: '9:00 AM',
      closingTime: '10:00 PM',
      type: 'Operating'
    }
  ];
}

function parseEntertainmentData(data) {
  const entertainment = [];
  
  if (Array.isArray(data)) {
    data.forEach(item => {
      if (item.category && (
        item.category.toLowerCase().includes('show') || 
        item.category.toLowerCase().includes('parade') || 
        item.category.toLowerCase().includes('fireworks') ||
        item.category.toLowerCase().includes('entertainment')
      )) {
        entertainment.push({
          id: item.id || item.name.replace(/[^a-z0-9]/gi, '_'),
          name: item.name,
          type: classifyEntertainment(item.name),
          times: item.showtimes || item.times || ['Check Disney app'],
          location: item.location || item.area || 'Various locations',
          duration: item.duration
        });
      }
    });
  }
  
  return entertainment;
}

function parseParadeData(data) {
  const parades = [];
  
  if (Array.isArray(data)) {
    data.forEach(item => {
      if (item.category && item.category.toLowerCase().includes('parade')) {
        parades.push({
          id: item.id || item.name.replace(/[^a-z0-9]/gi, '_'),
          name: item.name,
          times: item.showtimes || item.times || ['Check Disney app'],
          location: item.location || 'Main Street USA',
          duration: item.duration || 20
        });
      }
    });
  }
  
  return parades;
}

// FIXED: Wait times parsing function
function parseWaitTimesData(data, park) {
  const attractions = [];
  
  // Queue-Times format
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
            fastPassAvailable: ride.fast_pass || false,
            lastUpdated: ride.last_updated || new Date().toISOString()
          });
        });
      }
    });
  }
  
  return attractions;
}

// ========== HELPER FUNCTIONS ==========

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

function capitalize(str) {
  return str.replace(/-/g, '').charAt(0).toUpperCase() + str.replace(/-/g, '').slice(1);
}

function classifyEntertainment(name) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('parade')) return 'parade';
  if (lowerName.includes('fireworks') || lowerName.includes('spectacular')) return 'fireworks';
  if (lowerName.includes('meet') || lowerName.includes('character')) return 'character';
  return 'show';
}

// ========== FALLBACK DATA ==========

function getFallbackHours(park) {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  const parkHours = {
    'magic-kingdom': { open: '9:00 AM', close: '10:00 PM' },
    'epcot': { open: '9:00 AM', close: '9:00 PM' },
    'hollywood-studios': { open: '9:00 AM', close: '9:00 PM' },
    'animal-kingdom': { open: '8:00 AM', close: '8:00 PM' }
  };
  
  const hours = parkHours[park] || parkHours['magic-kingdom'];
  
  return {
    park,
    hours: [
      {
        date: today,
        openingTime: hours.open,
        closingTime: hours.close,
        type: 'Operating'
      },
      {
        date: tomorrow,
        openingTime: hours.open,
        closingTime: hours.close,
        type: 'Operating'
      }
    ],
    source: 'fallback',
    lastUpdated: new Date().toISOString()
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
        duration: 20
      },
      {
        id: 'happily_ever_after',
        name: 'Happily Ever After',
        type: 'fireworks',
        times: ['9:00 PM'],
        location: 'Cinderella Castle',
        duration: 18
      },
      {
        id: 'country_bear_jamboree',
        name: 'Country Bear Jamboree',
        type: 'show',
        times: ['Multiple times daily'],
        location: 'Frontierland',
        duration: 15
      }
    ],
    'epcot': [
      {
        id: 'epcot_forever',
        name: 'EPCOT Forever',
        type: 'fireworks',
        times: ['9:00 PM'],
        location: 'World Showcase Lagoon',
        duration: 12
      }
    ],
    'hollywood-studios': [
      {
        id: 'fantasmic',
        name: 'Fantasmic!',
        type: 'show',
        times: ['8:00 PM', '9:30 PM'],
        location: 'Hollywood Hills Amphitheater',
        duration: 30
      }
    ],
    'animal-kingdom': [
      {
        id: 'festival_lion_king',
        name: 'Festival of the Lion King',
        type: 'show',
        times: ['Multiple times daily'],
        location: 'Africa - Harambe Theatre',
        duration: 30
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

function getFallbackParades(park) {
  const parades = {
    'magic-kingdom': [
      {
        id: 'festival_of_fantasy',
        name: 'Festival of Fantasy Parade',
        times: ['3:00 PM'],
        location: 'Frontierland → Main Street USA',
        duration: 20
      }
    ]
  };
  
  return {
    park,
    parades: parades[park] || [],
    source: 'fallback',
    lastUpdated: new Date().toISOString()
  };
}

// FIXED: Wait times fallback function
function getFallbackWaitTimes(park) {
  const fallbacks = {
    'magic-kingdom': [
      { id: 'mk-space-mountain', name: 'Space Mountain', land: 'Tomorrowland', waitTime: 45, isOpen: true, fastPassAvailable: true },
      { id: 'mk-pirates', name: 'Pirates of the Caribbean', land: 'Adventureland', waitTime: 25, isOpen: true, fastPassAvailable: false },
      { id: 'mk-haunted-mansion', name: 'Haunted Mansion', land: 'Liberty Square', waitTime: 30, isOpen: true, fastPassAvailable: true }
    ],
    'epcot': [
      { id: 'ep-guardians', name: 'Guardians of the Galaxy: Cosmic Rewind', land: 'Future World', waitTime: 85, isOpen: true, fastPassAvailable: true },
      { id: 'ep-test-track', name: 'Test Track', land: 'Future World', waitTime: 55, isOpen: true, fastPassAvailable: true }
    ],
    'hollywood-studios': [
      { id: 'hs-rise', name: 'Star Wars: Rise of the Resistance', land: 'Star Wars: Galaxy\'s Edge', waitTime: 120, isOpen: true, fastPassAvailable: true }
    ],
    'animal-kingdom': [
      { id: 'ak-avatar', name: 'Avatar Flight of Passage', land: 'Pandora', waitTime: 90, isOpen: true, fastPassAvailable: true }
    ]
  };
  
  return {
    park,
    attractions: fallbacks[park] || fallbacks['magic-kingdom'],
    source: 'fallback',
    lastUpdated: new Date().toISOString()
  };
}

// ========== MONITORING ENDPOINTS ==========

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cacheStats: {
      parkHours: caches.parkHours.getStats(),
      entertainment: caches.entertainment.getStats(),
      waitTimes: caches.waitTimes.getStats()
    }
  });
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
    timestamp: new Date().toISOString()
  });
});

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🏰 Disney Data Proxy Server running on port ${PORT}`);
  console.log(`📊 Cache system initialized`);
  console.log(`🛡️ Rate limiting enabled`);
  console.log(`🌐 CORS configured for mobile apps`);
  console.log(`📡 Endpoints ready:`);
  console.log(`   GET /api/disney/park-hours/:park`);
  console.log(`   GET /api/disney/entertainment/:park`);
  console.log(`   GET /api/disney/parade-times/:park`);
  console.log(`   GET /api/disney/wait-times/:park`);
  console.log(`   GET /health`);
});