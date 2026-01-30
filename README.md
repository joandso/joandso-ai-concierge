# JO&SO AI Concierge

Interactive landing page with 3D Portugal map and AI chatbot powered by your Webflow CMS.

## Quick Deploy with Railway

### 1. Push to GitHub

```bash
# Create new repo on GitHub called "joandso-ai-concierge"
# Then in this directory:
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/joandso/joandso-ai-concierge.git
git push -u origin main
```

### 2. Deploy to Railway

1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select `joandso/joandso-ai-concierge`
4. Railway will auto-detect Node.js and deploy

### 3. Add Environment Variables

In Railway dashboard → your project → Variables tab, add:

```
WEBFLOW_API_TOKEN=7aefdc1d14e72e332990e39d349952ba5671a35f3234105cb2fa1c56e0f351bc
WEBFLOW_SITE_ID=6005cd6988e875868452d33d
ANTHROPIC_API_KEY=your-anthropic-api-key
MAPBOX_TOKEN=pk.eyJ1Ijoiam9hbmRzbyIsImEiOiJjbTQ2ajd2dnMwb3V1MnBzZHprOGhxa3RsIn0.TkP7RCn5ggzz2aO1LPZM0g
```

### 4. Get Your URL

Railway will give you a URL like `joandso-ai-concierge-production.up.railway.app`

You can add a custom domain in Settings → Domains.

---

## Local Development

```bash
npm install
npm start
# Opens at http://localhost:3000
```

Create a `.env` file with your tokens (don't commit this):

```
WEBFLOW_API_TOKEN=your-token
WEBFLOW_SITE_ID=6005cd6988e875868452d33d
ANTHROPIC_API_KEY=your-key
MAPBOX_TOKEN=your-mapbox-token
```

---

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/config` - Get public config (mapbox token, status)
- `GET /api/cms/stats` - CMS cache statistics
- `POST /api/cms/refresh` - Force refresh CMS cache
- `POST /api/chat` - Send chat message
- `GET /api/hotels/markers` - Get hotel markers for map

---

## How It Works

1. Server fetches hotel data from Webflow CMS on startup
2. Data is cached for 30 minutes
3. When user sends a message, the server:
   - Builds a system prompt with your hotel data
   - Sends to Claude API
   - Returns the response
4. Map shows clickable region markers
5. Clicking a region auto-fills a question about that area

---

## Files

```
joandso-ai-concierge/
├── server.js          # Express server with API routes
├── package.json       # Dependencies
├── public/
│   └── index.html     # Frontend with map and chat
└── README.md          # This file
```
