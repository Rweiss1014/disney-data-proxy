# 🏰 Disney Data Proxy Server

A production-ready proxy server that solves CORS issues and provides reliable Disney World park data for mobile apps.

## 🎯 Purpose

This proxy server enables mobile apps (like Pixie Pal) to access Disney park data by:
- Solving CORS (Cross-Origin Resource Sharing) restrictions
- Providing cached, reliable data with smart fallbacks
- Rate limiting to prevent API abuse
- Normalizing data from multiple sources

## 📡 API Endpoints

### Park Hours
```
GET /api/disney/park-hours/:park
```
Returns current and next day operating hours for the specified park.

**Parks:** `magic-kingdom`, `epcot`, `hollywood-studios`, `animal-kingdom`

**Example Response:**
```json
{
  "park": "magic-kingdom",
  "hours": [
    {
      "date": "2025-07-20",
      "openingTime": "9:00 AM",
      "closingTime": "10:00 PM",
      "type": "Operating"
    }
  ],
  "source": "touringplans",
  "lastUpdated": "2025-07-20T15:30:00.000Z",
  "fromCache": false
}
```

### Entertainment & Shows
```
GET /api/disney/entertainment/:park
```
Returns parades, fireworks, shows, and character meet schedules.

**Example Response:**
```json
{
  "park": "magic-kingdom",
  "entertainment": [
    {
      "id": "festival_of_fantasy",
      "name": "Festival of Fantasy Parade",
      "type": "parade",
      "times": ["3:00 PM"],
      "location": "Frontierland → Main Street USA",
      "duration": 20
    }
  ],
  "source": "touringplans",
  "lastUpdated": "2025-07-20T15:30:00.000Z"
}
```

### Parade Times (Specialized)
```
GET /api/disney/parade-times/:park
```
Returns only parade-specific information.

### Health Check
```
GET /health
```
Server status, uptime, and cache statistics.

## 🚀 Data Sources

The proxy attempts to fetch data from multiple sources in order:

1. **TouringPlans.com** - Primary source for entertainment and hours
2. **Queue-Times.com** - Secondary source for park schedules  
3. **ThemeParks.wiki** - Backup API source
4. **Smart Fallbacks** - Curated data when all APIs fail

## 📊 Caching Strategy

- **Park Hours**: 1 hour cache (changes infrequently)
- **Entertainment**: 30 minute cache (shows can change)
- **Wait Times**: 5 minute cache (updates frequently)

## 🛡️ Rate Limiting

- **General API**: 200 requests per 15 minutes per IP
- **Graceful handling**: Returns cached data when limits exceeded

## 🔧 Local Development

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start development server:
   ```bash
   npm run dev
   ```
4. Server runs on `http://localhost:3000`

## 🌐 Production Deployment

This server is designed for deployment on:
- **Render** (recommended - free tier available)
- **Railway** 
- **Fly.io**
- **Vercel** (serverless functions)

### Environment Variables
No environment variables required - works out of the box!

## 📱 Mobile App Integration

In your React Native/Expo app, replace direct Disney API calls with:

```javascript
// Instead of: fetch('https://touringplans.com/magic-kingdom/hours.json')
// Use: 
const response = await fetch('https://your-proxy.onrender.com/api/disney/park-hours/magic-kingdom');
```

## 🏰 Supported Parks

- `magic-kingdom` - Magic Kingdom
- `epcot` - EPCOT
- `hollywood-studios` - Disney's Hollywood Studios  
- `animal-kingdom` - Disney's Animal Kingdom

## 📝 Usage Notes

- Always include park parameter in URL path
- Check `fromCache` property to see if data is cached
- Fall back gracefully if proxy is unavailable
- Respect rate limits to ensure service availability

## 🤝 Legal & Ethics

- Uses publicly available Disney park information
- Respects source APIs with caching and rate limiting
- Provides attribution to data sources
- Not affiliated with The Walt Disney Company

## 📊 Monitoring

- Health endpoint: `/health`
- Cache statistics: `/api/cache/status`
- Structured logging for debugging

## 🆘 Support

This proxy is designed to be reliable and self-healing:
- Automatic failover between data sources
- Smart caching prevents single points of failure
- Comprehensive error handling with fallback data

Built for the Pixie Pal Disney companion app 🧚‍♀️✨