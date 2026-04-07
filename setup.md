# Setup & Deployment

## ⚡️ One-Command Startup (RECOMMENDED)

You only need **one terminal** to start everything at once:

```bash
# In the project root (/yt_transcript)
npm run app
```
*This starts Redis, the Frontend, the Backend API, AND the Worker.*

---

## 🛠 Option 1: Local Development (Manual)

## 🚀 Option 2: Production Scaling (Using PM2)

Use this to run the API on all CPU cores with auto-restart!

```bash
# 1. Install PM2 (if not already installed)
npm install -g pm2

# 2. Start both API and Worker
pm2 start ecosystem.config.cjs

# 3. Check status
pm2 status

# 4. View logs (highly recommended)
pm2 logs
```

## 🔑 AI Capacity Hack
Update your `.env` with multiple Groq keys (comma-separated):
`GROQ_API_KEYS="key1,key2,key3"`
